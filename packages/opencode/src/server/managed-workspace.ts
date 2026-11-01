import { realpathSync, statSync } from "node:fs"
import path from "node:path"

export const profile = process.env.OPENCODE_MANAGED_PROFILE === "1"
const configured = profile ? process.env.OPENCODE_MANAGED_WORKSPACE : undefined

export const directory = (() => {
  if (configured === undefined) return undefined
  if (!path.isAbsolute(configured)) throw new Error("OPENCODE_MANAGED_WORKSPACE must be an absolute directory")
  try {
    const resolved = realpathSync(configured)
    if (resolved === configured && statSync(resolved).isDirectory()) return resolved
  } catch {
    // Invalid and inaccessible paths both fail closed at startup.
  }
  throw new Error("OPENCODE_MANAGED_WORKSPACE must be a canonical existing directory")
})()

export function allows(input: string) {
  if (!directory) return true
  try {
    return realpathSync(path.resolve(input)) === directory
  } catch {
    return false
  }
}

export * as ManagedWorkspace from "./managed-workspace"
