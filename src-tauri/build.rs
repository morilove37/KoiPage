//! Build script: compile the Tauri context and generate the embedded asset
//! manifests.
//!
//! Bundled third-party tools (Magpie, 7-Zip) are shipped inside the executable
//! (`include_bytes!`) rather than as Tauri bundle resources: the extracted copy
//! must be writable (Magpie keeps its cache next to itself, 7-Zip is executed
//! from the app-local data directory), so each tool is unpacked on first use.
//! This mirrors how the bundled Locale Emulator works.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    generate_bundled_manifest("magpie", "magpie_files.rs");
    generate_bundled_manifest("7zip", "sevenzip_files.rs");
    tauri_build::build();
}

/// Write `$OUT_DIR/<output>` with one `(&str, &[u8])` entry per bundled asset.
///
/// Paths are absolute because the generated file is `include!`d from
/// `OUT_DIR`, not from this crate's source tree.
fn generate_bundled_manifest(resource_dir: &str, output: &str) {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );
    let root = manifest_dir.join("resources").join(resource_dir);
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
    let destination = out_dir.join(output);
    std::fs::write(&destination, source).expect("write the generated asset manifest");
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
