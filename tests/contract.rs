use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn text(path: &str) -> String {
    fs::read_to_string(root().join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn json(path: &str) -> Value {
    serde_json::from_str(&text(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn manifest_registers_one_admin_only_full_bleed_terminal() {
    let manifest = json("ui/manifest.json");
    assert_eq!(manifest["schema"], "pom-plugin-ui/v1");
    assert_eq!(manifest["plugin_code"], "harness");
    assert_eq!(manifest["icon_image"], "ui/icon.png");
    assert_eq!(
        manifest["documentation"],
        serde_json::json!([
            "docs/README.md",
            "docs/guia-workspace.md",
            "docs/guia-desenvolvimento.md"
        ])
    );

    let menu = manifest["menu"].as_array().expect("menu array");
    assert_eq!(menu.len(), 1);
    assert_eq!(menu[0]["to"], "/terminal");
    assert_eq!(menu[0]["label"]["en"], "Harness");
    assert_eq!(menu[0]["roles"], serde_json::json!(["admin"]));
    // One of the names the POM resolves; anything else falls back to a generic icon.
    assert_eq!(menu[0]["icon"], "terminal");

    let routes = manifest["routes"].as_array().expect("routes array");
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0]["path"], "/terminal");
    assert_eq!(routes[0]["screen"], "terminal");
    assert_eq!(routes[0]["full_bleed"], true);
    assert_eq!(routes[0]["roles"], serde_json::json!(["admin"]));

    let screen = &manifest["screens"]["terminal"];
    assert_eq!(screen["module"], "ui/screens.js");
    assert_eq!(screen["export"], "terminal");
    assert!(text("ui/src/screens/index.tsx").contains("Terminal as terminal"));
}

#[test]
fn assets_include_the_dynamic_runtime_status() {
    let manifest = json("ui/manifest.json");
    let assets: BTreeSet<_> = manifest["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| asset.as_str().unwrap())
        .collect();
    assert_eq!(
        assets,
        BTreeSet::from([
            "ui/screens.js",
            "ui/plugin.css",
            "ui/icon.png",
            "ui/runtime.json",
            "i18n/en.json",
            "i18n/pt-BR.json",
            "docs/README.md",
            "docs/guia-workspace.md",
            "docs/guia-desenvolvimento.md",
        ])
    );
    assert!(text("src/lib.rs").contains("const RUNTIME_ASSET: &str = \"ui/runtime.json\";"));
    assert!(fs::read(root().join("ui/icon.png"))
        .unwrap()
        .starts_with(b"\x89PNG\r\n\x1a\n"));
    assert!(text("build.rs").contains("image/png"));
    assert!(text("build.rs").contains("text/markdown"));
    assert!(text("docs/guia-workspace.md").contains("workspace_root"));
    assert!(text("docs/guia-workspace.md").contains("GET /projects"));
    assert!(text("tests/unit/launcher.test.mjs")
        .contains("workspace listing returns visible immediate directories"));
}

#[test]
fn catalogs_match_each_other_and_the_keys_the_screen_uses() {
    let en = json("i18n/en.json");
    let pt = json("i18n/pt-BR.json");
    let en_keys: BTreeSet<_> = en.as_object().unwrap().keys().cloned().collect();
    let pt_keys: BTreeSet<_> = pt.as_object().unwrap().keys().cloned().collect();
    assert_eq!(en_keys, pt_keys);

    let source = text("ui/src/screens/Terminal.tsx");
    let used: BTreeSet<_> = source
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|candidate| en_keys.contains(*candidate))
        .map(str::to_owned)
        .collect();
    assert_eq!(
        used, en_keys,
        "every catalog key is used and none is missing"
    );
}

#[test]
fn launcher_never_inherits_the_host_herdr_session() {
    let launcher = text("runtime/launcher.mjs");
    // A HERDR_SOCKET_PATH or HERDR_SESSION in the POM environment would point
    // herdr at the host user's own session; the private env is built from a
    // short allowlist instead of the POM environment.
    assert!(launcher.contains("export function privateEnv"));
    assert!(!launcher.contains("...env"));
    assert!(!launcher.contains("...process.env"));
    assert!(text("scripts/fetch-runtime.sh").contains("runtime/launcher.mjs"));
    assert!(text("src/supervisor.rs").contains("\"HARNESS_POM_LLM_BASE_URL\""));
}
