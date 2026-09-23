# POM Plugin - Pi Harness

A web terminal in the POM admin UI, the **Pi Harness** menu item and route (`/admin-ui/pi_harness/terminal`), attached to [herdr](https://herdr.dev) with a [pi](https://pi.dev) coding agent inside, already connected to the models the POM node serves.

This repository holds no herdr or pi code. Every build takes the official releases: the herdr binary from its GitHub release (checked against the SHA-256 digest GitHub publishes) and the prebuilt `@earendil-works/pi-coding-agent` package from npm (default dist-tag `latest`).

## How it works

```text
POM admin UI (/admin-ui/pi_harness/terminal)
  └─ plugin screen (ui/) ── xterm.js
        │  WebSocket on the POM's own origin, POM admin session
        ▼
  POM node  /api/ui/plugins/pi_harness/proxy/terminal   (admin-only plugin proxy)
        │  adds x-pom-plugin-token, strips POM credentials
        ▼
  launcher  127.0.0.1:<port>                            (runtime/launcher.mjs)
        │  one pseudo-terminal (node-pty) per browser tab, running the herdr client
        ▼
  herdr server (private session) ── "POM" workspace ── pi agent
        │  pi provider "pom" (models.json, key from $POM_API_KEY)
        ▼
  POM OpenAI-compatible endpoint  (handed over by the POM in host.configure)
```

- `src/` is the `cdylib` the POM loads (`pom_pi_harness_plugin_v1`). It embeds the UI and the runtime archive. Once the POM sends `host.configure` (its `/v1` URL and the node's API key), it unpacks the runtime under the plugin data directory and starts the launcher. It answers `ui.upstream` for the POM proxy and publishes `ui/runtime.json` for the screen, which carries neither the port nor the token.
- `runtime/launcher.mjs`:
  - **Private environment for herdr and pi.** `HOME` is under the plugin data directory, `PATH` starts with the bundled runtime, and nothing is copied from the POM environment except locale variables. An inherited `HERDR_SOCKET_PATH` or `HERDR_SESSION` would otherwise attach to a herdr session the host user runs.
  - **Short socket path.** The herdr socket path stays short enough for a Unix socket; long data paths fall back to `$TMPDIR/pom-pi-<hash>/`.
  - **herdr configuration.** Panes use a non-login bash, so the private `PATH` survives, and the first-run tour is skipped. herdr's pi integration is installed so herdr reports the agent's exact state.
  - **pi configuration.** pi's `models.json` gets a `pom` provider with the node's models, polled from `/v1/models` every 15 s; pi rereads it whenever `/model` opens. Providers the user adds are kept. pi's default model is set only while none is chosen, or when the chosen POM model disappears. The plugin's working folder is trusted in pi once, and a saved "do not trust" is kept.
  - **herdr and the agent.** The launcher starts `herdr server` and creates a "POM" workspace with a pi agent the first time; herdr restores it after restarts.
  - **Terminal endpoint.** It serves `/terminal` over WebSocket, only with the POM's token. Text frames are keystrokes, and `{"type":"resize","cols","rows"}` resizes the terminal.
- `ui/` holds the terminal screen (xterm.js with fit and web-links addons). Leaving the screen closes only the herdr client; the agent keeps running, and coming back reattaches.
- `scripts/fetch-runtime.sh` builds the runtime archive: a portable Node.js, the herdr binary, and `pi`, `node-pty` and `ws` from npm, installed on the target platform.

It requires a POM with the plugin proxy and `host.configure` (branch `feat/enterprise` of the `pom` repository, from commit `4848a9dd`). No change to the POM is needed beyond that.

## Build and verify

Requirements: Rust stable, Node.js 22.19+ or 24, npm, curl, jq.

```sh
cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
node --test tests/unit/*.test.mjs
scripts/package.sh --platform macos-aarch64 --version 0.1.0 [--pi-version latest|<version>] [--herdr-version latest|v0.9.1]
```

Build on the target platform: the npm install resolves native dependencies (`node-pty`, image tooling) for the machine it runs on. The packaged library is about 76 MB, and the unpacked runtime about 260 MB. On first start, pi downloads `fd` and `ripgrep` into its private agent directory, so the node needs internet access once.

## Releases

`.github/workflows/publish-release.yml` is the manual release flow from `pom-plugin-base`, plus `pi_version` and `herdr_version` inputs. Each selected platform installs those official releases, builds, and publishes to GitHub and optionally to the license server. `ci.yml` runs the checks on every push and pull request.

## End-to-end test

`tests/e2e/pom-stub.mjs` serves a real POM admin UI build and mirrors the node's plugin contract (UI assets, `host.configure`, the `/api/ui/plugins/:code/proxy/*` route). It uses the real `pom-plugin-host` loading the packaged library. `tests/e2e/mock-pom-llm.mjs` stands in for the POM model endpoint and, with `MOCK_LLM_API_KEY`, rejects requests without that key. `POST /__mock/models` changes its model list.

```sh
MOCK_LLM_PORT=18431 MOCK_LLM_API_KEY=sk-e2e node tests/e2e/mock-pom-llm.mjs &
env -i HOME=$HOME PATH=/usr/bin:/bin \
  POM_FRONTEND_DIST=<pom>/apps/frontend/dist POM_PLUGIN_HOST=<pom>/target/release/pom-plugin-host \
  POM_PLUGIN_LIBRARY=$PWD/dist-release/pom-plugin-pi-harness-macos-aarch64.dylib POM_STUB_PORT=18481 \
  POM_STUB_LLM_BASE_URL=http://127.0.0.1:18431/v1 POM_STUB_API_KEY=sk-e2e node tests/e2e/pom-stub.mjs
# open http://127.0.0.1:18481/admin-ui/pi_harness/terminal
```

## Known limitations

- **pi and anything it runs have the POM user's permissions** on the node. Access goes through the POM's admin-only proxy, but there is no sandbox beyond that user account.
- **pi loads context files from parent folders** of its working folder (`AGENTS.md`, `CLAUDE.md`). With the plugin data under a user's home directory, that user's own files are included.
- **Windows builds are wired but untested.** Panes there use herdr's default shell.
