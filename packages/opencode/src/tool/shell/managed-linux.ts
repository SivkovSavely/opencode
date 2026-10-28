import { spawn } from "node:child_process"
import { closeSync, constants, openSync, writeSync } from "node:fs"
import { lstat, mkdtemp, readdir, realpath, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { ManagedPidfd } from "./managed-linux-pidfd"
import { ManagedWait } from "./managed-linux-wait"

export interface Options {
  /** Exclusively delegated, socket-free directory; mounted writable at /work. */
  workspace: string
  /** A single installed Rust toolchain, not ~/.rustup or the home directory. */
  rustToolchain?: string
  argv: readonly [string, ...string[]]
  timeoutMs: number
  outputBytes?: number
  cleanupMs?: number
  /**
   * Trusted ownership fence. Call open synchronously only after all admission checks succeed.
   * Publishing is irreversible: rejecting after open kills/joins but cannot undo user code.
   */
  authorize?: (open: () => void) => Promise<boolean>
}

export interface Result {
  reason: "exit" | "cancelled" | "timeout" | "setup-failed"
  /** Bubblewrap JSON exit-code; 128+n is ambiguous with an explicit exit. Null if unreported. */
  shellStatus: number | null
  /** Actual direct-child exit code, never a shell-style signal encoding. */
  exitCode: number | null
  /** Actual Linux signal number from waitpid, never inferred from shellStatus. */
  signal: number | null
  termination:
    | { kind: "unreported" }
    | { kind: "exit"; exitCode: number }
    | { kind: "signal"; signal: number; coreDumped: boolean }
    | { kind: "exec-error"; exitCode: 127; errno: number }
  supervisorSignal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
  cleanup: "confirmed" | "failed"
  cleanupError?: string
}

/** No process exists until startPaused()/start(). See managed-linux.md for the admission contract. */
export async function prepare(options: Options) {
  if (process.platform !== "linux") throw new Error("Managed commands require Linux")
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2 ** 31 - 1)
    throw new Error("timeoutMs must be a finite positive timer interval")
  const budget = options.outputBytes ?? 1024 * 1024
  const timeoutMs = options.timeoutMs
  const cleanupMs = options.cleanupMs ?? 10_000
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 16 * 1024 * 1024)
    throw new Error("outputBytes must be between 0 and 16777216")
  if (!Number.isSafeInteger(cleanupMs) || cleanupMs <= 0 || cleanupMs > 2 ** 31 - 1)
    throw new Error("cleanupMs must be a finite positive timer interval")
  if (!options.argv.length || options.argv.some((x) => x.includes("\0"))) throw new Error("Invalid argv")
  const workspace = await realpath(options.workspace)
  const home = await realpath(process.env.HOME ?? "/")
  if (
    workspace === "/" ||
    workspace === home ||
    home.startsWith(`${workspace}/`) ||
    ["/usr", "/etc", "/run", "/var", "/proc", "/sys", "/dev", "/boot"].some(
      (x) => workspace === x || workspace.startsWith(`${x}/`),
    )
  )
    throw new Error("Refusing to mount root or home")
  await requireTree(workspace, true)
  const toolchain = options.rustToolchain ? await realpath(options.rustToolchain) : undefined
  if (toolchain) {
    if (toolchain === workspace || toolchain.startsWith(`${workspace}/`) || workspace.startsWith(`${toolchain}/`))
      throw new Error("Workspace and toolchain must not overlap")
    if (
      toolchain === "/" ||
      toolchain === home ||
      home.startsWith(`${toolchain}/`) ||
      !(await Bun.file(path.join(toolchain, "bin/rustc")).exists()) ||
      !(await lstat(path.join(toolchain, "lib/rustlib"))).isDirectory()
    )
      throw new Error("Not a Rust toolchain")
    await requireTree(toolchain)
  }
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--disable-userns",
    "--assert-userns-disabled",
    "--cap-drop",
    "ALL",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr/bin",
    "/usr/bin",
    "--ro-bind",
    "/usr/lib",
    "/usr/lib",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home/sandbox",
    "--dir",
    "/run",
    "--bind",
    workspace,
    "/work",
    "--chdir",
    "/work",
    "--setenv",
    "HOME",
    "/home/sandbox",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "CARGO_HOME",
    "/home/sandbox/.cargo",
    "--setenv",
    "CARGO_NET_OFFLINE",
    "true",
    "--setenv",
    "PATH",
    toolchain ? "/toolchain/bin:/usr/bin" : "/usr/bin",
    ...(toolchain ? ["--ro-bind", toolchain, "/toolchain"] : []),
    "--json-status-fd",
    "3",
  ]
  const state: {
    reason: Result["reason"]
    result?: Promise<Result>
    started?: Promise<Result>
    stop?: () => void
    permit?: () => boolean
    phase: "prepared" | "launching" | "ready" | "authorized" | "stopping" | "completed"
  } = { reason: "exit", phase: "prepared" }
  const ready = Promise.withResolvers<boolean>()
  const acknowledged = Promise.withResolvers<boolean>()
  const authorize = () => state.permit?.() ?? false
  const cancel = () => {
    if (state.reason === "exit") state.reason = "cancelled"
    state.stop?.()
    launch()
    return state.result!
  }
  const launch = () => {
    if (state.result) return
    if (state.reason === "cancelled") {
      state.phase = "completed"
      ready.resolve(false)
      acknowledged.resolve(false)
      state.result = Promise.resolve({
        reason: "cancelled",
        shellStatus: null,
        exitCode: null,
        signal: null,
        termination: { kind: "unreported" },
        supervisorSignal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        truncated: false,
        cleanup: "confirmed",
      })
      return
    }
    state.phase = "launching"
    state.result = run(performance.now() + timeoutMs)
  }
  const startPaused = () => {
    launch()
    return ready.promise
  }
  const start = () => {
    if (state.started) return state.started
    state.started = (async () => {
      if (!(await startPaused()) || state.reason !== "exit") return state.result!
      if (!options.authorize) {
        authorize()
        return state.result!
      }
      const admission = { active: true, opened: false }
      try {
        const allowed = await Promise.race([
          options.authorize(() => {
            if (!admission.active || !authorize()) throw new Error("Managed command authorization is no longer valid")
            admission.opened = true
          }),
          // Cancellation/timeout must not wait for a stalled database or permit a late open.
          state.result!.then(() => false),
        ])
        admission.active = false
        if (!allowed || !admission.opened) return cancel()
        return state.result!
      } catch (error) {
        admission.active = false
        await cancel()
        throw error
      }
    })()
    return state.started
  }
  async function run(expires: number): Promise<Result> {
    const provision = await ManagedPidfd.load()
      .then(async (native) => {
        try {
          const waiter = await ManagedWait.create(workspace, native, () => {
            if (state.reason !== "exit" || performance.now() >= expires)
              throw new Error("Managed command preparation was cancelled")
          })
          try {
            return { gate: await createGate(), native, waiter, error: undefined }
          } catch (error) {
            await waiter.close()
            throw error
          }
        } catch (error) {
          native.close()
          throw error
        }
      })
      .catch((error: unknown) => ({ gate: undefined, native: undefined, waiter: undefined, error: String(error) }))
    if (state.reason === "exit" && performance.now() >= expires) state.reason = "timeout"
    if (!provision.gate || state.reason !== "exit") {
      if (provision.gate) {
        closeSync(provision.gate.read)
        provision.gate.close()
        await provision.waiter.close()
        provision.native.close()
      }
      state.phase = "completed"
      ready.resolve(false)
      acknowledged.resolve(false)
      return {
        reason: state.reason === "exit" ? "setup-failed" : state.reason,
        shellStatus: null,
        exitCode: null,
        signal: null,
        termination: { kind: "unreported" },
        supervisorSignal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(provision.error ?? "").subarray(0, budget),
        truncated: Buffer.byteLength(provision.error ?? "") > budget,
        cleanup: "confirmed",
      }
    }
    const gate = provision.gate
    const native = provision.native
    const waiter = provision.waiter
    // No inherited stdin, sockets, environment, or caller-supplied extra descriptors.
    const child = spawn(
      "/usr/bin/bwrap",
      [
        ...args,
        "--ro-bind",
        waiter.file,
        "/managed-wait",
        "--bind",
        waiter.control,
        "/run/managed",
        "--",
        "/managed-wait",
        ...options.argv,
      ],
      { env: {}, stdio: [gate.read, "pipe", "pipe", "pipe"] },
    )
    closeSync(gate.read)
    const status = child.stdio[3] as Readable
    const output: { stdout: Buffer[]; stderr: Buffer[]; bytes: number; truncated: boolean } = {
      stdout: [],
      stderr: [],
      bytes: 0,
      truncated: false,
    }
    const identity: {
      pid?: number
      stat?: string
      target?: ReturnType<typeof native.monitor>
      error?: string
      shellStatus?: number
      termination?: Exclude<Result["termination"], { kind: "unreported" }>
    } = {}
    const stopped: { value: boolean; timer?: ReturnType<typeof setTimeout> } = { value: false }
    const closeGate = () => {
      try {
        gate.close()
      } catch (error) {
        identity.error = String(error)
      }
    }
    const kill = () => {
      stopped.value = true
      state.phase = "stopping"
      closeGate()
      // Let bwrap publish init's identity before killing its monitor. Otherwise init
      // can survive a monitor death before installing PR_SET_PDEATHSIG.
      if (!identity.target) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
        stopped.timer ??= setTimeout(() => child.kill("SIGKILL"), cleanupMs)
        return
      }
      clearTimeout(stopped.timer)
      try {
        identity.target?.kill()
      } catch (error) {
        identity.error = String(error)
      }
      child.kill("SIGKILL")
    }
    state.stop = kill
    state.permit = () => {
      if (state.reason !== "exit" || stopped.value || state.phase !== "ready") return false
      if (performance.now() >= expires) {
        state.reason = "timeout"
        kill()
        return false
      }
      try {
        // One nonblocking PIPE_BUF-sized write: true means kernel acceptance, not peer consumption.
        if (writeSync(gate.write, "start\n") !== 6) throw new Error("Incomplete gate write")
      } catch (error) {
        identity.error = String(error)
        kill()
        return false
      }
      state.phase = "authorized"
      closeGate()
      return true
    }
    const markReady = () => {
      if (!identity.stat || protocol.frame < 1 || stopped.value || state.reason !== "exit") return
      state.phase = "ready"
      ready.resolve(true)
    }
    const protocol = { frame: 0, pending: Buffer.alloc(0) }
    const frames = [Buffer.from("managed-ready\n"), Buffer.from("managed-authorized\n")]
    const timer = setTimeout(
      () => {
        if (state.reason === "exit") state.reason = "timeout"
        kill()
      },
      Math.max(1, expires - performance.now()),
    )
    const drain = (stream: Readable, key: "stdout" | "stderr") =>
      new Promise<void>((resolve) => {
        stream.on("data", (chunk: Buffer) => {
          while (key === "stdout" && protocol.frame < frames.length && chunk.length) {
            const frame = frames[protocol.frame]!
            const take = Math.min(chunk.length, frame.length - protocol.pending.length)
            protocol.pending = Buffer.concat([protocol.pending, chunk.subarray(0, take)])
            chunk = chunk.subarray(take)
            if (!frame.subarray(0, protocol.pending.length).equals(protocol.pending)) {
              identity.error = "Invalid sandbox gate acknowledgement"
              kill()
              return
            }
            if (protocol.pending.length !== frame.length) continue
            protocol.frame++
            protocol.pending = Buffer.alloc(0)
            if (protocol.frame === 1) {
              waiter.release()
              markReady()
            }
            if (protocol.frame === 2) acknowledged.resolve(true)
          }
          const take = Math.min(chunk.length, budget - output.bytes)
          if (take) output[key].push(Buffer.from(chunk.subarray(0, take)))
          output.bytes += take
          if (take < chunk.length) output.truncated = true
        })
        stream.once("end", resolve)
        stream.once("error", (error) => {
          identity.error = String(error)
          resolve()
        })
      })
    const report = waiter
      .report()
      .then((line) => {
        if (line === undefined) return
        const info: unknown = JSON.parse(line)
        if (typeof info !== "object" || !info || !("kind" in info)) throw new Error("Invalid managed wait report")
        if (
          info.kind === "exit" &&
          "exitCode" in info &&
          Number.isSafeInteger(info.exitCode) &&
          Number(info.exitCode) >= 0 &&
          Number(info.exitCode) <= 255
        ) {
          identity.termination = { kind: "exit", exitCode: Number(info.exitCode) }
          return
        }
        if (
          info.kind === "signal" &&
          "signal" in info &&
          Number.isSafeInteger(info.signal) &&
          Number(info.signal) >= 1 &&
          Number(info.signal) <= 64 &&
          "coreDumped" in info &&
          typeof info.coreDumped === "boolean"
        ) {
          identity.termination = { kind: "signal", signal: Number(info.signal), coreDumped: info.coreDumped }
          return
        }
        if (
          info.kind === "exec-error" &&
          "exitCode" in info &&
          info.exitCode === 127 &&
          "errno" in info &&
          Number.isSafeInteger(info.errno) &&
          Number(info.errno) > 0 &&
          Number(info.errno) <= 4095
        ) {
          identity.termination = { kind: "exec-error", exitCode: 127, errno: Number(info.errno) }
          return
        }
        throw new Error("Invalid managed wait status")
      })
      .catch((error) => {
        identity.error = String(error)
        kill()
      })
    const streams = Promise.all([drain(child.stdout!, "stdout"), drain(child.stderr!, "stderr"), report])
    const statuses = (async () => {
      // The status channel is generated by bwrap, never inherited by user code.
      for await (const line of createInterface({ input: status })) {
        if (line.length > 16_384) throw new Error("Oversized bwrap status")
        const info: unknown = JSON.parse(line)
        if (typeof info === "object" && info && "exit-code" in info && Number.isSafeInteger(info["exit-code"])) {
          identity.shellStatus = Number(info["exit-code"])
          continue
        }
        if (
          typeof info !== "object" ||
          !info ||
          !("child-pid" in info) ||
          !Number.isSafeInteger(info["child-pid"]) ||
          Number(info["child-pid"]) <= 1
        )
          throw new Error("Invalid bwrap namespace identity")
        if (!identity.pid) {
          identity.pid = Number(info["child-pid"])
          identity.target = native.monitor(identity.pid)
          identity.stat = identity.target.stat
          if (stopped.value || !identity.stat) kill()
          else markReady()
        }
      }
    })().catch((error) => {
      identity.error = String(error)
      kill()
    })
    if (state.reason !== "exit") kill()
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
      child.once("error", (error) => {
        identity.error = String(error)
        resolve({ code: null, signal: null })
      })
    })
    clearTimeout(timer)
    clearTimeout(stopped.timer)
    ready.resolve(false)
    await statuses
    // Also join unexpected monitor death through the retained init pidfd.
    kill()
    waiter.release()
    const deadline = Date.now() + cleanupMs
    const cleanup = await (async () => {
      if (!identity.pid || !identity.stat) return false
      while (Date.now() < deadline) {
        const current = await processIdentity(identity.pid!)
        // A namespace init becomes a zombie only after zap_pid_ns_processes joins its tasks.
        if (!current || current !== identity.stat) return true
        const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8").catch(() => "")
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return true
        await Bun.sleep(10)
      }
      return false
    })().catch((error) => {
      identity.error = String(error)
      return false
    })
    // Pipe EOF is not a substitute for namespace teardown, but must also be joined.
    const drained = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()))
      streams.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!drained) {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    await waiter.close().catch((error) => {
      identity.error = String(error)
    })
    await report
    state.stop = undefined
    state.permit = undefined
    state.phase = "completed"
    acknowledged.resolve(false)
    identity.target?.close()
    native.close()
    return {
      reason:
        state.reason === "exit" && (!identity.stat || !identity.termination || protocol.frame < 2)
          ? "setup-failed"
          : state.reason,
      shellStatus: identity.shellStatus ?? null,
      exitCode: identity.termination && "exitCode" in identity.termination ? identity.termination.exitCode : null,
      signal: identity.termination?.kind === "signal" ? identity.termination.signal : null,
      termination: identity.termination ?? { kind: "unreported" },
      supervisorSignal: exit.signal,
      stdout: Buffer.concat(output.stdout),
      stderr: Buffer.concat(output.stderr),
      truncated: output.truncated,
      cleanup: cleanup && drained && !identity.error ? "confirmed" : "failed",
      ...(!cleanup || !drained || identity.error
        ? { cleanupError: identity.error ?? "Namespace teardown or pipe EOF not confirmed" }
        : {}),
    }
  }
  return {
    start,
    /** Resolves true only after namespace identity and the closed gate are observed. */
    startPaused,
    /** Synchronously publishes one permit. False means no permit was published by this call. */
    authorize,
    /** Peer consumption, not exec success. Never await this while holding a DB transaction. */
    authorizationAcknowledged: acknowledged.promise,
    get completion() {
      return state.result
    },
    get phase() {
      return state.phase
    },
    cancel,
    async [Symbol.asyncDispose]() {
      const result = await cancel()
      if (result.cleanup === "failed") throw new Error(result.cleanupError)
    },
  }
}

