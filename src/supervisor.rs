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
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const PLUGIN_DIR: &str = "harness";

/// Generation of the plugin data layout. When the value stored in
/// `data/.data-epoch` differs, the next start wipes `data/` (private home,
/// downloaded agents, agent choices, herdr state) and the harness installs
/// everything again from zero. Bump it only when a release must start clean;
/// user projects live in the POM workspace root, never under `data/`.
pub const DATA_EPOCH: u32 = 3;
const EPOCH_FILE: &str = ".data-epoch";

/// What the POM hands to the plugin in `host.configure`.
#[derive(Debug, Clone, PartialEq)]
pub struct Gateway {
    pub openai_base_url: String,
    pub api_key: String,
    pub workspace_root: Option<String>,
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
        let workspace_root = match request.get("workspace_root") {
            None | Some(Value::Null) => None,
            Some(Value::String(root)) if !root.trim().is_empty() => Some(root.clone()),
            Some(Value::String(_)) => None,
            Some(_) => return Err("workspace_root must be a string or null".into()),
        };
        Ok(Self {
            openai_base_url: openai_base_url.to_owned(),
            api_key: api_key.to_owned(),
            workspace_root,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Waiting for `host.configure` from the POM.
    Unconfigured,
    Starting(Progress),
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
            Status::Starting(progress) => progress.to_json(),
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
            Status::Unconfigured | Status::Starting(_) => json!({"status": "starting"}),
        }
    }
}

/// What a start is doing. `Runtime` writes the bundled runtime out, the
/// install of a new release; `Launch` waits for the launcher's ready line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Runtime,
    Launch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// No runtime was unpacked before: the first start of the plugin.
    Install,
    /// An older release's runtime is replaced.
    Update,
}

/// Where a start is, for the POM's loader over the screen (`ui/runtime.json`).
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub step: Step,
    /// Set while this start installs something; `None` is a plain start.
    pub mode: Option<Mode>,
    /// Measured share of the step, 0..=1 (the archive bytes unpacked).
    pub done: f64,
    pub since: Instant,
}

impl Progress {
    pub fn new(step: Step, mode: Option<Mode>) -> Self {
        Self {
            step,
            mode,
            done: 0.0,
            since: Instant::now(),
        }
    }

    /// The installer bar: the unpack follows the archive bytes and stops at
    /// 99 until the launcher starts.
    pub fn percent(&self) -> u8 {
        match self.step {
            Step::Runtime => (self.done.clamp(0.0, 1.0) * 99.0).floor() as u8,
            Step::Launch => 100,
        }
    }

    fn to_json(&self) -> Value {
        let step = match self.step {
            Step::Runtime => "runtime",
            Step::Launch => "launch",
        };
        match self.mode {
            Some(mode) => json!({
                "status": "installing",
                "step": step,
                "mode": if mode == Mode::Update { "update" } else { "install" },
                "progress": self.percent(),
            }),
            None => json!({"status": "starting", "step": step}),
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
            .unwrap_or(Status::Unconfigured)
    }

    fn set_status(&self, generation: u64, status: Status) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }

