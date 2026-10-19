//! Unmodified official LunaTranslator, with its license and matching source.
use crate::commands::error::{CmdError, CmdResult};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

pub const BUNDLED_VERSION: &str = "12.1.2.9";
pub const AUTOSTART_KEY: &str = "luna_autostart";
const BINARY_HASH: &str = "1d8a2fd8ec0aade868471e0976491d2e97888d38f14d909f0e7628b9442410a3";
const BUNDLE: &[u8] = include_bytes!("../../resources/luna/LunaTranslator_x64.zip");
const SOURCE: &[u8] = include_bytes!("../../resources/luna/LunaTranslator-source.zip");
const LICENSE: &[u8] = include_bytes!("../../resources/luna/LICENSE");
const NOTICE: &[u8] = include_bytes!("../../resources/luna/NOTICE.txt");
static DEPLOY: Mutex<()> = Mutex::new(());
static LAUNCH: Mutex<()> = Mutex::new(());
const CRITICAL: &[&str] = &[
    "LunaTranslator.exe",
    "files/runtime3.13-64/python313.dll",
    "files/runtime3.13-64/python3.dll",
    "files/runtime3.13-64/PyQt5/Qt5/bin/Qt5Core.dll",
    "LunaTranslator/LunaTranslator.py",
    "LunaTranslator/main.py",
    "LICENSES/LICENSE.LunaTranslator",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunaStatus {
    pub path: String,
    pub version: &'static str,
    pub available: bool,
    pub running: bool,
    pub source_path: String,
    pub license_path: String,
    pub notice_path: String,
}

fn directory(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()?
        .join("tools")
        .join("luna")
        .join(BUNDLED_VERSION))
}
fn nonempty(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)
}
fn complete(root: &Path) -> bool {
    CRITICAL.iter().all(|p| nonempty(&root.join(p)))
}
fn write_missing(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    use sha2::{Digest, Sha256};
    let valid = path.metadata().is_ok_and(|m| m.len() == bytes.len() as u64)
        && std::fs::read(path).is_ok_and(|stored| Sha256::digest(&stored) == Sha256::digest(bytes));
    if !valid {
        publish(path, bytes)?;
    }
    Ok(())
}

/// Publish a complete file in the destination directory. Interrupted writes
/// remain under a task-owned temporary name and are never treated as installed.
fn publish(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    use std::io::Write;
    let name = path
        .file_name()
        .ok_or_else(|| CmdError("Luna 文件名无效".into()))?
        .to_string_lossy();
    let temporary = path.with_file_name(format!(".{name}.koipage-new"));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    result.map_err(|e| CmdError(format!("无法写入完整 Luna 文件 {}：{e}", path.display())))
}

fn merge_staged(staged: &Path, destination: &Path, preserve_existing: bool) -> CmdResult<()> {
    std::fs::create_dir_all(destination).map_err(|e| CmdError(e.to_string()))?;
    for entry in std::fs::read_dir(staged).map_err(|e| CmdError(e.to_string()))? {
        let entry = entry.map_err(|e| CmdError(e.to_string()))?;
        let kind = entry.file_type().map_err(|e| CmdError(e.to_string()))?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            merge_staged(&entry.path(), &target, preserve_existing)?;
        } else if kind.is_file() && (!preserve_existing || !nonempty(&target)) {
            let bytes = std::fs::read(entry.path()).map_err(|e| CmdError(e.to_string()))?;
            publish(&target, &bytes)?;
        }
    }
    Ok(())
}
fn deploy(directory: &Path, seven_zip: &Path) -> CmdResult<PathBuf> {
    let _lock = DEPLOY
        .lock()
        .map_err(|_| CmdError("Luna 初始化锁不可用".into()))?;
    std::fs::create_dir_all(directory).map_err(|e| CmdError(format!("无法创建 Luna 目录：{e}")))?;
    write_missing(&directory.join("LICENSE"), LICENSE)?;
    write_missing(&directory.join("NOTICE.txt"), NOTICE)?;
    write_missing(&directory.join("LunaTranslator-source.zip"), SOURCE)?;
    let root = directory.join("LunaTranslator_x64");
    let marker = directory.join(".koipage-ready");
    let was_ready = std::fs::read_to_string(&marker).is_ok_and(|s| s == BINARY_HASH);
    if complete(&root) && was_ready {
        return Ok(root.join("LunaTranslator.exe"));
    }
    let archive = directory.join(".koipage-bundle.zip");
    // Always restore the verified embedded archive after an interrupted write.
    publish(&archive, BUNDLE)?;
    let staging = directory.join(".koipage-staging");
    std::fs::create_dir_all(&staging)
        .map_err(|e| CmdError(format!("无法创建 Luna 临时目录：{e}")))?;
    let mut command = Command::new(seven_zip);
    command
        .args(["x", "-aoa", "-y", "-bd"])
        .arg(format!("-o{}", staging.display()))
        .arg(&archive)
        .current_dir(directory)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let result = command
        .output()
        .map_err(|e| CmdError(format!("无法解压内置 Luna：{e}")))?;
    let staged = staging.join("LunaTranslator_x64");
    if !result.status.success() || !complete(&staged) {
        return Err(CmdError(
            "内置 Luna 准备未完成，请点击重新检查；已有配置会保留。".into(),
        ));
    }
    merge_staged(&staged, &root, was_ready)?;
    if !complete(&root) {
        return Err(CmdError("Luna 文件未完整就绪，请重新检查。".into()));
    }
    publish(&marker, BINARY_HASH.as_bytes())?;
    // Only this task-owned archive is removed; user data is never cleaned here.
    let _ = std::fs::remove_file(&archive);
    // Resolve both paths before removing this task-owned staging directory.
    if let (Ok(base), Ok(staged)) = (directory.canonicalize(), staging.canonicalize()) {
        if staged.parent() == Some(base.as_path())
            && staged.file_name() == Some(std::ffi::OsStr::new(".koipage-staging"))
        {
            let _ = std::fs::remove_dir_all(staged);
        }
    }
    Ok(root.join("LunaTranslator.exe"))
}

