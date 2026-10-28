import { isPathPluginSpec, parsePluginSpecifier } from "./shared"

export const MANAGED_PTY_CONFLICT = "opencode-pty was skipped by the managed server profile"
export const MANAGED_UNTRUSTED_PLUGIN = "Plugin was skipped because it is not in the managed server plugin allowlist"

export function isManagedPluginAllowed(spec: string) {
  try {
    const allowed: unknown = JSON.parse(process.env["OPENCODE_MANAGED_PLUGIN_ALLOWLIST"] ?? "[]")
    return Array.isArray(allowed) && allowed.every((item) => typeof item === "string") && allowed.includes(spec)
  } catch {
    return false
  }
}

export function isManagedPtyPlugin(spec: string, manifest?: Record<string, unknown>) {
  if (manifest?.name === "opencode-pty") return true
  if (parsePluginSpecifier(spec).pkg === "opencode-pty") return true
  if (/^(?:[^@/]+@)?npm:opencode-pty(?:@.*)?$/.test(spec)) return true
  if (/^(?:github:)?shekohex\/opencode-pty(?:#.*)?$/i.test(spec)) return true
  if (
    /^(?:git\+)?(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)shekohex\/opencode-pty(?:\.git)?(?:#.*)?$/i.test(
      spec,
    )
  )
    return true
  return (
    isPathPluginSpec(spec) &&
    /(?:^|[\\/])opencode-pty(?:\.(?:ts|js|mjs|cjs)|[\\/](?:index\.(?:ts|js|mjs|cjs))?)?(?:[?#].*)?$/.test(spec)
  )
}