async function createGate() {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-managed-gate-"))
  const descriptors: number[] = []
  try {
    const fifo = path.join(dir, "permit")
    const child = Bun.spawn(["/usr/bin/mkfifo", "-m", "600", fifo], {
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    if ((await child.exited) !== 0) throw new Error(`Cannot create managed gate: ${stderr}`)
    // Bootstrap a blocking reader without deadlocking open(). Only the host keeps a writer.
    // node:fs opens descriptors close-on-exec; only read is explicitly passed to bwrap.
    descriptors.push(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK))
    descriptors.push(openSync(fifo, constants.O_RDONLY))
    descriptors.push(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
    const [bootstrap, read, write] = descriptors as [number, number, number]
    closeSync(bootstrap)
    descriptors.shift()
    await rm(dir, { recursive: true })
    descriptors.length = 0
    const state = { closed: false }
    return {
      read,
      write,
      close() {
        if (state.closed) return
        state.closed = true
        closeSync(write)
      },
    }
  } finally {
    descriptors.forEach((fd) => closeSync(fd))
    await rm(dir, { recursive: true, force: true })
  }
}

async function processIdentity(pid: number) {
  return readFile(`/proc/${pid}/stat`, "utf8")
    .then((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
      throw error
    })
}

async function requireTree(dir: string, writable = false): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) throw new Error("Mount source must be a directory")
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await requireTree(path.join(dir, entry.name), writable)
    else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Special file in mount: ${entry.name}`)
    else if (writable && entry.isFile() && (await lstat(path.join(dir, entry.name))).nlink > 1)
      throw new Error(`Hard-linked file in writable mount: ${entry.name}`)
  }
}

export * as ManagedLinux from "./managed-linux"
