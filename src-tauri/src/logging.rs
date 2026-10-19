use std::path::{Path, PathBuf};
use std::io::{self, Write};
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 5;
static STORE: OnceLock<Mutex<LogStore>> = OnceLock::new();
static INIT_ERROR: OnceLock<String> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct Entry { time: String, level: String, module: String, message: String }

struct LogStore { directory: PathBuf, max_bytes: u64, max_files: usize }
impl LogStore {
    fn new(directory: &Path, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        std::fs::create_dir_all(directory)?;
        Ok(Self { directory: directory.into(), max_bytes: max_bytes.max(512), max_files: max_files.clamp(1, 5) })
    }
    fn path(&self, index: usize) -> PathBuf {
        self.directory.join(if index == 0 { "koipage.log".into() } else { format!("koipage.{index}.log") })
    }
    fn append(&mut self, level: &str, module: &str, message: &str) -> io::Result<()> {
        let level = match level { "ERROR" => "ERROR", "WARN" => "WARN", _ => "INFO" };
        let mut entry = Entry { time: crate::commands::util::now_iso8601(), level: level.into(),
            module: module.chars().filter(|c| !c.is_control()).take(64).collect(),
            message: redact(message).chars().take(8192).collect() };
        let mut line = serde_json::to_string(&entry)?;
        while line.len() as u64 + 1 > self.max_bytes && !entry.message.is_empty() {
            entry.message.pop();
            line = serde_json::to_string(&entry)?;
        }
        line.push('\n');
        let current = self.path(0);
        let size = std::fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size + line.len() as u64 > self.max_bytes {
            let last = self.path(self.max_files - 1);
            if last.exists() { std::fs::remove_file(&last)?; }
            for index in (1..self.max_files).rev() {
                let source = self.path(index - 1);
                if source.exists() { std::fs::rename(source, self.path(index))?; }
            }
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(current)?;
        file.write_all(line.as_bytes())?;
        file.flush()
    }
    fn export(&self, target: &Path) -> io::Result<()> {
        let resolved = target.canonicalize().unwrap_or_else(|_| target.into());
        if (0..self.max_files).any(|index| {
            let path = self.path(index);
            target == path || resolved == path.canonicalize().unwrap_or(path)
        }) { return Err(io::Error::other("不能覆盖正在记录的日志文件")); }
        let mut output = format!("KoiPage diagnostics\nVersion: {}\nSystem: {} {}\nExported (UTC): {}\nLog timestamps: UTC / RFC3339\n\n",
            env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, crate::commands::util::now_iso8601());
        for index in (0..self.max_files).rev() {
            let path = self.path(index);
            if !path.exists() { continue; }
            output.push_str(&format!("--- {} ---\n", path.file_name().unwrap().to_string_lossy()));
            for line in std::fs::read_to_string(path)?.lines() {
                if let Ok(entry) = serde_json::from_str::<Entry>(line) {
                    output.push_str(&redact(&format!("{} [{}] [{}] {}\n", entry.time, entry.level, entry.module, entry.message)));
                } else { output.push_str(&redact(line)); output.push('\n'); }
            }
            output.push('\n');
        }
        std::fs::write(target, output)
    }
}
pub fn redact(message: &str) -> String {
    static SECRETS: OnceLock<regex::Regex> = OnceLock::new();
    static QUOTED: OnceLock<regex::Regex> = OnceLock::new();
    static AUTH: OnceLock<regex::Regex> = OnceLock::new();
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    static URL_AUTH: OnceLock<regex::Regex> = OnceLock::new();
    let quoted = QUOTED.get_or_init(|| regex::Regex::new(r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"#).unwrap());
    let auth = AUTH.get_or_init(|| regex::Regex::new(r#"(?i)(\bauthorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+"#).unwrap());
    let secrets = SECRETS.get_or_init(|| regex::Regex::new(r#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)["']?\s*[:=]\s*["']?(?:bearer\s+)?)(\[REDACTED\]|[^\s"'&,;}\]]+)"#).unwrap());
    let bearer = BEARER.get_or_init(|| regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
    let url_auth = URL_AUTH.get_or_init(|| regex::Regex::new(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@").unwrap());
    let value = quoted.replace_all(message, "${1}\"[REDACTED]\"");
    let value = auth.replace_all(&value, "${1}[REDACTED]");
    let value = secrets.replace_all(&value, "${1}[REDACTED]");
    let value = bearer.replace_all(&value, "Bearer [REDACTED]");
    url_auth.replace_all(&value, "${1}[REDACTED]@").into_owned()
}

fn directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("KoiPage").join("logs")
}

pub fn init() {
    match LogStore::new(&directory(), MAX_BYTES, MAX_FILES) {
        Ok(store) => { let _ = STORE.set(Mutex::new(store)); }
        Err(error) => { let _ = INIT_ERROR.set(error.to_string()); }
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { record("ERROR", "panic", &info.to_string()); previous(info); }));
    record("INFO", "app", &format!("应用启动 version={} os={} arch={} pid={}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, std::process::id()));
}

pub fn record(level: &str, module: &str, message: &str) {
    if let Some(store) = STORE.get() {
        let mut store = if std::thread::panicking() {
            match store.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::Poisoned(poison)) => poison.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return,
            }
        } else { store.lock().unwrap_or_else(|poison| poison.into_inner()) };
        if let Err(error) = store.append(level, module, message) { eprintln!("日志写入失败：{error}"); }
    }
}

#[macro_export]
macro_rules! app_warn {
    ($($arg:tt)*) => { $crate::logging::record("WARN", "backend", &format!($($arg)*)) };
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo { pub directory: String, pub file_count: usize, pub total_bytes: u64, pub max_file_bytes: u64, pub max_files: usize }

fn store() -> Result<&'static Mutex<LogStore>, crate::commands::error::CmdError> {
    STORE.get().ok_or_else(|| crate::commands::error::CmdError(format!("日志记录不可用：{}", INIT_ERROR.get().map(String::as_str).unwrap_or("尚未初始化"))))
}

#[tauri::command]
pub fn logs_info() -> crate::commands::error::CmdResult<LogInfo> {
    let store = store()?.lock().unwrap_or_else(|poison| poison.into_inner());
    let files = (0..store.max_files).filter_map(|index| std::fs::metadata(store.path(index)).ok()).collect::<Vec<_>>();
    Ok(LogInfo { directory: store.directory.to_string_lossy().into_owned(), file_count: files.len(), total_bytes: files.iter().map(|file| file.len()).sum(), max_file_bytes: store.max_bytes, max_files: store.max_files })
}

#[derive(Deserialize)]
pub struct ClientEntry { level: String, module: String, message: String }

#[tauri::command]
pub fn logs_write(entries: Vec<ClientEntry>) -> crate::commands::error::CmdResult<()> {
    let _ = store()?;
    for entry in entries.into_iter().take(50) { record(&entry.level, &entry.module, &entry.message); }
    Ok(())
}

#[tauri::command]
pub async fn logs_export(path: String) -> crate::commands::error::CmdResult<()> {
    let target = PathBuf::from(path);
    if !target.is_absolute() || !target.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("txt")) {
        return Err(crate::commands::error::CmdError("请选择 TXT 日志的绝对保存路径".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        store()?.lock().unwrap_or_else(|poison| poison.into_inner()).export(&target)
            .map_err(|error| crate::commands::error::CmdError(format!("日志导出失败：{error}")))
    }).await.map_err(|error| crate::commands::error::CmdError(error.to_string()))?
}

#[tauri::command]
pub fn logs_open_directory(app: tauri::AppHandle) -> crate::commands::error::CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let directory = logs_info()?.directory;
    app.opener().open_path(directory, None::<&str>).map_err(|error| crate::commands::error::CmdError(format!("无法打开日志目录：{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("koipage-log-test-{}-{name}", std::process::id()));
        assert!(!root.exists());
        root
    }
    fn cleanup(root: &Path) {
        for file in std::fs::read_dir(root).unwrap() { std::fs::remove_file(file.unwrap().path()).unwrap(); }
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn redacts_credentials_in_json_headers_query_strings_and_urls() {
        let input = r#"{"apiKey":"secret-one","Authorization":"Bearer secret-two"} https://example.test/?access_token=secret-three&ok=visible https://user:secret-four@example.test/ password=secret-five"#;
        let result = redact(input);
        for secret in ["secret-one","secret-two","secret-three","secret-four","secret-five"] { assert!(!result.contains(secret), "leaked {secret}: {result}"); }
        assert!(result.contains("ok=visible"));
        assert!(result.contains("[REDACTED]"));
    }
    #[test]
    fn redaction_is_idempotent_and_covers_quoted_values_and_basic_auth() {
        let input = r#"password="two word secret" Authorization: Basic dXNlcjpwYXNz {"secret":"contains spaces"}"#;
        let result = redact(input);
        for secret in ["two word secret", "dXNlcjpwYXNz", "contains spaces"] {
            assert!(!result.contains(secret), "leaked {secret}: {result}");
        }
        assert_eq!(redact(&result), result);
        assert_eq!(redact("token=[REDACTED]"), "token=[REDACTED]");
    }
    #[test]
    fn persists_records_rotates_bounded_files_and_exports_in_order() {
        let root = directory("rotation");
        let mut store = LogStore::new(&root, 512, 3).unwrap();
        for index in 0..18 { store.append("INFO", "test", &format!("record-{index:02} {}", "x".repeat(100))).unwrap(); }
        let files: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 3);
        for path in &files { assert!(std::fs::metadata(path).unwrap().len() <= 512); }
        drop(store);
        let store = LogStore::new(&root, 512, 3).unwrap();
        let target = root.join("export.txt");
        store.export(&target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("KoiPage"));
        assert!(text.contains("record-17"));
        assert!(!text.contains("record-00"));
        assert!(text.find("record-16").unwrap() < text.find("record-17").unwrap());
        cleanup(&root);
    }
    #[test]
    fn export_does_not_overwrite_live_logs_and_records_escape_newlines() {
        let root = directory("export");
        let mut store = LogStore::new(&root, 1024, 5).unwrap();
        store.append("ERROR", "test", "first\nsecond token=secret-value").unwrap();
        assert!(store.export(&root.join("koipage.log")).is_err());
        let text = std::fs::read_to_string(root.join("koipage.log")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(!text.contains("secret-value"));
        cleanup(&root);
    }
}
