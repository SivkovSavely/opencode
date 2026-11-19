# Read-Only DCP Context

The existing Context tab includes saved DCP state in both V1 layouts. On narrow
screens, Context is also available beside Session and Changes. Existing context
usage, system prompt, raw messages, and export remain independent of DCP.

## Contract And Semantics

`GET /session/:sessionID/dcp` uses the ordinary authenticated session HTTP group.
It requires an existing session and validates every supplied directory/workspace
selector against that session before workspace proxying. Managed-workspace
restrictions remain in force. Remote workspace requests read the snapshot on the
session host, not on the origin server or in the browser. Responses are not cached.

`SessionDcpV1.Snapshot` in `packages/schema/src/v1/session-dcp.ts` is the shared,
browser-safe contract. Its `state` is `available`, `absent`, `invalid`, `too-large`,
or `unavailable`. An available snapshot contains only projected blocks, optional
saved metrics, and at most the latest 100 recorded operations. Unknown fields are
ignored; missing/corrupt individual metrics remain omitted, not synthesized as zero.
Legacy snapshots without an operation ledger explicitly show unrecorded history.

Active summary tokens sum saved, active, non-pruned summaries only when the ledger
is complete enough to establish the total. Historical gross removed tokens are
the plugin's saved counter, not an exact current net saving. Signed per-operation
estimates preserve negative values and zero. User recovery operations without
recorded savings do not invent an estimate. None of these values measures exact
live model context. A parent relationship alone does not imply nesting: inclusion
and consumption determine nested versus superseded status.

Summaries and persisted topics are plain text, never HTML or Markdown. Full
summaries mount only when their native disclosure opens. Polling uses the selected
session SDK, including its authentication, server URL, and platform transport.
There is at most one request in flight per selection. Selection changes clear the
old result synchronously and abort its request; late results cannot cross session,
workspace, or server boundaries. Refresh runs every 10 seconds after completion
only while Context is mounted and the document is visible. It does not update the
conversation store. New copy uses i18n keys and the existing English fallback;
locale-specific DCP terminology remains pending verified translations.

## Persistence Boundary

The session host reads `${XDG_DATA_HOME}/opencode/storage/plugin/dcp/<sessionID>.json`,
falling back to `${HOME}/.local/share` when `XDG_DATA_HOME` is empty or unset, matching
DCP's persistence convention independently of OpenCode database/profile paths.
No plugin state is created, repaired, or written. No dashboard server, token,
iframe, model-context hook, or external DCP source code is required.

IDs are restricted to a safe session-ID alphabet. Reads reject symlinks at every
path component, pin ancestor directory descriptors during traversal, reject
non-regular files, and bound file reads to 8 MiB. Size/mtime changes during a read
are rejected. This implementation uses Linux descriptor-relative `/proc/self/fd`
paths with `O_NOFOLLOW`; it fails closed as `unavailable` on other platforms rather
than use a race-prone `lstat` fallback. Symlinked data directories are deliberately
not followed. A platform-native race-safe equivalent is needed for other hosts.

## Porting To V2.2.5

The reference `personal-v2.2.5` was inspected read-only. Its built-in Context panel
lives in `packages/gui-plugins/src/context/tab.tsx`, registered by `renderer.tsx`
with both side and mobile placements. Port the section there and use the supplied
`MountedSession` and its actual server client, not a globally selected server.
Keep the plain-data schema independent of the UI, and move the read endpoint into
V2's authenticated Server/Protocol surface with session Location routing. Preserve
host-side file safeguards and scope checks; regenerate the V2 client from that API.

Do not assume an external GUI plugin already works in Web. In that reference,
`packages/app/src/runtime/plugin/root.tsx` always includes local built-ins, but
external GUI definitions and `PluginGuiLoader` require the desktop
`platform.plugins` bridge. A native built-in Context addition works within the Web
host; shipping this as an external Web GUI plugin would need a separate supported
loading mechanism. No V2 implementation or DCP algorithm changes are part of this
patch.
