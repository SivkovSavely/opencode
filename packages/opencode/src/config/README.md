# Runtime configuration reload (V1)

Use **Reload configuration** in the Web command palette under **System**, or
send an authenticated `POST /global/config/reload` to the selected server.
The response is `true` only after the operation completes. This is manual:
editing a file does not automatically reload configuration.

Reload covers the global configuration and every currently loaded project
directory in that server, including supported file, directory, inline, managed,
and remote configuration overrides. Cached agents and Markdown prompts,
providers/models/options/variants, commands, skills, custom tool discovery,
formatter definitions, and MCP definitions/resources are refreshed. Removed
definitions disappear too. Directories loaded later read the new configuration.

The server process, listener, project contexts, session history, tabs, and
execution owners are not replaced. All connected Web clients receive a
`config.reloaded` event and refresh configuration-dependent data without
reloading transcripts or remounting composers.

## Safety and errors

Reload is serialized with other reloads, instance loading/disposal, and global
configuration updates. It returns HTTP 409 while affected requests, model/tool
execution, retries, background work, or MCP authorization are active. Admission
is held closed throughout reload, not checked once and then left open. Retry the
operation after work finishes; reload never cancels or parks that work.

Configuration and replacement caches are staged before publication. HTTP 400
identifies invalid configuration by source and, where available, field path;
HTTP 500 reports an internal failure without rendering configuration values.
Failed preparation leaves the previous working caches active. Correct the files
and reload again. A global configuration PATCH uses the same guarded path;
its file edit remains on disk if later project validation fails, but its previous
runtime configuration stays active until a successful reload.

MCP uses its existing connection lifecycle. Pending authorization blocks reload.
Replacement connections are prepared before retiring old clients, so a server
that permits only one connection may report a failed connection. As with initial
startup, an unavailable MCP server is represented by its MCP status: successful
configuration reload does not guarantee that every MCP server connected.
Preparation isolates OAuth credentials by exact server URL and does not rotate
refresh tokens. If a connection requires refreshed credentials, it may report
`needs_auth`; reconnect or authenticate through the usual MCP operation afterward.

Versioned remote skills use immutable source/version cache directories, so failed
reloads cannot replace resources referenced by the previous configuration. Earlier
versions are retained. Remote publishers must bump the index version to refresh
already downloaded files; unversioned downloads keep their existing cache behavior.

## Limits

Executable plugin modules, their hooks, and provider authorization flows remain
loaded. Changes to plugin source, plugin lists, or plugin initialization settings
require a restart; Bun's dynamic import cache prevents a reliable promise of hot
replacement. Configuration edits made by already loaded plugin hooks are retained
and reapplied without rerunning those hooks. Plugin model catalogs and provider
authentication-loader resources are retained too; fresh configuration overlays
them without reinitializing their transports. Custom tool source modules have
the same import-cache limitation.
Existing LSP processes and sharing subscriptions are retained rather than torn
down. Settings captured by those lifecycles require their normal reinitialization
or a restart. Snapshot and other services that read configuration per operation
pick up changes through the refreshed Config cache without losing their state.

Server startup flags, environment captured at startup, and network listener
settings are outside runtime reload scope. Reload does not install new executable
dependencies or migrate configuration files.

After migration to upstream V2.2.5, use its existing `POST /api/location/reload`
and `LocationServiceMap.reload()` instead of carrying this V1 cache mechanism
forward. The Web operation is isolated at the selected server's request boundary.
No V2 reload endpoint or automatic configuration watcher is added here.
