use super::*;
use sha2::{Digest, Sha256};

#[test]
fn pinned_binary_and_corresponding_source_are_bundled() {
    let manifest: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../resources/luna/manifest.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(BUNDLE)),
        manifest["binarySha256"]
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(SOURCE)),
        manifest["sourceSha256"]
    );
    assert_eq!(manifest["version"], BUNDLED_VERSION);
    assert!(
        LICENSE
            .windows(26)
            .any(|w| w == b"GNU GENERAL PUBLIC LICENSE")
    );
    assert!(NOTICE.windows(21).any(|w| w == b"LunaTranslator-source"));
}

#[test]
fn offline_deployment_repairs_missing_files_and_preserves_personal_config_and_updates() {
    let dir = std::env::temp_dir().join(format!(
        "koipage-luna-test-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let sevenzip = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/7zip/7z.exe");
    let executable = deploy(&dir, &sevenzip).unwrap();
    assert!(executable.is_file());
    assert!(dir.join("LunaTranslator-source.zip").is_file());
    let root = executable.parent().unwrap();
    assert!(root.join("LICENSES/LICENSE.LunaTranslator").is_file());
    let config = root.join("userconfig");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("personal.json"), b"personal config").unwrap();
    std::fs::write(root.join("LunaTranslator/updater-test.txt"), b"self update").unwrap();
    let critical = root.join("files/runtime3.13-64/python313.dll");
    std::fs::remove_file(&critical).unwrap();
    deploy(&dir, &sevenzip).unwrap();
    assert!(critical.is_file());
    assert_eq!(
        std::fs::read(config.join("personal.json")).unwrap(),
        b"personal config"
    );
    assert_eq!(
        std::fs::read(root.join("LunaTranslator/updater-test.txt")).unwrap(),
        b"self update"
    );
    let canonical = dir.canonicalize().unwrap();
    assert!(canonical.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    std::fs::remove_dir_all(canonical).unwrap();
}

#[test]
fn launch_command_runs_the_normal_executable_in_its_own_directory() {
    let path = std::path::Path::new(r"C:\Users\测试 用户\AppData\Local\LunaTranslator.exe");
    let command = launch_command(path);
    assert_eq!(command.get_program(), path.as_os_str());
    assert_eq!(command.get_current_dir(), path.parent());
    assert_eq!(command.get_args().count(), 0);
}

#[test]
fn graceful_exit_only_selects_luna_qt_windows_of_the_selected_process() {
    assert!(is_exit_window(
        42,
        &[42],
        "LunaTranslator",
        "Qt5152QWindowIcon"
    ));
    assert!(!is_exit_window(
        99,
        &[42],
        "LunaTranslator",
        "Qt5152QWindowIcon"
    ));
    assert!(!is_exit_window(
        42,
        &[42],
        "QTrayIconMessageWindow",
        "Qt5152TrayIconMessageWindowClass"
    ));
    assert!(!is_exit_window(
        42,
        &[42],
        "LunaTranslator",
        "luna_unique_classname_0"
    ));
    assert!(!is_exit_window(
        42,
        &[],
        "LunaTranslator",
        "Qt5152QWindowIcon"
    ));
}

#[test]
fn interrupted_install_repairs_truncated_runtime_source_and_entrypoints() {
    let dir = std::env::temp_dir().join(format!(
        "koipage-luna-interrupted-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    let root = dir.join("LunaTranslator_x64");
    let dll = root.join("files/runtime3.13-64/python313.dll");
    std::fs::create_dir_all(dll.parent().unwrap()).unwrap();
    std::fs::write(&dll, b"x").unwrap();
    std::fs::write(dir.join("LunaTranslator-source.zip"), b"x").unwrap();
    let sevenzip = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/7zip/7z.exe");
    let result = || {
        deploy(&dir, &sevenzip).unwrap();
        assert!(
            dll.metadata().unwrap().len() > 1000,
            "truncated Python runtime was accepted"
        );
        assert_eq!(
            std::fs::read(dir.join("LunaTranslator-source.zip")).unwrap(),
            SOURCE,
            "partial source archive was accepted"
        );
        for path in [
            root.join("LunaTranslator/main.py"),
            root.join("files/runtime3.13-64/python3.dll"),
        ] {
            std::fs::remove_file(&path).unwrap();
            deploy(&dir, &sevenzip).unwrap();
            assert!(
                path.is_file(),
                "missing startup file was not repaired: {}",
                path.display()
            );
        }
    };
    // Cleanup is executed even for a failing regression, within the owned temp root.
    let outcome = std::panic::catch_unwind(result);
    let canonical = dir.canonicalize().unwrap();
    assert!(canonical.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    std::fs::remove_dir_all(canonical).unwrap();
    outcome.unwrap();
}
