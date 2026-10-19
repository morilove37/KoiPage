//! Share only rendered PNGs. Never upload database records or cover paths.
use std::path::Path;
use tauri::AppHandle;
use super::error::{CmdError, CmdResult};

const MAX_PNG_BYTES: usize = 24 * 1024 * 1024;
const MAX_COVER_BYTES: usize = 20 * 1024 * 1024;
const SHARE_HOST: &str = "https://beacon.host";

fn validate_png(bytes: &[u8]) -> CmdResult<()> {
    if bytes.len() < 45 || bytes.len() > MAX_PNG_BYTES
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR"
        || !bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82") {
        return Err(CmdError("分享图片无效或超过 24 MB，请减少每张图片的内容。".into()));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > 6000 || height > 16000 || u64::from(width) * u64::from(height) > 30_000_000 {
        return Err(CmdError("分享图片尺寸无效，请重新生成。".into()));
    }
    tauri::image::Image::from_bytes(bytes).map_err(|_| CmdError("分享图片已损坏，请重新生成。".into()))?;
    Ok(())
}

fn upload_url(text: &str) -> CmdResult<String> {
    let url = reqwest::Url::parse(text.trim()).map_err(|_| CmdError("托管服务未返回有效链接，请稍后重试。".into()))?;
    let host = url.host_str().unwrap_or_default();
    let slug = host.strip_suffix(".beacon.host").unwrap_or_default();
    if url.scheme() != "https" || slug.is_empty() || !slug.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err(CmdError("托管服务返回了异常链接，已停止分享。".into()));
    }
    Ok(url.to_string())
}

fn storage_url(text: &str) -> CmdResult<reqwest::Url> {
    let url = reqwest::Url::parse(text).map_err(|_| CmdError("图片上传地址无效".into()))?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|host| host.ends_with(".r2.cloudflarestorage.com"))
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err(CmdError("图片上传地址异常，已停止分享。".into()));
    }
    Ok(url)
}

async fn checked(response: Result<reqwest::Response, reqwest::Error>) -> CmdResult<reqwest::Response> {
    let response = response.map_err(|_| CmdError("无法连接临时托管服务，请检查网络后重试；仍可保存或复制图片。".into()))?;
    if response.status().as_u16() == 429 {
        return Err(CmdError("临时托管的发布次数已达上限，请稍后重试；图片仍可保存或复制。".into()));
    }
    if !response.status().is_success() {
        return Err(CmdError(format!("临时托管服务返回 HTTP {}，请稍后重试。", response.status().as_u16())));
    }
    Ok(response)
}

/// Read only the cover recorded for this game, so canvas export also works for
/// local files and remote hosts without browser CORS support.
#[tauri::command]
pub async fn share_cover_read(app: AppHandle, game_id: i64) -> CmdResult<tauri::ipc::Response> {
    let db = super::games::pool(&app).await?;
    let path: Option<String> = sqlx::query_scalar("SELECT cover_path FROM games WHERE id = ?")
        .bind(game_id).fetch_optional(&db).await?.flatten();
    let path = super::covers::custom_path(&db, game_id).await?.or(path);
    let path = path.filter(|value| !value.trim().is_empty()).ok_or_else(|| CmdError("未找到游戏封面".into()))?;
    let bytes = if path.starts_with("https://") || path.starts_with("http://") {
        crate::metadata::download_cover(&path).await?
    } else {
        tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<u8>> {
            use std::io::Read;
            let file = std::fs::File::open(&path).map_err(|_| CmdError("封面文件不存在或不可读".into()))?;
            let mut bytes = Vec::new();
            file.take((MAX_COVER_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|_| CmdError("封面读取失败".into()))?;
            if bytes.len() > MAX_COVER_BYTES { return Err(CmdError("封面超过 20 MB".into())); }
            Ok(bytes)
        }).await.map_err(|error| CmdError(error.to_string()))??
    };
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn share_image_save(path: String, png: Vec<u8>) -> CmdResult<()> {
    validate_png(&png)?;
    let target = Path::new(&path);
    if !target.is_absolute() || !target.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("png")) {
        return Err(CmdError("请选择 PNG 图片的绝对保存路径。".into()));
    }
    tauri::async_runtime::spawn_blocking(move || std::fs::write(path, png))
        .await.map_err(|error| CmdError(error.to_string()))?
        .map_err(|error| CmdError(format!("保存分享图失败：{error}")))
}

