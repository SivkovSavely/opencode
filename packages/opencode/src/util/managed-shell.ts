export function requireUnmanagedShell() {
  if (process.env.OPENCODE_MANAGED_PROFILE !== "1") return
  throw new Error(
    "Shell command execution is unavailable in the managed profile: foreground validation requires descendant containment, which is not implemented.",
  )
}