    /// The measured share of the current step, from the worker of `generation`.
    fn set_done(&self, generation: u64, done: f64) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut current) = self.status.lock() {
            if let Status::Starting(progress) = &mut *current {
                progress.done = done;
            }
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
        self.start(gateway);
    }

    /// `rpc.retry`, the loader's "Try again": start again with the last
    /// configuration. False before the POM configured the plugin. A running
    /// harness is left alone: a retry never ends live sessions.
    pub fn retry(self: &Arc<Self>) -> bool {
        if matches!(self.status(), Status::Ready { .. }) {
            return true;
        }
        let gateway = self.gateway.lock().ok().and_then(|current| current.clone());
        match gateway {
            Some(gateway) => {
                self.start(gateway);
                true
            }
            None => false,
        }
    }

    fn start(self: &Arc<Self>, gateway: Gateway) {
        self.stop();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut status) = self.status.lock() {
            *status = Status::Starting(Progress::new(Step::Launch, None));
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
        reset_data_for_epoch(&base.join("data"), DATA_EPOCH)?;
        let root = base.join("runtime");
        self.set_status(
            generation,
            Status::Starting(Progress::new(
                Step::Runtime,
                install_mode(&root, self.checksum),
            )),
        );
        let runtime = unpack_runtime(&root, self.archive, self.checksum, &mut |done| {
            self.set_done(generation, done)
        })?;
        self.set_status(
            generation,
            Status::Starting(Progress::new(Step::Launch, None)),
        );
        let node = runtime
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut child = Command::new(&node)
            .arg(runtime.join("launcher.mjs"))
            .current_dir(&runtime)
            .env("HARNESS_POM_DATA_DIR", base.join("data"))
            .env("HARNESS_POM_LLM_BASE_URL", &gateway.openai_base_url)
            .env("HARNESS_POM_LLM_API_KEY", &gateway.api_key)
            .env(
                "HARNESS_POM_WORKSPACE_ROOT",
                gateway.workspace_root.as_deref().unwrap_or(""),
            )
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

/// `<dir of POM_PLUGIN_DB>/harness`, the data home the POM gives this plugin.
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

/// Start from an empty data directory when it was written by another data
/// epoch (or has no epoch, as before this marker existed), then record the
/// current one. Returns whether the directory was wiped.
pub fn reset_data_for_epoch(data: &Path, epoch: u32) -> Result<bool, String> {
    let marker = data.join(EPOCH_FILE);
    let current = fs::read_to_string(&marker)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    if current == Some(epoch) {
        return Ok(false);
    }
    let wiped = data.exists();
    if wiped {
        fs::remove_dir_all(data)
            .map_err(|error| format!("reset harness data {}: {error}", data.display()))?;
        eprintln!(
            "harness: data epoch {} -> {epoch}; starting from a clean installation",
            current.map_or_else(|| "none".to_owned(), |value| value.to_string())
        );
    }
    fs::create_dir_all(data).map_err(|error| format!("{}: {error}", data.display()))?;
    fs::write(&marker, format!("{epoch}\n"))
        .map_err(|error| format!("{}: {error}", marker.display()))?;
    Ok(wiped)
}

/// `None` when the runtime of `checksum` is already unpacked; otherwise
/// whether this start installs the plugin or replaces an older release.
pub fn install_mode(root: &Path, checksum: &str) -> Option<Mode> {
    if runtime_dir(root, checksum).join("launcher.mjs").is_file() {
        return None;
    }
    let older = fs::read_dir(root).ok().is_some_and(|entries| {
        entries
            .flatten()
            .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
    });
    Some(if older { Mode::Update } else { Mode::Install })
}

fn runtime_dir(root: &Path, checksum: &str) -> PathBuf {
    root.join(&checksum[..checksum.len().min(16)])
}

/// Reads the archive and reports the share of its bytes read so far.
struct Counting<'a, 'b> {
    archive: &'a [u8],
    read: usize,
    report: &'b mut dyn FnMut(f64),
}

impl Read for Counting<'_, '_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = (&self.archive[self.read..]).read(buffer)?;
        self.read += count;
        (self.report)(self.read as f64 / self.archive.len().max(1) as f64);
        Ok(count)
    }
}

