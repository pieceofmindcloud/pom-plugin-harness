# Shared workspace guide

The POM owns the user's shared project folder. It supplies the optional top-level `workspace_root` field when configuring this plugin:

```json
{
  "operation": "host.configure",
  "workspace_root": "/path/to/projects"
}
```

Harness does not prompt for or choose a folder. Its project listing reads only immediate child directories of this root, excludes hidden entries, and returns project names through the plugin proxy at `GET /projects`. A missing, inaccessible, or empty root is reported as a safe unavailable or empty state. No project contents are read.
