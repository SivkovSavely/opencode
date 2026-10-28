# Managed Server Plugins

Set `OPENCODE_MANAGED_PROFILE=1` in the server process to restrict external server plugins. Set `OPENCODE_MANAGED_PLUGIN_ALLOWLIST` to a JSON array of exact plugin specifiers approved by the server administrator, for example:

```sh
OPENCODE_MANAGED_PROFILE=1 OPENCODE_MANAGED_PLUGIN_ALLOWLIST='["compression-plugin@1.2.3","file:///opt/opencode/plugins/compression.js"]' opencode serve
```

The default, invalid JSON, or a value other than an array of strings allows no external server plugins. Matching is exact, including package versions. Relative project paths are resolved to file URLs before matching; allowlist the resulting absolute file URL. All config origins, including project config and discovered local plugins, are subject to the same gate. Known `opencode-pty` identities and package manifests are rejected even when allowlisted. Built-in plugins and TUI plugins are not governed by this allowlist.

An allowlisted plugin and its dependencies execute with server privileges. Administrators must trust the plugin code, its dependencies, configuration options, and all writable paths involved, and should pin versions and protect files from project users. A trusted plugin can itself import or implement PTY behavior, alter process state, or otherwise bypass this policy. The allowlist is not a sandbox, content integrity check, or a restriction on other execution paths. Changes to the environment or allowlist do not unload already initialized plugins; configure them before starting the server.
