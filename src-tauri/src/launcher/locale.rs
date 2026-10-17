//! Portable Locale Emulator integration, launched as a separate process.
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use crate::commands::error::{CmdError, CmdResult};

pub const VERSION: &str = "2.5.0.1";
const PROFILE: &str = "e7d47e25-577a-4da1-94d8-efcae42b9f97";
static EXTRACTION: Mutex<()> = Mutex::new(());
const FILES: &[(&str, &[u8])] = &[
    ("LEProc.exe", include_bytes!("../../resources/locale-emulator/LEProc.exe")),
    ("LECommonLibrary.dll", include_bytes!("../../resources/locale-emulator/LECommonLibrary.dll")),
    ("LoaderDll.dll", include_bytes!("../../resources/locale-emulator/LoaderDll.dll")),
    ("LocaleEmulator.dll", include_bytes!("../../resources/locale-emulator/LocaleEmulator.dll")),
    ("LEConfig.xml", include_bytes!("../../resources/locale-emulator/LEConfig.xml")),
    ("LEVersion.xml", include_bytes!("../../resources/locale-emulator/LEVersion.xml")),
    ("COPYING", include_bytes!("../../resources/locale-emulator/COPYING")),
    ("COPYING.LESSER", include_bytes!("../../resources/locale-emulator/COPYING.LESSER")),
    ("NOTICE.txt", include_bytes!("../../resources/locale-emulator/NOTICE.txt")),
];

fn extract_to(directory: &Path) -> CmdResult<PathBuf> {
    let _guard = EXTRACTION.lock().map_err(|_| CmdError("内置 LE 初始化锁不可用".into()))?;
    std::fs::create_dir_all(directory).map_err(|error| CmdError(format!("无法准备内置 LE：{error}")))?;
    for (name, bytes) in FILES {
        let path = directory.join(name);
        // Keep separately replaceable LGPL components and existing profiles.
        if !path.is_file() {
            std::fs::write(&path, bytes).map_err(|error| CmdError(format!("内置 LE 文件准备失败 {name}：{error}")))?;
        }
    }
    Ok(directory.join("LEProc.exe"))
}

pub fn bundled_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let directory = app.path().app_local_data_dir().map_err(|error| CmdError(error.to_string()))?
        .join("tools").join("locale-emulator").join(VERSION);
    extract_to(&directory)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleToolStatus {
    available: bool,
    path: Option<String>,
    version: String,
}

#[tauri::command]
pub fn locale_tool_status(app: AppHandle) -> CmdResult<LocaleToolStatus> {
    #[cfg(windows)]
    { Ok(LocaleToolStatus { available: true, path: Some(bundled_path(&app)?.to_string_lossy().into_owned()), version: VERSION.into() }) }
    #[cfg(not(windows))]
    { let _ = app; Ok(LocaleToolStatus { available: false, path: None, version: VERSION.into() }) }
}

/// Reject unsupported games before spawning LE or opening a play session.
pub fn validate_game(exe: &Path) -> CmdResult<()> {
    let mut file = std::fs::File::open(exe).map_err(|error| CmdError(format!("无法读取游戏程序：{error}")))?;
    let mut dos = [0_u8; 64];
    let invalid = || CmdError("内置 LE 需要有效的 32 位 Windows 游戏程序".into());
    file.read_exact(&mut dos).map_err(|_| invalid())?;
    if &dos[..2] != b"MZ" { return Err(invalid()); }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap());
    if offset > 1024 * 1024 { return Err(invalid()); }
    file.seek(SeekFrom::Start(offset as u64)).map_err(|_| invalid())?;
    let mut pe = [0_u8; 6];
    file.read_exact(&mut pe).map_err(|_| invalid())?;
    if &pe[..4] != b"PE\0\0" { return Err(invalid()); }
    if u16::from_le_bytes([pe[4], pe[5]]) != 0x014c {
        return Err(CmdError("内置 LE 仅支持 32 位游戏；64 位游戏请关闭「转区启动」后重试。".into()));
    }
    Ok(())
}

/// Windows command-line quoting, including quotes and trailing backslashes.
fn quote_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' { slashes += 1; continue; }
        output.extend(std::iter::repeat_n('\\', slashes * if ch == '"' { 2 } else { 1 }));
        slashes = 0;
        if ch == '"' { output.push('\\'); }
        output.push(ch);
    }
    output.extend(std::iter::repeat_n('\\', slashes * 2));
    output.push('"');
    output
}

/// LEProc joins its remaining arguments without re-quoting. Pass an already
/// serialized command line as one argument so spaces/empty strings survive.
pub fn arguments(exe: &Path, args: &[String], bundled: bool) -> Vec<String> {
    let mut result = if bundled { vec!["-runas".into(), PROFILE.into()] } else { Vec::new() };
    result.push(exe.to_string_lossy().into_owned());
    if !args.is_empty() { result.push(args.iter().map(|value| quote_argument(value)).collect::<Vec<_>>().join(" ")); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        std::env::temp_dir().join(format!("koipage-locale-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[test]
    fn bundled_runtime_is_portable_complete_and_keeps_replacements() {
        let directory = temporary().join("Japanese 日本語 with spaces");
        let executable = extract_to(&directory).unwrap();
        for (name, bytes) in FILES { assert_eq!(std::fs::read(directory.join(name)).unwrap(), *bytes); }
        assert_eq!(executable, directory.join("LEProc.exe"));
        std::fs::write(directory.join("LoaderDll.dll"), b"compatible user replacement").unwrap();
        extract_to(&directory).unwrap();
        assert_eq!(std::fs::read(directory.join("LoaderDll.dll")).unwrap(), b"compatible user replacement");
        std::fs::remove_dir_all(directory.parent().unwrap()).unwrap();
    }

    #[test]
    fn le_uses_fixed_japanese_profile_and_preserves_argument_boundaries() {
        let exe = Path::new(r"E:\Games\日本語 game\game.exe");
        let args = vec!["--name".into(), "two words".into(), "".into(), "a\"b".into(), "C:\\trailing\\".into()];
        let command = arguments(exe, &args, true);
        assert_eq!(&command[..3], &["-runas", PROFILE, exe.to_str().unwrap()]);
        assert_eq!(command[3], r#""--name" "two words" "" "a\"b" "C:\trailing\\""#);
        assert_eq!(arguments(exe, &[], false), vec![exe.to_string_lossy().into_owned()]);
        let config = String::from_utf8_lossy(FILES.iter().find(|(name, _)| *name == "LEConfig.xml").unwrap().1);
        assert!(config.contains(PROFILE) && config.contains("<Location>ja-JP</Location>") && config.contains("<RunAsAdmin>false</RunAsAdmin>"));
    }

    #[test]
    fn rejects_64_bit_and_invalid_executables() {
        let directory = temporary(); std::fs::create_dir_all(&directory).unwrap();
        let exe = directory.join("game.exe");
        let mut bytes = vec![0_u8; 128]; bytes[..2].copy_from_slice(b"MZ"); bytes[60..64].copy_from_slice(&64_u32.to_le_bytes()); bytes[64..68].copy_from_slice(b"PE\0\0");
        for (machine, valid) in [(0x014c_u16, true), (0x8664, false), (0xaa64, false)] {
            bytes[68..70].copy_from_slice(&machine.to_le_bytes()); std::fs::write(&exe, &bytes).unwrap();
            assert_eq!(validate_game(&exe).is_ok(), valid);
        }
        std::fs::write(&exe, b"broken").unwrap(); assert!(validate_game(&exe).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
