import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { isRecord } from "@/util/record"
import type { Info } from "."

// Capture operator input before project configuration or plugins can change the environment.
export const enabled = process.env.OPENCODE_MANAGED_PROFILE === "1"
const policy = process.env.OPENCODE_MANAGED_SKILLS

export async function load(raw: string | undefined, directory: string, worktree: string): Promise<Info[]> {
  if (!raw) return []
  let entries: unknown
  try {
    entries = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(entries)) return []
  const roots = await Promise.all([directory, worktree].map((root) => fs.realpath(root)))
  const result: Info[] = []
  for (const [name, file] of Object.entries(entries)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || typeof file !== "string") continue
    if (!path.isAbsolute(file) || path.basename(file) !== "SKILL.md" || path.normalize(file) !== file) continue
    try {
      const canonical = await fs.realpath(file)
      if (canonical !== file) continue
      if (
        roots.some(
          (root) =>
            canonical === root ||
            (!path.relative(root, canonical).startsWith(".." + path.sep) &&
              !path.isAbsolute(path.relative(root, canonical))),
        )
      )
        continue
      // Reject replaceable path components, including symlinks and writable directories.
      let dir = path.dirname(file)
      while (true) {
        const stat = await fs.lstat(dir)
        if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0))
          throw new Error("unsafe directory")
        if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0))
          throw new Error("unsafe directory")
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 128 * 1024 ||
          (process.getuid && stat.uid !== process.getuid()) ||
          (stat.mode & 0o022) !== 0
        )
          continue
        const bytes = Buffer.alloc(stat.size + 1)
        const read = await handle.read(bytes, 0, bytes.length, 0)
        if (read.bytesRead !== stat.size) continue
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead))
        if (text.includes("\0")) continue
        const parsed = ConfigMarkdown.parse(text)
        if (
          !isRecord(parsed.data) ||
          parsed.data.name !== name ||
          (parsed.data.description !== undefined && typeof parsed.data.description !== "string")
        )
          continue
        result.push({ name, description: parsed.data.description, location: "<managed>", content: parsed.content })
      } finally {
        await handle.close()
      }
    } catch {
      // Invalid or inaccessible policy entries grant no access.
    }
  }
  return result
}

export function skills(directory: string, worktree: string) {
  return load(policy, directory, worktree)
}

export * as ManagedSkill from "./managed"
