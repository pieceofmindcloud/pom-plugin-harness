//! Runs the embedded herdr + pi runtime next to the plugin host.
//!
//! The POM configures the plugin through the `host.configure` query: the
//! node's local OpenAI-compatible endpoint and the API key to call it. Nothing
//! about the model endpoint is compiled into the plugin. Once configured, the
//! runtime archive (portable Node.js, the official herdr binary, the official
//! `@earendil-works/pi-coding-agent` release and `launcher.mjs`) is unpacked once per archive checksum under the
//! plugin's data directory and `node launcher.mjs` is started with that
//! configuration. A new configuration restarts it.
//!
//! The launcher answers with one JSON status line on stdout and exits when its
//! stdin closes, so dropping the supervisor always stops the harness. The
//! plugin host speaks IPC over its own stdin/stdout: the child never inherits
//! them.

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const PLUGIN_DIR: &str = "pi_harness";

/// What the POM hands to the plugin in `host.configure`.
#[derive(Debug, Clone, PartialEq)]
pub struct Gateway {
    pub openai_base_url: String,
    pub api_key: String,
}

impl Gateway {
    /// Read `{"gateway": {"openai_base_url": "...", "api_key": "..."}}`.
    pub fn from_configure(request: &Value) -> Result<Self, String> {
        let gateway = &request["gateway"];
        let openai_base_url = gateway["openai_base_url"]
            .as_str()
            .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
            .ok_or("host.configure has no gateway.openai_base_url")?;
        let api_key = gateway["api_key"]
            .as_str()
            .filter(|key| !key.trim().is_empty())
            .ok_or("host.configure has no gateway.api_key")?;
        Ok(Self {
            openai_base_url: openai_base_url.to_owned(),
            api_key: api_key.to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Waiting for `host.configure` from the POM.
    Unconfigured,
    Starting,
    Ready {
        port: u16,
        token: String,
        detail: Value,
    },
    Failed(String),
}

impl Status {
    /// `ui/runtime.json`, which the plugin screen polls. It never carries the
    /// upstream token: only the node talks to the launcher.
    pub fn to_json(&self) -> Value {
        match self {
            Status::Unconfigured => json!({"status": "starting", "detail": {"waiting": "pom"}}),
            Status::Starting => json!({"status": "starting"}),
            Status::Ready { detail, .. } => json!({"status": "ready", "detail": detail}),
            Status::Failed(error) => json!({"status": "error", "error": error}),
        }
    }

    /// The `ui.upstream` reply the POM's plugin proxy reads.
    pub fn upstream_json(&self) -> Value {
        match self {
            Status::Ready { port, token, .. } => {
                json!({"status": "ready", "port": port, "token": token})
            }
            Status::Failed(error) => json!({"status": "error", "error": error}),
            Status::Unconfigured | Status::Starting => json!({"status": "starting"}),
        }
    }
}

struct Process {
    child: Child,
    // Held open for the child's lifetime; closing it asks the launcher to stop.
    stdin: ChildStdin,
}

pub struct Supervisor {
    archive: &'static [u8],
    checksum: &'static str,
    status: Mutex<Status>,
    process: Mutex<Option<Process>>,
    gateway: Mutex<Option<Gateway>>,
    /// Bumped on every (re)start, so a superseded worker cannot overwrite the
    /// status of the current one.
    generation: AtomicU64,
}

impl Supervisor {
    pub fn new(archive: &'static [u8], checksum: &'static str) -> Arc<Self> {
        Arc::new(Self {
            archive,
            checksum,
            status: Mutex::new(Status::Unconfigured),
            process: Mutex::new(None),
            gateway: Mutex::new(None),
            generation: AtomicU64::new(0),
        })
    }

    pub fn status(&self) -> Status {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(Status::Starting)
    }

    fn set_status(&self, generation: u64, status: Status) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// `host.configure`: start the harness, or restart it when the POM hands
    /// over a different endpoint or key. Returns promptly; the start runs in
    /// the background because `query` must not block the plugin host.
    pub fn configure(self: &Arc<Self>, gateway: Gateway) {
        {
            let Ok(mut current) = self.gateway.lock() else {
                return;
            };
            if current.as_ref() == Some(&gateway) && !matches!(self.status(), Status::Failed(_)) {
                return;
            }
            *current = Some(gateway.clone());
        }
        self.stop();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut status) = self.status.lock() {
            *status = Status::Starting;
        }
        let worker = Arc::clone(self);
        thread::spawn(move || {
            if let Err(error) = worker.run(generation, &gateway) {
                worker.set_status(generation, Status::Failed(error));
            }
        });
    }

    fn run(&self, generation: u64, gateway: &Gateway) -> Result<(), String> {
        if self.archive.is_empty() {
            return Err("this build does not bundle the harness runtime".into());
        }
        let base = plugin_directory()?;
        let runtime = unpack_runtime(&base.join("runtime"), self.archive, self.checksum)?;
        let node = runtime
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut child = Command::new(&node)
            .arg(runtime.join("launcher.mjs"))
            .current_dir(&runtime)
            .env("PI_POM_DATA_DIR", base.join("data"))
            .env("PI_POM_LLM_BASE_URL", &gateway.openai_base_url)
            .env("PI_POM_LLM_API_KEY", &gateway.api_key)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("start {}: {error}", node.display()))?;
        let stdin = child.stdin.take().ok_or("launcher stdin is not piped")?;
        let stdout = child.stdout.take().ok_or("launcher stdout is not piped")?;
        if let Ok(mut process) = self.process.lock() {
            if self.generation.load(Ordering::SeqCst) != generation {
                // Superseded while starting: let this launcher go.
                drop(stdin);
                let _ = child.kill();
                return Ok(());
            }
            *process = Some(Process { child, stdin });
        }

        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .map_err(|error| format!("read launcher status: {error}"))?;
        let reply: Value = serde_json::from_str(line.trim())
            .map_err(|_| "the harness launcher exited before it was ready".to_owned())?;
        match reply["status"].as_str() {
            Some("ready") => {
                let port = reply["port"]
                    .as_u64()
                    .and_then(|port| u16::try_from(port).ok())
                    .ok_or("launcher reported no port")?;
                let token = reply["token"]
                    .as_str()
                    .ok_or("launcher reported no token")?;
                let detail = json!({"models": reply["models"], "warning": reply["warning"]});
                self.set_status(
                    generation,
                    Status::Ready {
                        port,
                        token: token.to_owned(),
                        detail,
                    },
                );
            }
            _ => {
                return Err(reply["error"]
                    .as_str()
                    .unwrap_or("the harness launcher failed")
                    .to_owned())
            }
        }
        self.watch(generation);
        Ok(())
    }

    /// Report a harness that stops after it was ready.
    fn watch(&self, generation: u64) {
        loop {
            thread::sleep(Duration::from_secs(1));
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Ok(mut process) = self.process.lock() else {
                return;
            };
            let Some(running) = process.as_mut() else {
                return;
            };
            if let Ok(Some(exit)) = running.child.try_wait() {
                *process = None;
                drop(process);
                self.set_status(
                    generation,
                    Status::Failed(format!("the harness stopped ({exit})")),
                );
                return;
            }
        }
    }

    pub fn stop(&self) {
        let process = self
            .process
            .lock()
            .ok()
            .and_then(|mut process| process.take());
        if let Some(mut process) = process {
            drop(process.stdin);
            for _ in 0..20 {
                if matches!(process.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

/// `<dir of POM_PLUGIN_DB>/pi_harness`, the data home the POM gives this plugin.
fn plugin_directory() -> Result<PathBuf, String> {
    let parent = std::env::var_os("POM_PLUGIN_DB")
        .map(PathBuf::from)
        .and_then(|database| database.parent().map(Path::to_path_buf))
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent = match parent {
        Some(parent) => parent,
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    Ok(parent.join(PLUGIN_DIR))
}

/// Unpack once per archive checksum, atomically, and drop older runtimes.
pub fn unpack_runtime(root: &Path, archive: &[u8], checksum: &str) -> Result<PathBuf, String> {
    let id = &checksum[..checksum.len().min(16)];
    let target = root.join(id);
    if target.join("launcher.mjs").is_file() {
        return Ok(target);
    }
    fs::create_dir_all(root).map_err(|error| format!("{}: {error}", root.display()))?;
    let partial = root.join(format!(".{id}.partial"));
    let _ = fs::remove_dir_all(&partial);
    let mut unpacker = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    unpacker.set_preserve_permissions(true);
    unpacker
        .unpack(&partial)
        .map_err(|error| format!("unpack harness runtime: {error}"))?;
    fs::rename(&partial, &target).map_err(|error| format!("install harness runtime: {error}"))?;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_name() != id {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, path, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn runtime_unpacks_once_per_checksum_and_replaces_older_ones() {
        let root = std::env::temp_dir().join(format!("pi-unpack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = archive_with(&[("launcher.mjs", b"// one")]);
        let path = unpack_runtime(&root, &first, &"a".repeat(64)).unwrap();
        assert_eq!(fs::read(path.join("launcher.mjs")).unwrap(), b"// one");
        assert_eq!(unpack_runtime(&root, &[], &"a".repeat(64)).unwrap(), path);

        let second = archive_with(&[("launcher.mjs", b"// two")]);
        let next = unpack_runtime(&root, &second, &"b".repeat(64)).unwrap();
        assert_eq!(fs::read(next.join("launcher.mjs")).unwrap(), b"// two");
        assert!(!path.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn runtime_status_never_exposes_the_upstream_token() {
        assert_eq!(Status::Starting.to_json(), json!({"status": "starting"}));
        assert_eq!(Status::Unconfigured.to_json()["status"], "starting");
        assert_eq!(
            Status::Failed("boom".into()).to_json(),
            json!({"status": "error", "error": "boom"})
        );
        let ready = Status::Ready {
            port: 4100,
            token: "secret".into(),
            detail: json!({"models": ["m"]}),
        };
        assert_eq!(
            ready.to_json(),
            json!({"status": "ready", "detail": {"models": ["m"]}})
        );
        assert_eq!(
            ready.upstream_json(),
            json!({"status": "ready", "port": 4100, "token": "secret"})
        );
        assert_eq!(
            Status::Unconfigured.upstream_json(),
            json!({"status": "starting"})
        );
    }

    #[test]
    fn configuration_comes_only_from_the_pom_request() {
        let request =
            json!({"gateway": {"openai_base_url": "http://127.0.0.1:8080/v1", "api_key": "sk-1"}});
        assert_eq!(
            Gateway::from_configure(&request),
            Ok(Gateway {
                openai_base_url: "http://127.0.0.1:8080/v1".into(),
                api_key: "sk-1".into()
            })
        );
        assert!(Gateway::from_configure(&json!({})).is_err());
        assert!(Gateway::from_configure(
            &json!({"gateway": {"openai_base_url": "file:///etc", "api_key": "sk-1"}})
        )
        .is_err());
        assert!(Gateway::from_configure(
            &json!({"gateway": {"openai_base_url": "http://x/v1", "api_key": " "}})
        )
        .is_err());
    }
}
