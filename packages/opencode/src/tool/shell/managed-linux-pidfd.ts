import { closeSync, constants, openSync, readFileSync, readlinkSync } from "node:fs"

interface Target {
  pid: number
  stat: string
  captureNamespace(pid: number): Target
  exited(): boolean
  kill(): void
  close(): void
}

/** Requires glibc's pidfd wrappers; no numeric-PID signalling fallback is safe here. */
export async function load() {
  const { dlopen, read } = await import("bun:ffi")
  const library = dlopen("libc.so.6", {
    pidfd_open: { args: ["i32", "u32"], returns: "i32" },
    pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
    mkfifo: { args: ["ptr", "u32"], returns: "i32" },
  })
  const errno = () => read.i32(library.symbols.__errno_location()!)
  // Fail before creating a sandbox on kernels/seccomp profiles without pidfd support.
  const self = library.symbols.pidfd_open(process.pid, 0)
  try {
    if (self < 0) throw new Error(`pidfd_open unavailable: errno ${errno()}`)
    if (library.symbols.pidfd_send_signal(self, 0, null, 0) !== 0)
      throw new Error(`pidfd_send_signal unavailable: errno ${errno()}`)
  } catch (error) {
    library.close()
    throw error
  } finally {
    if (self >= 0) closeSync(self)
  }
  function pin(pid: number, parent: () => { pid: number; stat: string }, parentNamespace?: string): Target {
    const directory = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY)
    const fd = library.symbols.pidfd_open(pid, 0)
    const identity = () => {
      const line = readFileSync(`/proc/self/fd/${directory}/stat`, "utf8")
      const fields = line.slice(line.lastIndexOf(")") + 2).split(" ")
      if (fields[0] === "Z" || fields[0] === "X") throw new Error("Process identity is no longer live")
      return { pid, ppid: Number(fields[1]), stat: fields[19]! }
    }
    try {
      if (fd < 0) throw new Error(`pidfd_open failed: errno ${errno()}`)
      if (library.symbols.pidfd_send_signal(fd, 0, null, 0) !== 0)
        throw new Error(`Namespace signal permission check failed: errno ${errno()}`)
      // A proc directory remains tied to its original task. If PID reuse occurred before
      // pidfd_open, this read fails instead of accepting the replacement task's identity.
      const expected = parent()
      const info = identity()
      if (info.ppid !== expected.pid || parent().stat !== expected.stat)
        throw new Error("Process parent identity mismatch")
      if (parentNamespace) {
        const status = readFileSync(`/proc/self/fd/${directory}/status`, "utf8")
        const pids = status
          .match(/^NSpid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/)
          .map(Number)
        if (
          !pids ||
          pids.length < 2 ||
          pids[0] !== pid ||
          pids.at(-1) !== 1 ||
          readlinkSync(`/proc/self/fd/${directory}/ns/pid`) === parentNamespace
        )
          throw new Error("Process is not init in a distinct PID namespace")
        if (identity().stat !== info.stat || parent().stat !== expected.stat)
          throw new Error("Namespace identity changed during capture")
      }
      const state = { closed: false }
      return {
        pid,
        stat: info.stat,
        captureNamespace(child: number) {
          if (state.closed) throw new Error("Closed parent pidfd")
          return pin(child, identity, readlinkSync(`/proc/self/fd/${directory}/ns/pid`))
        },
        exited() {
          if (state.closed) throw new Error("Closed namespace pidfd")
          try {
            const line = readFileSync(`/proc/self/fd/${directory}/stat`, "utf8")
            const fields = line.slice(line.lastIndexOf(")") + 2).split(" ")
            return fields[0] === "Z" || fields[0] === "X"
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "ENOENT" || code === "ESRCH") return true
            throw error
          }
        },
        kill() {
          if (state.closed) throw new Error("Closed namespace pidfd")
          if (library.symbols.pidfd_send_signal(fd, 9, null, 0) === 0) return
          const code = errno()
          if (code !== 3) throw new Error(`pidfd_send_signal failed: errno ${code}`)
        },
        close() {
          if (state.closed) return
          state.closed = true
          closeSync(fd)
          closeSync(directory)
        },
      }
    } catch (error) {
      if (fd >= 0) closeSync(fd)
      closeSync(directory)
      throw error
    }
  }
  return {
    monitor(pid: number) {
      return pin(pid, () => ({ pid: process.pid, stat: "self" }))
    },
    mkfifo(file: string) {
      if (library.symbols.mkfifo(Buffer.from(`${file}\0`), 0o600) !== 0)
        throw new Error(`mkfifo failed: errno ${errno()}`)
    },
    close: () => library.close(),
  }
}

export * as ManagedPidfd from "./managed-linux-pidfd"
