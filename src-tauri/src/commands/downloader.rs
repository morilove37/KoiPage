use reqwest::header::{CONTENT_DISPOSITION, CONTENT_LENGTH, RANGE};
use serde::Serialize;
use std::{fs::OpenOptions, io::{Read, Seek, SeekFrom, Write}, path::PathBuf, sync::{Arc, atomic::{AtomicU64, Ordering}}};
use tauri::Emitter;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: u64,
}

fn filename_from_response(response: &reqwest::blocking::Response, url: &str) -> String {
    if let Some(value) = response.headers().get(CONTENT_DISPOSITION).and_then(|v| v.to_str().ok()) {
        if let Some(name) = value.split("filename=").nth(1) {
            let name = name.trim().trim_matches('"').split(';').next().unwrap_or("");
            if !name.is_empty() { return sanitize_filename(name); }
        }
    }
    let path = reqwest::Url::parse(url).ok().and_then(|u| u.path_segments()?.next_back().map(str::to_owned)).unwrap_or_default();
    sanitize_filename(if path.is_empty() { "download.bin" } else { &path })
}

fn sanitize_filename(value: &str) -> String {
    let name: String = value.chars().map(|c| if c.is_control() || "><:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() { "download.bin".into() } else { name.to_owned() }
}

#[tauri::command]
pub async fn download_file(app: tauri::AppHandle, url: String, destination: String, connections: u8, download_id: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "请输入有效的 HTTP 或 HTTPS 下载网址".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err("仅支持 HTTP 或 HTTPS 下载网址".into()); }
    let destination = PathBuf::from(destination);
    if destination.file_name().is_none() { return Err("请选择包含文件名的保存路径".into()); }
    let connections = connections.clamp(1, 16) as usize;
    tauri::async_runtime::spawn_blocking(move || download_impl(app, parsed.to_string(), destination, connections, download_id))
        .await.map_err(|e| e.to_string())?
}

fn download_impl(app: tauri::AppHandle, url: String, destination: PathBuf, connections: usize, download_id: String) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder().user_agent("KoiPage Downloader/1.0").build().map_err(|e| e.to_string())?;
    let probe = client.head(&url).send().map_err(|e| format!("连接失败：{e}"))?;
    if !probe.status().is_success() { return Err(format!("服务器返回错误：{}", probe.status())); }
    let total = probe.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let filename = filename_from_response(&probe, &url);
    let destination = if destination.is_dir() { destination.join(filename) } else { destination };
    let parent = destination.parent().ok_or("无效的保存路径")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("无法创建保存目录：{e}"))?;
    let range_probe = client.get(&url).header(RANGE, "bytes=0-0").send().map_err(|e| format!("连接失败：{e}"))?;
    let supports_ranges = range_probe.status().as_u16() == 206;
    drop(range_probe);
    if total == 0 || !supports_ranges || connections < 2 {
        let mut response = client.get(&url).send().map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
        let total = response.content_length().unwrap_or(total);
        let mut output = OpenOptions::new().create(true).truncate(true).write(true).open(&destination).map_err(|e| e.to_string())?;
        let mut downloaded = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 { break; }
            output.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            downloaded += count as u64;
            let _ = app.emit("download-progress", DownloadProgress { id: download_id.clone(), downloaded, total });
        }
        return Ok(());
    }
    let file = OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&destination).map_err(|e| e.to_string())?;
    file.set_len(total).map_err(|e| e.to_string())?;
    drop(file);
    let completed = Arc::new(AtomicU64::new(0));
    let chunk_size = total.div_ceil(connections as u64);
    let result = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for index in 0..connections {
            let start = index as u64 * chunk_size;
            if start >= total { break; }
            let end = (start + chunk_size - 1).min(total - 1);
            let client = client.clone(); let path = destination.clone(); let url = url.clone();
            let app = app.clone(); let id = download_id.clone(); let completed = completed.clone();
            handles.push(scope.spawn(move || -> Result<(), String> {
                let mut response = client.get(&url).header(RANGE, format!("bytes={start}-{end}")).send().map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
                if response.status().as_u16() != 206 { return Err("服务器不支持分段下载".into()); }
                let mut file = OpenOptions::new().write(true).open(path).map_err(|e| e.to_string())?;
                file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 { break; }
                    file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
                    let downloaded = completed.fetch_add(count as u64, Ordering::Relaxed) + count as u64;
                    let _ = app.emit("download-progress", DownloadProgress { id: id.clone(), downloaded, total });
                }
                Ok(())
            }));
        }
        for handle in handles { handle.join().map_err(|_| "下载线程异常退出".to_string())??; }
        Ok(())
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&destination);
    }
    result
}
