# Development guide

Harness is a POM plugin that embeds the terminal UI and official agent runtime. The plugin manifest declares menu items, routes, screens, documentation, and assets; `src/lib.rs` and `src/supervisor.rs` implement the host ABI and runtime lifecycle.

When extending the plugin, preserve the POM-owned shared-workspace boundary described in [the workspace guide](guia-workspace.md). Keep plugin assets declared in `ui/manifest.json`, add native build support for new asset types, and test the contract in `tests/contract.rs` or `tests/unit/` as appropriate.

Run the verification commands in the repository README before packaging.
