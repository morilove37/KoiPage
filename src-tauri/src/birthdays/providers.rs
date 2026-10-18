use super::model::*;
use crate::commands::error::{CmdError, CmdResult};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn date(month: Option<i64>, day: Option<i64>) -> (Option<i64>, Option<i64>) {
    if valid_date(month, day) {
        (month, day)
    } else {
        (None, None)
    }
}

pub fn parse_vndb(value: &Value, game: &str) -> CmdResult<Vec<SourceCharacter>> {
    let rows = value["results"]
        .as_array()
        .ok_or_else(|| CmdError("VNDB 返回的角色列表格式无效".into()))?;
    let mut out = vec![];
    for row in rows {
        let association = row["vns"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["id"].as_str() == Some(game) && v["spoiler"].as_i64() == Some(0))
            .filter(|v| matches!(v["role"].as_str(), Some("main" | "primary")))
            .min_by_key(|v| if v["role"] == "main" { 0 } else { 1 });
        let Some(link) = association else { continue };
        let id = text(&row["id"]).ok_or_else(|| CmdError("VNDB 角色缺少 ID".into()))?;
        validate_identity("vndb", &id)?;
        let original = text(&row["original"]);
        let name = original
            .clone()
            .or_else(|| text(&row["name"]))
            .ok_or_else(|| CmdError("VNDB 角色缺少名称".into()))?;
        let (month, day) = date(row["birthday"][0].as_i64(), row["birthday"][1].as_i64());
        out.push(SourceCharacter {
            external_id: id,
            name,
            original_name: original,
            month,
            day,
            raw: (!row["birthday"].is_null()).then(|| row["birthday"].to_string()),
            avatar: text(&row["image"]["url"]),
            role: link["role"].as_str().unwrap().into(),
            spoiler: 0,
        });
    }
    Ok(out)
}

fn parse_birthday(raw: &str) -> (Option<i64>, Option<i64>) {
    let s = raw.trim();
    let parsed = if let Some((before, after)) = s.split_once('月') {
        after.strip_suffix('日').and_then(|d| {
            let m = before.rsplit('年').next()?;
            Some((m.parse::<i64>().ok()?, d.parse::<i64>().ok()?))
        })
    } else {
        let pieces: Vec<_> = s.split('-').collect();
        if pieces.len() == 2 || pieces.len() == 3 {
            let offset = pieces.len() - 2;
            pieces[offset]
                .parse::<i64>()
                .ok()
                .zip(pieces[offset + 1].parse::<i64>().ok())
        } else {
            None
        }
    };
    parsed
        .map(|(m, d)| date(Some(m), Some(d)))
        .unwrap_or((None, None))
}

