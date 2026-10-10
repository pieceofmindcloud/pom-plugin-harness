---
name: pom-harness-browser-verify
description: "Use Chrome DevTools AXI to inspect and verify a web app in a real Chrome browser. Use after frontend/UI changes, or whenever a task needs browser navigation, interaction, screenshots, console/network inspection, or visual verification."
metadata:
  author: POM Harness
---

# Verify web work in Chrome

Use this skill to check the actual running app, not just the source code. The POM Harness provides a separate, isolated Chrome session for each agent; it does not attach to the user's personal browser profile.

Start with the pinned CLI help:

```sh
npx -y chrome-devtools-axi@@AXI_VERSION@ --help
```

For a local web app, open its URL and inspect the page:

```sh
npx -y chrome-devtools-axi@@AXI_VERSION@ open http://localhost:PORT
```

Follow the CLI's contextual next-step hints. If a hint starts with `chrome-devtools-axi`, run it as `npx -y chrome-devtools-axi@@AXI_VERSION@ ...`. Use fresh snapshots after interactions and verify the resulting state before saying the work is done. For ordinary web search or static content, prefer simpler tools instead of opening Chrome.
