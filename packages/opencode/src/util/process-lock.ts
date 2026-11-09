import { createHash } from "node:crypto"
import { chmod, lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { Global } from "@opencode-ai/core/global"

type Options = { directory?: string; timeoutMs?: number; signal?: AbortSignal }

export async function acquireProcessLock(key: string, options: Options = {}) {
  options.signal?.throwIfAborted()
  const directory = options.directory ?? path.join(Global.Path.state, "process-locks")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) throw new Error("Operation locks require a private directory")
  await chmod(directory, 0o700)
  const file = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.lock.sqlite`)
  await lstat(file).then(
    (info) => {
      if (!info.isFile()) throw new Error("Operation lock must be a regular file")
    },
    (error: unknown) => {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return
      throw error
    },
  )
  const { Database } = await import("bun:sqlite")
  // SQLite must own every descriptor for this inode: closing an independent
  // descriptor would release the process's POSIX locks held by another caller.
  const database = new Database(file, { create: true })
  try {
    await chmod(file, 0o600)
    database.exec("PRAGMA busy_timeout = 0")
    const started = performance.now()
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        // A RESERVED OS lock cannot expire while its owner is paused. SQLite
        // releases it on process exit, without changing the production database.
        database.exec("BEGIN IMMEDIATE")
        break
      } catch (error) {
        if (typeof error !== "object" || !error || !("code" in error) || error.code !== "SQLITE_BUSY") throw error
      }
      if (performance.now() - started >= (options.timeoutMs ?? 300_000))
        throw new Error("Timed out waiting for private operation lock")
      await setTimeout(25, undefined, { signal: options.signal })
    }
    options.signal?.throwIfAborted()
  } catch (error) {
    database.close()
    throw error
  }
  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      database.exec("ROLLBACK")
    } finally {
      database.close()
    }
  }
  return { release, [Symbol.asyncDispose]: release }
}

export async function withProcessLock<T>(key: string, run: () => Promise<T>, options: Options = {}) {
  await using lock = await acquireProcessLock(key, options)
  options.signal?.throwIfAborted()
  return await run()
}