/// Publish one gallery containing the already-rendered PNGs. Anonymous sites
/// expire after 24 hours; there is no embedded account, API key or user data.
#[tauri::command]
pub async fn share_images_upload(pages: Vec<Vec<u8>>) -> CmdResult<String> {
    use sha2::{Digest, Sha256};
    use serde::Deserialize;
    if pages.is_empty() || pages.len() > 100 || pages.iter().map(Vec::len).sum::<usize>() > 256 * 1024 * 1024 {
        return Err(CmdError("分享内容为空或过大，请减少展示的作品。".into()));
    }
    for page in &pages { validate_png(page)?; }
    let images = (0..pages.len()).map(|index| format!(r#"<img src="koipage-share-{}.png" alt="第 {} 张游玩足迹" loading="lazy">"#, index + 1, index + 1)).collect::<String>();
    let html = format!(r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>我的 Galgame 足迹 · 恋页</title><style>body{{margin:0;padding:24px 12px;background:#111018;color:#eee6f5;font:14px system-ui,sans-serif}}main{{max-width:1100px;margin:auto}}h1{{font-size:22px}}p{{color:#b8a9c8}}img{{display:block;width:100%;height:auto;margin:20px 0;border-radius:14px}}</style><main><h1>我的 Galgame 足迹</h1><p>来自恋页 KoiPage · 临时分享，发布后 24 小时失效</p>{images}</main></html>"#);
    let mut files: Vec<(String, Vec<u8>, &str)> = vec![("index.html".into(), html.into_bytes(), "text/html; charset=utf-8")];
    for (index, png) in pages.into_iter().enumerate() { files.push((format!("koipage-share-{}.png", index + 1), png, "image/png")); }
    let manifest: Vec<_> = files.iter().map(|(path, data, mime)| serde_json::json!({
        "path": path, "size": data.len(), "contentType": mime, "hash": format!("sha256:{:x}", Sha256::digest(data))
    })).collect();
    let client = reqwest::Client::builder().user_agent(crate::metadata::USER_AGENT)
        .redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(90))
        .build().map_err(|error| CmdError(error.to_string()))?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Site { url: String, slug: String, expires_at: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pending { path: String, upload_url: String, upload_method: String }
    #[derive(Deserialize)]
    struct Uploads { pending: Vec<Pending> }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Version { finalize_url: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Created { site: Site, uploads: Uploads, version: Version, claim_token: String }
    let created: Created = checked(client.post(format!("{SHARE_HOST}/v1/sites"))
        .header("X-Beacon-Client", concat!("KoiPage/", env!("CARGO_PKG_VERSION")))
        .json(&serde_json::json!({"files": manifest})).send().await).await?
        .json().await.map_err(|_| CmdError("无法读取临时分享信息。".into()))?;
    let public_url = upload_url(&created.site.url)?;
    if reqwest::Url::parse(&public_url).ok().and_then(|url| url.host_str().map(str::to_owned)) != Some(format!("{}.beacon.host", created.site.slug)) {
        return Err(CmdError("临时分享域名不一致，已停止。".into()));
    }
    let expires = time::OffsetDateTime::parse(&created.site.expires_at, &time::format_description::well_known::Rfc3339)
        .map_err(|_| CmdError("无法确认分享链接的有效期。".into()))?;
    let lifetime = (expires - time::OffsetDateTime::now_utc()).whole_seconds();
    if !(23 * 3600..=25 * 3600).contains(&lifetime) { return Err(CmdError("分享链接有效期异常，未发布。".into())); }
    for pending in created.uploads.pending {
        let (_, data, mime) = files.iter().find(|(path, _, _)| *path == pending.path)
            .ok_or_else(|| CmdError("托管服务请求了未知文件，已停止。".into()))?;
        if !pending.upload_method.eq_ignore_ascii_case("PUT") { return Err(CmdError("托管服务的上传方式异常。".into())); }
        // The claim token is never forwarded to the storage server.
        checked(client.put(storage_url(&pending.upload_url)?).header("Content-Type", *mime).body(data.clone()).send().await).await?;
    }
    let finalize = created.version.finalize_url;
    if !finalize.starts_with(&format!("/v1/sites/{}/versions/", created.site.slug)) || !finalize.ends_with("/finalize")
        || finalize.contains("..") || finalize.contains('?') || finalize.contains('#') {
        return Err(CmdError("发布地址异常，已停止分享。".into()));
    }
    checked(client.post(format!("{SHARE_HOST}{finalize}"))
        .header("X-Beacon-Client", concat!("KoiPage/", env!("CARGO_PKG_VERSION")))
        .header("X-Claim-Token", created.claim_token).send().await).await?;
    Ok(public_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0; 45];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes[33..].copy_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
        bytes
    }
    #[test]
    fn rejects_bad_or_oversized_share_images() {
        assert!(validate_png(&[]).is_err());
        assert!(validate_png(b"<html>not an image</html>").is_err());
        assert!(validate_png(include_bytes!("../../icons/32x32.png")).is_ok());
        assert!(validate_png(&png_header(1320, 4000)).is_err());
        assert!(validate_png(&png_header(0, 4000)).is_err());
        assert!(validate_png(&png_header(6000, 16000)).is_err());
        assert!(validate_png(&png_header(1320, 4000)[..30]).is_err());
    }
    #[test]
    fn accepts_only_expected_public_image_urls() {
        assert_eq!(upload_url(" https://test-gallery-42.beacon.host\n").unwrap(), "https://test-gallery-42.beacon.host/");
        for url in ["https://evil.test/", "javascript:alert(1)", "https://test.beacon.host.evil.test/", "https://beacon.host/", "https://a@test.beacon.host/", "https://nested.test.beacon.host/"] {
            assert!(upload_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn storage_uploads_are_limited_to_the_presigned_storage_host() {
        assert!(storage_url("https://bucket.r2.cloudflarestorage.com/a.png?signature=test").is_ok());
        for url in ["https://r2.cloudflarestorage.com.evil.test/a", "http://bucket.r2.cloudflarestorage.com/a", "https://evil.test/a", "https://user@bucket.r2.cloudflarestorage.com/a"] {
            assert!(storage_url(url).is_err(), "{url}");
        }
    }
}
