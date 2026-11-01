import { realpath } from "node:fs/promises"
import path from "node:path"

const environment = process.env.OPENCODE_MANAGED_GIT

/** Operator input only. The sandbox independently validates the snapshot before each launch. */
export async function directory(workspace: string, raw = environment) {
  if (raw === undefined) return undefined
  const value: unknown = JSON.parse(raw)
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "directory,snapshot" ||
    !("directory" in value) ||
    typeof value.directory !== "string" ||
    !path.isAbsolute(value.directory) ||
    !("snapshot" in value) ||
    typeof value.snapshot !== "string" ||
    !path.isAbsolute(value.snapshot)
  )
    throw new Error("Invalid managed Git operator policy")
  if ((await realpath(value.directory)) !== (await realpath(workspace)))
    throw new Error("Managed Git snapshot is bound to another workspace")
  return realpath(value.snapshot)
}

export * as ManagedGit from "./managed-git"
