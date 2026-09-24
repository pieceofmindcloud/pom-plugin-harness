use std::{env, fs, path::Path};

fn content_type(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// The herdr + pi runtime archive from `scripts/fetch-runtime.sh`, named by
/// `HARNESS_RUNTIME_ARCHIVE`. Without it the library still builds, and the plugin
/// reports that no runtime is bundled.
fn runtime_archive(generated: &mut String) {
    println!("cargo:rerun-if-env-changed=HARNESS_RUNTIME_ARCHIVE");
    let archive = env::var("HARNESS_RUNTIME_ARCHIVE")
        .ok()
        .filter(|value| !value.is_empty());
    let Some(archive) = archive else {
        generated.push_str("pub static RUNTIME_ARCHIVE: &[u8] = &[];\n");
        generated.push_str("pub static RUNTIME_SHA256: &str = \"\";\n");
        return;
    };
    let checksum_path = format!("{archive}.sha256");
    println!("cargo:rerun-if-changed={archive}");
    println!("cargo:rerun-if-changed={checksum_path}");
    let checksum = fs::read_to_string(&checksum_path)
        .unwrap_or_else(|error| panic!("{checksum_path}: {error}"));
    let checksum = checksum.trim();
    assert!(
        checksum.len() == 64 && checksum.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "{checksum_path} does not hold a SHA-256"
    );
    generated.push_str(&format!(
        "pub static RUNTIME_ARCHIVE: &[u8] = include_bytes!({archive:?});\n"
    ));
    generated.push_str(&format!(
        "pub static RUNTIME_SHA256: &str = {checksum:?};\n"
    ));
}

fn main() {
    let root = env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
    let mut entries = Vec::new();

    for (directory, prefix, extensions) in [
        ("ui/dist", "ui", &["js", "css"][..]),
        ("ui/dist/i18n", "i18n", &["json"][..]),
    ] {
        println!("cargo:rerun-if-changed={directory}");
        let Ok(files) = fs::read_dir(Path::new(&root).join(directory)) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            let extension = Path::new(&name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if extensions.contains(&extension) {
                entries.push((
                    format!("{prefix}/{name}"),
                    file.path().to_string_lossy().into_owned(),
                ));
            }
        }
    }

    entries.sort();
    let mut generated = String::from("pub static UI_ASSETS: &[(&str, &str, &[u8])] = &[\n");
    for (name, path) in &entries {
        generated.push_str(&format!(
            "    ({name:?}, {:?}, include_bytes!({path:?})),\n",
            content_type(name)
        ));
    }
    generated.push_str("];\n");
    runtime_archive(&mut generated);
    let output = Path::new(&env::var("OUT_DIR").expect("output directory")).join("ui_assets.rs");
    fs::write(output, generated).expect("write embedded asset index");
    println!("cargo:rerun-if-changed=ui/manifest.json");
    println!("cargo:rerun-if-changed=i18n");
}
