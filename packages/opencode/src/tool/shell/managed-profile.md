# Managed profile shell commands

When `OPENCODE_MANAGED_PROFILE=1`, the shell tool, session shell commands, and
shell expansions in command templates are rejected before execution. Safe
descendant containment is not implemented, so foreground command validation
is unavailable in this mode. This restriction does not establish containment
or full managed-profile support for other process-launching features.