fn launch_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    if let Some(root) = executable.parent() {
        command.current_dir(root);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0200);
    }
    command
}

#[cfg(windows)]
fn process_ids(executable: &Path) -> Vec<u32> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
        },
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let expected = executable
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let mut found = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) };
    while more != 0 {
        let len = entry
            .szExeFile
            .iter()
            .position(|v| *v == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
        if name.eq_ignore_ascii_case("LunaTranslator.exe") {
            let handle =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
            if !handle.is_null() {
                let mut buffer = vec![0u16; 32768];
                let mut size = buffer.len() as u32;
                let ok = unsafe {
                    QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size)
                };
                unsafe { CloseHandle(handle) };
                if ok != 0
                    && String::from_utf16_lossy(&buffer[..size as usize])
                        .replace('/', "\\")
                        .to_lowercase()
                        == expected
                {
                    found.push(entry.th32ProcessID);
                }
            }
        }
        more = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    found
}
#[cfg(not(windows))]
fn process_ids(_executable: &Path) -> Vec<u32> {
    Vec::new()
}

fn running(executable: &Path) -> bool {
    !process_ids(executable).is_empty()
}

/// The upstream TranslatorWindow.closeEvent saves configuration and exits;
/// closing its utility/message windows alone would merely hide those windows.
#[cfg(any(windows, test))]
fn is_exit_window(pid: u32, selected: &[u32], title: &str, class: &str) -> bool {
    selected.contains(&pid)
        && title == "LunaTranslator"
        && class.starts_with("Qt")
        && class.ends_with("QWindowIcon")
}

#[cfg(windows)]
fn request_exit(executable: &Path, pids: &[u32]) -> CmdResult<()> {
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, PostMessageW,
            WM_CLOSE,
        },
    };
    use windows_sys::core::BOOL;
    struct Targets<'a> {
        pids: &'a [u32],
        windows: Vec<HWND>,
    }
    unsafe extern "system" fn collect(hwnd: HWND, parameter: LPARAM) -> BOOL {
        let targets = unsafe { &mut *(parameter as *mut Targets<'_>) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if !targets.pids.contains(&pid) {
            return 1;
        }
        let mut title = [0u16; 256];
        let mut class = [0u16; 128];
        let title_len = unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) };
        let class_len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        if is_exit_window(
            pid,
            targets.pids,
            &String::from_utf16_lossy(&title[..title_len.max(0) as usize]),
            &String::from_utf16_lossy(&class[..class_len.max(0) as usize]),
        ) {
            targets.windows.push(hwnd);
        }
        1
    }
    let mut targets = Targets {
        pids,
        windows: Vec::new(),
    };
    if unsafe { EnumWindows(Some(collect), &mut targets as *mut Targets<'_> as LPARAM) } == 0 {
        return Err(CmdError(
            "无法读取 Luna 窗口，请在 Luna 的托盘菜单中选择退出。".into(),
        ));
    }
    let mut posted = false;
    for hwnd in targets.windows {
        posted |= unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } != 0;
    }
    if !posted && running(executable) {
        return Err(CmdError("无法发送正常退出请求，请在 Luna 的托盘菜单中选择退出；若以管理员权限启动，请从 Luna 自身退出。".into()));
    }
    Ok(())
}
#[cfg(not(windows))]
fn request_exit(_executable: &Path, _pids: &[u32]) -> CmdResult<()> {
    Err(CmdError("当前系统不支持 Luna 窗口退出。".into()))
}

