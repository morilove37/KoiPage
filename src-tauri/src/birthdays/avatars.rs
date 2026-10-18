use crate::commands::error::{CmdError, CmdResult};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
pub const MAX_AVATAR: usize = 4 * 1024 * 1024;

pub fn validate_image(bytes: &[u8]) -> CmdResult<&'static str> {
    if bytes.len() > MAX_AVATAR {
        return Err(CmdError("角色头像不能超过 4 MB".into()));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| CmdError("头像图片格式无法识别".into()))?;
    let ext = match reader.format() {
        Some(image::ImageFormat::Png) => "png",
        Some(image::ImageFormat::Jpeg) => "jpg",
        Some(image::ImageFormat::WebP) => "webp",
        Some(image::ImageFormat::Gif) => "gif",
        _ => return Err(CmdError("请选择 PNG、JPEG、WebP 或 GIF 图片".into())),
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| {
        CmdError("头像图片损坏或尺寸过大，请选择不超过 4096 × 4096 的有效图片".into())
    })?;
    Ok(ext)
}
pub fn save_image(dir: &Path, bytes: &[u8]) -> CmdResult<String> {
    let ext = validate_image(bytes)?;
    std::fs::create_dir_all(dir).map_err(|_| CmdError("无法创建角色头像缓存目录".into()))?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let path = dir.join(format!("{hash}.{ext}"));
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|_| CmdError("无法保存角色头像".into()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}
pub fn read_image(path: &Path) -> CmdResult<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| CmdError("头像文件不存在或不可读".into()))?;
    let mut bytes = vec![];
    file.take((MAX_AVATAR + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| CmdError("头像文件读取失败".into()))?;
    validate_image(&bytes)?;
    Ok(bytes)
}
pub fn cache_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    use tauri::Manager;
    Ok(app.path().app_data_dir()?.join("birthday-avatars"))
}
