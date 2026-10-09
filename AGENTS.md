# Project agent memory

- This plugin is a shell around the official herdr GitHub release, the `@earendil-works/pi-coding-agent` npm release and, on first use, the pinned Claude Code, Codex, opencode and free-claude-code releases (`agents.json`); never vendor their source. `README.md` has the architecture, verification and known limitations.
- Agent configs are shared with the user: only write plugin-owned entries (the `pom` provider, FCC's connection keys, defaults while unset) and keep every other line. Helpers for them are pure and unit tested in `runtime/agents.mjs`.
- Every agent needs the POM's per-model `context_length`/`max_tokens`; check what a new agent or FCC version reads (its source, or the mock's `GET /__mock/requests`) instead of assuming.
- The POM owns the model endpoint, the API key (`host.configure`) and browser access (its admin-only `/api/ui/plugins/:code/proxy/*` route, reached through `ui.upstream`); the node side lives in the `pom` repository. Never add an env var or build input for them here.
- herdr and pi must only ever see `privateEnv` in `runtime/launcher.mjs`. When testing by hand from a shell inside a herdr pane, the inherited `HERDR_SOCKET_PATH`/`HERDR_SESSION` point at the user's own herdr session: always run herdr commands with `env -i` and an explicit socket.
- `DATA_EPOCH` in `src/supervisor.rs` decides when a new release wipes the plugin `data/` and reinstalls from zero; bump it only when that is intended.
- The plugin host uses its own stdin/stdout for IPC: processes the library starts must never inherit them (`src/supervisor.rs`).
- `scripts/build.sh` runs `scripts/fetch-runtime.sh` and passes `HARNESS_RUNTIME_ARCHIVE` to cargo; without it the library builds but reports that no runtime is bundled.
- The POM's local development rebuild runs the `development.rebuild` steps of `ui/manifest.json` (`scripts/dev-ui.sh`, `scripts/dev-runtime.sh`) with the source read-only: they write to `POM_PLUGIN_OUT_DIR`, and `build.rs` takes the UI and the runtime archive from there. `dev-runtime.sh` repacks `build/runtime-<platform>` with this source's runtime scripts, so `scripts/fetch-runtime.sh` must have run once on that machine.
- Checks: `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `node --test tests/unit/*.test.mjs` (Node 22 needs `--experimental-strip-types`). When `cargo` resolves to a wrapper, use `~/.cargo/bin/cargo`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project. Do not repeat what the codebase already shows; point to the authoritative file or command instead. Prefer rewriting or pruning existing entries over appending new ones. When updating this file, preserve this bar for all agents and keep entries concise.