/// Unpack once per archive checksum, atomically, and drop older runtimes.
/// `report` follows the share of the archive unpacked.
pub fn unpack_runtime(
    root: &Path,
    archive: &[u8],
    checksum: &str,
    report: &mut dyn FnMut(f64),
) -> Result<PathBuf, String> {
    let id = &checksum[..checksum.len().min(16)];
    let target = runtime_dir(root, checksum);
    if target.join("launcher.mjs").is_file() {
        return Ok(target);
    }
    fs::create_dir_all(root).map_err(|error| format!("{}: {error}", root.display()))?;
    let partial = root.join(format!(".{id}.partial"));
    let _ = fs::remove_dir_all(&partial);
    let mut unpacker = tar::Archive::new(flate2::read::GzDecoder::new(Counting {
        archive,
        read: 0,
        report,
    }));
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
    fn data_is_wiped_once_per_epoch_change() {
        let data = std::env::temp_dir().join(format!("harness-epoch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        fs::create_dir_all(data.join("home/.claude")).unwrap();
        fs::write(data.join("agents-choice.json"), "{}").unwrap();

        // Data written before the marker existed is reset.
        assert!(reset_data_for_epoch(&data, 2).unwrap());
        assert!(!data.join("agents-choice.json").exists());
        assert!(!data.join("home").exists());
        assert_eq!(fs::read_to_string(data.join(EPOCH_FILE)).unwrap(), "2\n");

        // Same epoch: kept.
        fs::write(data.join("agents-choice.json"), "{}").unwrap();
        assert!(!reset_data_for_epoch(&data, 2).unwrap());
        assert!(data.join("agents-choice.json").exists());

        // A bumped epoch starts clean again.
        assert!(reset_data_for_epoch(&data, 3).unwrap());
        assert!(!data.join("agents-choice.json").exists());
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn runtime_unpacks_once_per_checksum_and_replaces_older_ones() {
        let root = std::env::temp_dir().join(format!("harness-unpack-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = archive_with(&[("launcher.mjs", b"// one")]);
        assert_eq!(install_mode(&root, &"a".repeat(64)), Some(Mode::Install));
        let mut shares = Vec::new();
        let path = unpack_runtime(&root, &first, &"a".repeat(64), &mut |done| {
            shares.push(done)
        })
        .unwrap();
        assert_eq!(shares.last(), Some(&1.0));
        assert!(shares.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(fs::read(path.join("launcher.mjs")).unwrap(), b"// one");
        assert_eq!(install_mode(&root, &"a".repeat(64)), None);
        assert_eq!(
            unpack_runtime(&root, &[], &"a".repeat(64), &mut |_| {}).unwrap(),
            path
        );

        let second = archive_with(&[("launcher.mjs", b"// two")]);
        assert_eq!(install_mode(&root, &"b".repeat(64)), Some(Mode::Update));
        let next = unpack_runtime(&root, &second, &"b".repeat(64), &mut |_| {}).unwrap();
        assert_eq!(fs::read(next.join("launcher.mjs")).unwrap(), b"// two");
        assert!(!path.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn runtime_status_never_exposes_the_upstream_token() {
        assert_eq!(
            Status::Starting(Progress::new(Step::Launch, None)).to_json(),
            json!({"status": "starting", "step": "launch"})
        );
        let mut unpacking = Progress::new(Step::Runtime, Some(Mode::Update));
        unpacking.done = 0.5;
        assert_eq!(
            Status::Starting(unpacking).to_json(),
            json!({"status": "installing", "step": "runtime", "mode": "update", "progress": 49})
        );
        assert_eq!(
            Status::Starting(Progress::new(Step::Launch, None)).upstream_json(),
            json!({"status": "starting"})
        );
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
                api_key: "sk-1".into(),
                workspace_root: None,
            })
        );
        assert_eq!(
            Gateway::from_configure(&json!({
                "gateway": {"openai_base_url": "http://127.0.0.1:8080/v1", "api_key": "sk-1"},
                "workspace_root": "/tmp/projects"
            }))
            .unwrap()
            .workspace_root
            .as_deref(),
            Some("/tmp/projects")
        );
        assert!(Gateway::from_configure(&json!({
            "gateway": {"openai_base_url": "http://127.0.0.1:8080/v1", "api_key": "sk-1"},
            "workspace_root": 42
        }))
        .unwrap_err()
        .contains("workspace_root"));
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