fn quit(app: &AppHandle) -> CmdResult<bool> {
    let _lock = LAUNCH
        .lock()
        .map_err(|_| CmdError("Luna 启停锁不可用".into()))?;
    // Closing never deploys or repairs the tool, and only targets this exact copy.
    let executable = directory(app)?
        .join("LunaTranslator_x64")
        .join("LunaTranslator.exe");
    let pids = process_ids(&executable);
    if pids.is_empty() {
        return Ok(false);
    }
    request_exit(&executable, &pids)?;
    for _ in 0..50 {
        if !running(&executable) {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(CmdError(
        "Luna 尚未完成退出，请处理 Luna 中的提示后重试，或在其托盘菜单中选择退出。".into(),
    ))
}

fn prepare(app: &AppHandle) -> CmdResult<LunaStatus> {
    let dir = directory(app)?;
    let executable = deploy(&dir, &crate::extract::seven_zip_path(app)?)?;
    Ok(LunaStatus {
        running: running(&executable),
        path: executable.to_string_lossy().into_owned(),
        version: BUNDLED_VERSION,
        available: true,
        source_path: dir
            .join("LunaTranslator-source.zip")
            .to_string_lossy()
            .into_owned(),
        license_path: dir.join("LICENSE").to_string_lossy().into_owned(),
        notice_path: dir.join("NOTICE.txt").to_string_lossy().into_owned(),
    })
}
fn launch(app: &AppHandle) -> CmdResult<bool> {
    let _lock = LAUNCH
        .lock()
        .map_err(|_| CmdError("Luna 启动锁不可用".into()))?;
    let status = prepare(app)?;
    let executable = Path::new(&status.path);
    if status.running {
        return Ok(false);
    }
    let mut child = launch_command(executable)
        .spawn()
        .map_err(|e| CmdError(format!("无法启动 LunaTranslator：{e}")))?;
    // Hold the launch gate while the GUI initializes; a second action then sees
    // the running executable instead of racing another CreateProcess call.
    for _ in 0..20 {
        if let Some(exit) = child.try_wait().map_err(|e| CmdError(e.to_string()))? {
            return if exit.success() && running(executable) {
                Ok(false)
            } else {
                Err(CmdError(format!(
                    "LunaTranslator 启动后退出（{exit}），请查看程序目录中的日志或官方教程。"
                )))
            };
        }
        if running(executable) {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(true)
}

#[tauri::command]
pub async fn luna_status(app: AppHandle) -> CmdResult<LunaStatus> {
    tauri::async_runtime::spawn_blocking(move || prepare(&app))
        .await
        .map_err(|e| CmdError(format!("Luna 准备任务失败：{e}")))?
}
#[tauri::command]
pub async fn luna_launch(app: AppHandle) -> CmdResult<bool> {
    tauri::async_runtime::spawn_blocking(move || launch(&app))
        .await
        .map_err(|e| CmdError(format!("Luna 启动任务失败：{e}")))?
}
#[tauri::command]
pub async fn luna_quit(app: AppHandle) -> CmdResult<bool> {
    tauri::async_runtime::spawn_blocking(move || quit(&app))
        .await
        .map_err(|e| CmdError(format!("Luna 退出任务失败：{e}")))?
}
pub async fn autostart(app: &AppHandle) {
    let result = async {
        let db = crate::commands::games::pool(app).await?;
        if super::flag_is_on(super::setting(&db, AUTOSTART_KEY).await?.as_deref()) {
            luna_launch(app.clone()).await?;
        }
        Ok::<_, CmdError>(())
    }
    .await;
    if let Err(e) = result {
        crate::app_warn!("[luna] optional autostart: {e}");
    }
}

#[cfg(test)]
mod luna_tests;