pub fn parse_bangumi(row: &Value) -> CmdResult<SourceCharacter> {
    let id = row["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| CmdError("Bangumi 角色缺少 ID".into()))?
        .to_string();
    let original = text(&row["name"]).ok_or_else(|| CmdError("Bangumi 角色缺少名称".into()))?;
    let info = |keys: &[&str]| {
        row["infobox"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|v| {
                keys.contains(&v["key"].as_str().unwrap_or(""))
                    .then(|| text(&v["value"]))
                    .flatten()
            })
    };
    let raw = info(&["生日"]);
    let structured = date(row["birth_mon"].as_i64(), row["birth_day"].as_i64());
    let (month, day) = if structured.0.is_some() {
        structured
    } else {
        raw.as_deref().map(parse_birthday).unwrap_or((None, None))
    };
    Ok(SourceCharacter {
        external_id: id,
        name: info(&["简体中文名", "中文名"]).unwrap_or_else(|| original.clone()),
        original_name: Some(original),
        month,
        day,
        raw,
        avatar: text(&row["images"]["medium"]).or_else(|| text(&row["images"]["small"])),
        role: "primary".into(),
        spoiler: 0,
    })
}

/// One serial client per sync, including avatar requests, with cancellation in flight.
pub struct ProviderClient {
    client: reqwest::Client,
    cancel: Arc<AtomicBool>,
    last: Option<Instant>,
}
impl ProviderClient {
    pub fn new(cancel: Arc<AtomicBool>) -> CmdResult<Self> {
        Ok(Self {
            client: crate::metadata::http_client()?,
            cancel,
            last: None,
        })
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn send(&mut self, request: reqwest::RequestBuilder) -> CmdResult<reqwest::Response> {
        if self.is_cancelled() {
            return Err(CmdError("已取消同步".into()));
        }
        if let Some(last) = self.last {
            let delay = Duration::from_millis(1600).saturating_sub(last.elapsed());
            tokio::select! {_=tokio::time::sleep(delay)=>{},_=self.cancelled()=>return Err(CmdError("已取消同步".into()))}
        }
        self.last = Some(Instant::now());
        let response = tokio::select! {
            result=request.send()=>result.map_err(|_|CmdError("无法连接角色资料服务，请检查网络后重试".into()))?,
            _=self.cancelled()=>return Err(CmdError("已取消同步".into())),
        };
        if response.status().as_u16() == 429 {
            return Err(CmdError("角色资料服务限流（HTTP 429），请稍后重试".into()));
        }
        if !response.status().is_success() {
            return Err(CmdError(format!(
                "角色资料服务返回 HTTP {}",
                response.status().as_u16()
            )));
        }
        Ok(response)
    }
    async fn json(&mut self, request: reqwest::RequestBuilder) -> CmdResult<Value> {
        let response = self.send(request).await?;
        // Bound response bodies too, not just image downloads.
        let bytes = self.body(response, 8 * 1024 * 1024).await?;
        serde_json::from_slice(&bytes).map_err(|_| CmdError("角色资料响应格式无效".into()))
    }
    async fn body(&self, mut response: reqwest::Response, max: usize) -> CmdResult<Vec<u8>> {
        let mut bytes = vec![];
        loop {
            let chunk = tokio::select! {result=response.chunk()=>result.map_err(|_|CmdError("角色资料读取失败".into()))?,_=self.cancelled()=>return Err(CmdError("已取消同步".into()))};
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > max {
                return Err(CmdError("角色资料超过大小限制".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn characters(&mut self, work: &SyncWork) -> CmdResult<Vec<SourceCharacter>> {
        if work.source == "vndb" {
            let digits = work.external_id.strip_prefix('v').unwrap_or("");
            if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return Err(CmdError("VNDB 游戏 ID 无效，请重新匹配资料".into()));
            }
            let mut out = vec![];
            for page in 1..=100 {
                let request=self.client.post("https://api.vndb.org/kana/character").json(&json!({"filters":["vn","=",["id","=",work.external_id]],"fields":"name,original,birthday,image.url,vns{id,role,spoiler}","results":100,"page":page}));
                let response = self.json(request).await?;
                out.extend(parse_vndb(&response, &work.external_id)?);
                if response["more"] == false {
                    return Ok(out);
                }
                if response["more"] != true {
                    return Err(CmdError("VNDB 分页标识缺失".into()));
                }
            }
            Err(CmdError("角色列表分页过多，请稍后重试".into()))
        } else {
            if work.external_id.is_empty() || !work.external_id.bytes().all(|c| c.is_ascii_digit())
            {
                return Err(CmdError("Bangumi 游戏 ID 无效，请重新匹配资料".into()));
            }
            let request = self.client.get(format!(
                "https://api.bgm.tv/v0/subjects/{}/characters",
                work.external_id
            ));
            let response = self.json(request).await?;
            let rows = response
                .as_array()
                .ok_or_else(|| CmdError("Bangumi 返回的角色列表格式无效".into()))?;
            let mut seen = BTreeSet::new();
            let mut out = vec![];
            for row in rows {
                if row["relation"] != "主角" {
                    continue;
                }
                let Some(id) = row["id"].as_i64().filter(|id| *id > 0) else {
                    continue;
                };
                if !seen.insert(id) {
                    continue;
                }
                let request = self
                    .client
                    .get(format!("https://api.bgm.tv/v0/characters/{id}"));
                out.push(parse_bangumi(&self.json(request).await?)?);
            }
            Ok(out)
        }
    }
    pub async fn avatar(&mut self, url: &str) -> CmdResult<Vec<u8>> {
        let url = reqwest::Url::parse(url).map_err(|_| CmdError("头像地址无效".into()))?;
        if url.scheme() != "https" {
            return Err(CmdError("头像必须使用 HTTPS".into()));
        }
        let request = self.client.get(url);
        let response = self.send(request).await?;
        self.body(response, super::avatars::MAX_AVATAR).await
    }
}
