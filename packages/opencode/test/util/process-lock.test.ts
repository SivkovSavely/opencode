import { expect, spyOn, test } from "bun:test"
import { open, readdir, stat, utimes, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { acquireProcessLock, withProcessLock } from "../../src/util/process-lock"
import { tmpdir } from "../fixture/fixture"

test("initialization cannot release another caller's cross-process lock", async () => {
  await using tmp = await tmpdir()
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const handle = await open(path.join(tmp.path, "probe"), "wx", 0o600)
  const prototype: Pick<FileHandle, "close"> = Object.getPrototypeOf(handle)
  const close = prototype.close
  await handle.close()
  const spy = spyOn(prototype, "close").mockImplementationOnce(async function (this: FileHandle) {
    closing.resolve()
    await release.promise
    await close.call(this)
    closed.resolve()
  })
  const options = { directory: tmp.path, timeoutMs: 1000 }
  const first = acquireProcessLock("synthetic-initialization", options)
  try {
    // Old initialization leaves a raw descriptor open while a second caller locks
    // the inode. Closing that descriptor must not unlock the second caller.
    const ready = await Promise.race([
      first.then((lock) => ({ lock })),
      closing.promise.then(() => ({ lock: undefined })),
    ])
    const owner = ready.lock ?? (await acquireProcessLock("synthetic-initialization", options))
    try {
      release.resolve()
      if (!ready.lock) await closed.promise
      const worker = Bun.spawn({
        cmd: [
          process.execPath,
          "--eval",
          `import { acquireProcessLock } from ${JSON.stringify(new URL("../../src/util/process-lock.ts", import.meta.url).href)};
          try {
            await using lock = await acquireProcessLock("synthetic-initialization", { directory: ${JSON.stringify(tmp.path)}, timeoutMs: 0 });
            console.log("acquired");
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("Timed out")) throw error;
            console.log("blocked");
          }`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
        worker.exited,
      ])
      expect(stderr).toBe("")
      expect(exit).toBe(0)
      expect(stdout.trim()).toBe("blocked")
    } finally {
      await owner.release()
    }
  } finally {
    release.resolve()
    try {
      await (await first).release()
    } finally {
      spy.mockRestore()
    }
  }
})

test("a paused owner cannot be evicted by aging its lock file", async () => {
  await using tmp = await tmpdir()
  const options = { directory: tmp.path, timeoutMs: 30 }
  const first = await acquireProcessLock("synthetic-lock", options)
  try {
    const files = (await readdir(tmp.path)).filter((file) => file.endsWith(".lock.sqlite"))
    expect(files).toHaveLength(1)
    const file = path.join(tmp.path, files[0]!)
    const old = new Date(Date.now() - 120_000)
    await utimes(file, old, old)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    for (const entry of await readdir(tmp.path))
      expect((await stat(path.join(tmp.path, entry))).mode & 0o777).toBe(0o600)
    expect((await stat(tmp.path)).mode & 0o777).toBe(0o700)
    let entered = false
    await expect(
      withProcessLock(
        "synthetic-lock",
        async () => {
          entered = true
        },
        options,
      ),
    ).rejects.toThrow(/Timed out/)
    expect(entered).toBe(false)
  } finally {
    await first.release()
  }
  expect(await withProcessLock("synthetic-lock", async () => "reacquired", options)).toBe("reacquired")
})

test("aborting a contender leaves the owner's lock intact", async () => {
  await using tmp = await tmpdir()
  await using first = await acquireProcessLock("synthetic-lock", { directory: tmp.path })
  const controller = new AbortController()
  const second = acquireProcessLock("synthetic-lock", { directory: tmp.path, signal: controller.signal })
  controller.abort(new Error("synthetic cancellation"))
  await expect(second).rejects.toThrow("synthetic cancellation")
  await expect(acquireProcessLock("synthetic-lock", { directory: tmp.path, timeoutMs: 30 })).rejects.toThrow(
    /Timed out/,
  )
})

test("throws release the OS lock without committing any application state", async () => {
  await using tmp = await tmpdir()
  const options = { directory: tmp.path, timeoutMs: 30 }
  await expect(
    withProcessLock(
      "synthetic-lock",
      async () => {
        throw new Error("synthetic failure")
      },
      options,
    ),
  ).rejects.toThrow("synthetic failure")
  expect(await withProcessLock("synthetic-lock", async () => true, options)).toBe(true)
})
