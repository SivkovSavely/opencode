import { isPathPluginSpec, parsePluginSpecifier } from "./shared"

export const QUEUE_PLUGIN_CONFLICT =
  "opencode-queue was skipped because native session queueing is active. Manually uninstall opencode-queue and remove it from your plugin configuration. Legacy queue storage is retained and imported lazily; restored work requires an explicit start or flush."

export function isLegacyQueuePlugin(spec: string, manifest?: Record<string, unknown>) {
  if (manifest?.name === "opencode-queue") return true
  if (parsePluginSpecifier(spec).pkg === "opencode-queue") return true
  if (/^(?:github:)?mirsella\/opencode-queue(?:#.*)?$/.test(spec)) return true
  if (
    /^(?:git\+)?(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)mirsella\/opencode-queue(?:\.git)?(?:#.*)?$/.test(
      spec,
    )
  )
    return true
  // Recognize named local copies, not arbitrary "queue" files or forks. Other
  // local checkout paths are identified by their exact package manifest name.
  return (
    isPathPluginSpec(spec) &&
    /(?:^|[\\/])opencode-queue(?:\.(?:ts|js|mjs|cjs)|[\\/](?:index\.(?:ts|js|mjs|cjs))?)?(?:[?#].*)?$/.test(spec)
  )
}
