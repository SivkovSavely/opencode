import { dlopen } from "bun:ffi"
import { closeSync, constants, openSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { ManagedLinux } from "../../../src/tool/shell/managed-linux"

const root = process.argv[2]!
const mode = process.argv[3]!
const workspace = `${root}/workspace`
await mkdir(workspace)
const native = dlopen("libc.so.6", {
  pidfd_open: { args: ["i32", "u32"], returns: "i32" },
  pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
})
const handle = await ManagedLinux.prepare({
  workspace,
  argv: ["touch", "escaped"],
  timeoutMs: mode === "timeout" ? 1500 : 10_000,
  cleanupMs: 1000,
})
const running = handle.start()
const state: { monitor?: number; fd?: number; pids: number[] } = { pids: [] }
try {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline && state.fd === undefined) {
    state.monitor ??= readdirSync("/proc")
      .filter((pid) => /^\d+$/.test(pid))
      .map(Number)
      .find((pid) => {
        const cmd = text(`/proc/${pid}/cmdline`).split("\0")
        return cmd[0] === "/usr/bin/bwrap" && cmd.some((arg) => arg.startsWith(`${root}/opencode-managed-wait-`))
      })
    if (state.monitor) {
      const pids = descendants(state.monitor)
      const worker = pids.find((pid) =>
        text(`/proc/${pid}/cmdline`)
          .split("\0")
          .some((arg) => arg.endsWith("/cc1")),
      )
      if (worker) {
        const directory = openSync(`/proc/${worker}`, constants.O_RDONLY | constants.O_DIRECTORY)
        const fd = native.symbols.pidfd_open(worker, 0)
        try {
          if (fd < 0) throw new Error("Cannot pin real compiler worker")
          const stat = text(`/proc/self/fd/${directory}/stat`)
          if (!stat || /\) [ZX] /.test(stat)) throw new Error("Compiler worker exited before stop")
          if (native.symbols.pidfd_send_signal(fd, 19, null, 0) !== 0)
            throw new Error("Cannot stop real compiler worker")
          state.fd = fd
          state.pids = [state.monitor, ...pids]
        } finally {
          closeSync(directory)
          if (state.fd !== fd && fd >= 0) closeSync(fd)
        }
        while (!/\) T /.test(text(`/proc/${worker}/stat`))) {
          if (performance.now() > deadline) throw new Error("Compiler did not stop")
          await Bun.sleep(1)
        }
      }
    }
    await Bun.sleep(1)
  }
  if (state.fd === undefined || state.pids.length < 4)
    throw new Error("Did not stop a real GCC worker with its namespace ancestry")
  const before = performance.now()
  if (mode === "cancel") handle.cancel()
  if (mode === "gate-inside") {
    // Helper provisioning validated the old TMPDIR; gate provisioning must recheck it.
    process.env.TMPDIR = workspace
    if (native.symbols.pidfd_send_signal(state.fd, 18, null, 0) !== 0) throw new Error("Cannot resume compiler worker")
  }
  const result = await running
  if (result.reason !== (mode === "cancel" ? "cancelled" : mode === "timeout" ? "timeout" : "setup-failed"))
    throw new Error(`Unexpected result: ${JSON.stringify(result)}`)
  if (result.cleanup !== "confirmed") throw new Error(`Unconfirmed cleanup: ${JSON.stringify(result)}`)
  if (
    mode === "gate-inside" &&
    !result.stderr.toString().includes("Managed gate directory must be outside the workspace")
  )
    throw new Error("Gate boundary was not enforced independently")
  if (performance.now() - before > 2500) throw new Error("Stalled compiler was not terminated promptly")
  if (
    state.pids.some((pid) => {
      const stat = text(`/proc/${pid}/stat`)
      return stat && !/\) [ZX] /.test(stat)
    })
  )
    throw new Error("A real compiler namespace task survived cleanup")
  if ((await readdir(root)).some((entry) => entry.startsWith("opencode-managed-")))
    throw new Error("Stale compiler artifacts")
  if ((await readdir(workspace)).length) throw new Error("Workspace contains gate artifacts or executed user code")
  console.log(JSON.stringify({ reason: result.reason, tasks: state.pids.length, elapsed: performance.now() - before }))
} finally {
  await handle[Symbol.asyncDispose]()
  if (state.fd !== undefined) closeSync(state.fd)
  native.close()
}

function text(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

function descendants(pid: number): number[] {
  return text(`/proc/${pid}/task/${pid}/children`)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .flatMap((child) => [child, ...descendants(child)])
}
