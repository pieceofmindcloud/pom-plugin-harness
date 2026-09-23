//! POM plugin that runs a pi coding agent inside herdr, in a web terminal in the POM.
//!
//! The library only supervises: it embeds the terminal UI and the runtime
//! archive, starts the runtime once the POM hands over its model
//! endpoint (`host.configure`), tells the POM where the terminal server is
//! (`ui.upstream`, for the node's plugin proxy), and publishes the runtime
//! status as the dynamic `ui/runtime.json` asset.

mod supervisor;

use supervisor::{Gateway, Supervisor};

use serde_json::{json, Value};
use std::ffi::{c_char, c_void};
use std::sync::Arc;

const ABI_VERSION: u32 = 1;
static VERSION: &[u8] = b"0.1.0\0";
const UI_MANIFEST: &str = include_str!("../ui/manifest.json");
/// Generated per request from the supervisor instead of embedded.
const RUNTIME_ASSET: &str = "ui/runtime.json";

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ByteSlice {
    pub ptr: *const u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ByteBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct HostCallbacks {
    pub log: Option<unsafe extern "C" fn(message: ByteSlice)>,
}

pub type PluginHandle = *mut c_void;
pub type CreateFn = unsafe extern "C" fn(HostCallbacks, ByteSlice) -> PluginHandle;
pub type IngestFn = unsafe extern "C" fn(PluginHandle, ByteSlice) -> i32;
pub type QueryFn = unsafe extern "C" fn(PluginHandle, ByteSlice) -> ByteBuffer;
pub type FreeBufferFn = unsafe extern "C" fn(ByteBuffer);
pub type ShutdownFn = unsafe extern "C" fn(PluginHandle);

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct PluginApiV1 {
    pub abi_version: u32,
    pub plugin_version: *const c_char,
    pub capabilities: u64,
    pub create: Option<CreateFn>,
    pub ingest: Option<IngestFn>,
    pub query: Option<QueryFn>,
    pub free_buffer: Option<FreeBufferFn>,
    pub shutdown: Option<ShutdownFn>,
}

unsafe impl Sync for PluginApiV1 {}

struct PluginState {
    supervisor: Arc<Supervisor>,
}

include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));

unsafe fn input_bytes<'a>(input: ByteSlice) -> Result<&'a [u8], String> {
    if input.len == 0 {
        return Ok(&[]);
    }
    if input.ptr.is_null() {
        return Err("null byte slice".into());
    }
    Ok(std::slice::from_raw_parts(input.ptr, input.len))
}

fn ui_asset(path: &str) -> Option<&'static (&'static str, &'static str, &'static [u8])> {
    UI_ASSETS.iter().find(|(name, _, _)| *name == path)
}

fn ui_manifest() -> Result<Value, String> {
    let manifest: Value = serde_json::from_str(UI_MANIFEST).map_err(|error| error.to_string())?;
    let assets = manifest["assets"]
        .as_array()
        .ok_or("manifest has no assets")?;
    for asset in assets.iter().filter_map(Value::as_str) {
        if asset != RUNTIME_ASSET && ui_asset(asset).is_none() {
            return Err(format!("asset is not embedded: {asset}"));
        }
    }
    Ok(manifest)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                output.push(TABLE[((value >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
    }
    output
}

fn query_inner(state: &PluginState, request: &[u8]) -> Result<Value, String> {
    let request: Value = serde_json::from_slice(request).map_err(|error| error.to_string())?;
    match request["operation"].as_str().unwrap_or_default() {
        "ui.manifest" => ui_manifest(),
        "host.configure" => {
            state
                .supervisor
                .configure(Gateway::from_configure(&request)?);
            Ok(json!({"status": "configured"}))
        }
        "ui.upstream" => Ok(state.supervisor.status().upstream_json()),
        "ui.asset" => {
            let path = request["path"].as_str().ok_or("asset path is missing")?;
            if path == RUNTIME_ASSET {
                let body = serde_json::to_vec(&state.supervisor.status().to_json())
                    .map_err(|error| error.to_string())?;
                return Ok(
                    json!({"content_type": "application/json", "base64": encode_base64(&body)}),
                );
            }
            let (_, content_type, bytes) = ui_asset(path).ok_or("unknown asset")?;
            Ok(json!({"content_type": content_type, "base64": encode_base64(bytes)}))
        }
        _ => Err("unknown operation".into()),
    }
}

fn buffer_from_bytes(bytes: Vec<u8>) -> ByteBuffer {
    let mut bytes = bytes.into_boxed_slice();
    let buffer = ByteBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
    };
    std::mem::forget(bytes);
    buffer
}

unsafe extern "C" fn create(_: HostCallbacks, config: ByteSlice) -> PluginHandle {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let config = input_bytes(config)?;
        if !config.is_empty() {
            serde_json::from_slice::<Value>(config).map_err(|error| error.to_string())?;
        }
        let supervisor = Supervisor::new(RUNTIME_ARCHIVE, RUNTIME_SHA256);
        Ok::<_, String>(Box::into_raw(Box::new(PluginState { supervisor })).cast::<c_void>())
    }));
    match result {
        Ok(Ok(handle)) => handle,
        _ => std::ptr::null_mut(),
    }
}

