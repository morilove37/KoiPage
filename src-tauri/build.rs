//! Build script: compile the Tauri context and generate the embedded Magpie
//! asset manifest.
//!
//! Magpie is shipped inside the executable (`include_bytes!`) rather than as a
//! Tauri bundle resource, mirroring how the bundled Locale Emulator works: the
//! extracted copy must be writable (Magpie keeps its cache/logs next to the
//! executable), so it is unpacked to the app-local data directory on first use.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    generate_magpie_manifest();
    tauri_build::build();
}

/// Write `$OUT_DIR/magpie_files.rs` with one `(&str, &[u8])` entry per bundled
/// asset. Paths are absolute because the generated file is `include!`d from
/// `OUT_DIR`, not from this crate's source tree.
fn generate_magpie_manifest() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let root = manifest_dir.join("resources").join("magpie");
    println!("cargo:rerun-if-changed={}", root.display());

    let mut files = Vec::new();
    collect_files(&root, &root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut source = String::from("pub static BUNDLED_FILES: &[(&str, &[u8])] = &[\n");
    for (relative, absolute) in &files {
        writeln!(
            source,
            "    (r#\"{relative}\"#, include_bytes!(r#\"{absolute}\"#)),",
            relative = relative,
            absolute = absolute.display(),
        )
        .expect("writing to a String cannot fail");
    }
    source.push_str("];\n");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let destination = out_dir.join("magpie_files.rs");
    std::fs::write(&destination, source).expect("write the generated Magpie manifest");
}

/// Recursively collect `(forward-slash relative path, absolute path)` pairs.
fn collect_files(root: &Path, directory: &Path, out: &mut Vec<(String, PathBuf)>) {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => panic!("cannot read {}: {error}", directory.display()),
    };
    for entry in entries {
        let entry = entry.unwrap_or_else(|error| panic!("cannot read an entry: {error}"));
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or_else(|_| panic!("{} is outside {}", path.display(), root.display()))
            .to_string_lossy()
            .replace('\\', "/");
        out.push((relative, path));
    }
}