unsafe extern "C" fn ingest(handle: PluginHandle, event: ByteSlice) -> i32 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return false;
        }
        input_bytes(event).is_ok()
    }));
    matches!(result, Ok(true)).then_some(0).unwrap_or(-1)
}

unsafe extern "C" fn query(handle: PluginHandle, request: ByteSlice) -> ByteBuffer {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if handle.is_null() {
            return Err("plugin handle is null".to_owned());
        }
        let state = &*handle.cast::<PluginState>();
        query_inner(state, input_bytes(request)?)
            .and_then(|value| serde_json::to_vec(&value).map_err(|error| error.to_string()))
    }));
    match result {
        Ok(Ok(bytes)) => buffer_from_bytes(bytes),
        _ => ByteBuffer {
            ptr: std::ptr::null_mut(),
            len: 0,
        },
    }
}

unsafe extern "C" fn free_buffer(buffer: ByteBuffer) {
    if !buffer.ptr.is_null() {
        let slice = std::ptr::slice_from_raw_parts_mut(buffer.ptr, buffer.len);
        drop(Box::from_raw(slice));
    }
}

unsafe extern "C" fn shutdown(handle: PluginHandle) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !handle.is_null() {
            let state = Box::from_raw(handle.cast::<PluginState>());
            state.supervisor.stop();
        }
    }));
}

static API: PluginApiV1 = PluginApiV1 {
    abi_version: ABI_VERSION,
    plugin_version: VERSION.as_ptr().cast(),
    capabilities: 0,
    create: Some(create),
    ingest: Some(ingest),
    query: Some(query),
    free_buffer: Some(free_buffer),
    shutdown: Some(shutdown),
};

/// Entry point the POM plugin host resolves as `pom_<plugin_code>_plugin_v1`.
///
/// # Safety
///
/// The returned table is static; the host must call its functions only as the
/// v1 plugin ABI specifies.
#[no_mangle]
pub unsafe extern "C" fn pom_pi_harness_plugin_v1() -> *const PluginApiV1 {
    &API
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_exposes_the_generic_v1_boundary() {
        let api = unsafe { &*pom_pi_harness_plugin_v1() };
        assert_eq!(api.abi_version, ABI_VERSION);
        assert_eq!(api.capabilities, 0);
        assert!(api.create.is_some());
        assert!(api.ingest.is_some());
        assert!(api.query.is_some());
        assert!(api.free_buffer.is_some());
        assert!(api.shutdown.is_some());
    }

    #[test]
    fn buffer_encoding_uses_standard_padding() {
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn manifest_resolves_all_built_assets() {
        let manifest: Value = serde_json::from_str(UI_MANIFEST).unwrap();
        if ui_asset("ui/screens.js").is_some() {
            assert!(ui_manifest().is_ok());
            for asset in manifest["assets"].as_array().unwrap() {
                let asset = asset.as_str().unwrap();
                assert!(asset == RUNTIME_ASSET || ui_asset(asset).is_some());
            }
        } else {
            assert!(ui_manifest().is_err());
        }
    }
}
