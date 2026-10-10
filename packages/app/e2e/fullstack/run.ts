import { randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ChildProcess } from "node:child_process"
import type { ViteDevServer } from "vite"

const prefix = "opencode-worktree-e2e-"
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const appRoot = path.join(repoRoot, "packages", "app")
const opencodeEntry = path.join(repoRoot, "packages", "opencode", "src", "index.ts")
const modelsFixture = path.join(repoRoot, "packages", "opencode", "test", "tool", "fixtures", "models-api.json")
type ProcessIdentity = { pid: number; pgid: number; sid?: number; startTime: string }
type Manifest = { kind: string; root: string; runID: string; owner: ProcessIdentity; children: ProcessIdentity[] }
type ManagedProcess = {
  name: string
  child: ChildProcess
  output: string
  error?: Error
  exited?: { code: number | null; signal: NodeJS.Signals | null }
  identity: Promise<ProcessIdentity | undefined>
}

function timeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeRoot(root: string) {
  const absolute = path.resolve(root)
  if (!absolute.startsWith(`/tmp/${prefix}`) || path.dirname(absolute) !== "/tmp") {
    throw new Error(`Refusing to access a full-stack test path outside /tmp/${prefix}*: ${root}`)
  }
  return absolute
}

async function writeManifest(root: string, manifest: Manifest) {
  const target = path.join(root, "owner.json")
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 })
  await rename(temporary, target)
}

function childProcess(input: {
  name: string
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  children: ManagedProcess[]
}): ManagedProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const managed: ManagedProcess = {
    name: input.name,
    child,
    output: "",
    identity: new Promise((resolve) => {
      child.once("spawn", () => {
        if (!child.pid) return resolve(undefined)
        void processIdentity(child.pid).then(resolve, () => resolve(undefined))
      })
      child.once("error", () => resolve(undefined))
    }),
  }
  input.children.push(managed)
  child.stdout?.on("data", (data: Buffer) => {
    managed.output += data.toString()
    process.stdout.write(data)
  })
  child.stderr?.on("data", (data: Buffer) => {
    managed.output += data.toString()
    process.stderr.write(data)
  })
  child.once("error", (error) => (managed.error = error))
  child.once("exit", (code, signal) => (managed.exited = { code, signal }))
  return managed
}

function waitForOutput(input: ManagedProcess, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    const child = input.child
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${input.name} to become ready`)), 120_000)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off("data", check)
      child.stderr?.off("data", check)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const finish = (error?: Error, value?: string) => {
      cleanup()
      if (error) reject(error)
      else resolve(value ?? "")
    }
    const check = () => {
      const match = pattern.exec(input.output)
      if (match) finish(undefined, match[1] ?? match[0])
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`${input.name} exited before becoming ready (code=${code}, signal=${signal})`))

    child.stdout?.on("data", check)
    child.stderr?.on("data", check)
    child.once("error", onError)
    child.once("exit", onExit)
    if (input.error) onError(input.error)
    else if (input.exited) onExit(input.exited.code, input.exited.signal)
    else check()
  })
}

function waitForExit(input: ManagedProcess) {
  if (input.error) return Promise.reject(input.error)
  if (input.exited) return exitCode(input.name, input.exited.code, input.exited.signal)
  return new Promise<number>((resolve, reject) => {
    input.child.once("error", reject)
    input.child.once("exit", (code, signal) => {
      try {
        resolve(exitCode(input.name, code, signal))
      } catch (error) {
        reject(error)
      }
    })
    if (input.error) reject(input.error)
    else if (input.exited) {
      try {
        resolve(exitCode(input.name, input.exited.code, input.exited.signal))
      } catch (error) {
        reject(error)
      }
    }
  })
}

function exitCode(name: string, code: number | null, signal: NodeJS.Signals | null) {
  if (signal) throw new Error(`${name} exited due to ${signal}`)
  return code ?? 1
}

function waitForProcessExit(input: ManagedProcess) {
  if (input.exited || input.child.exitCode !== null || input.child.signalCode !== null) return Promise.resolve()
  return timeout(
    new Promise<void>((resolve) => {
      input.child.once("exit", () => resolve())
      if (input.exited || input.child.exitCode !== null || input.child.signalCode !== null) resolve()
    }),
    15_000,
    `${input.name} did not exit after SIGTERM`,
  )
}

function sameProcess(first: ProcessIdentity, second: ProcessIdentity | undefined): second is ProcessIdentity {
  return (
    !!second &&
    first.pid === second.pid &&
    first.pgid === second.pgid &&
    (first.sid === undefined || first.sid === second.sid) &&
    first.startTime === second.startTime
  )
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  response.end(JSON.stringify(value))
}

function event(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function fakeReply(input: { response: ServerResponse; model: string; tool?: { name: string; args: unknown }; text?: string }) {
  const response = input.response
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  event(response, {
    id: "chatcmpl-worktree-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })
  if (input.tool) {
    event(response, {
      id: "chatcmpl-worktree-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: input.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${input.tool.name}`,
                type: "function",
                function: { name: input.tool.name, arguments: JSON.stringify(input.tool.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  }
  if (input.text) {
    event(response, {
      id: "chatcmpl-worktree-e2e",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: input.model,
      choices: [{ index: 0, delta: { content: input.text }, finish_reason: null }],
    })
  }
  event(response, {
    id: "chatcmpl-worktree-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [{ index: 0, delta: {}, finish_reason: input.tool ? "tool_calls" : "stop" }],
  })
  response.end("data: [DONE]\n\n")
}

async function startFakeProvider(root: string) {
  const counts = new Map<string, number>()
  const models = new Map<string, string>()
  const calls: Array<{ label: string; model: string; history: unknown[] }> = []
  const firstRequests = new Set<string>()
  const waiters: Array<{ labels: string[]; resolve: () => void }> = []
  let heldLabels = new Set<string>()
  let releaseHold = () => {}
  let hold = new Promise<void>((resolve) => (releaseHold = resolve))
  const requestLog = path.join(root, "fake-llm.ndjson")

  const notify = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.labels.every((label) => firstRequests.has(label))) waiter.resolve()
      else waiters.push(waiter)
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname === "/__test/state" && request.method === "GET") {
        json(response, 200, {
          counts: Object.fromEntries(counts),
          models: Object.fromEntries(models),
          calls,
          firstRequests: [...firstRequests],
        })
        return
      }
      if (url.pathname === "/__test/reset" && request.method === "POST") {
        counts.clear()
        models.clear()
        calls.length = 0
        firstRequests.clear()
        heldLabels.clear()
        releaseHold()
        waiters.splice(0).forEach((waiter) => waiter.resolve())
        hold = new Promise<void>((resolve) => (releaseHold = resolve))
        json(response, 200, { reset: true })
        return
      }
      if (url.pathname === "/__test/hold" && request.method === "POST") {
        const value = await body(request)
        heldLabels = new Set(Array.isArray(value.labels) ? value.labels.filter((item): item is string => typeof item === "string") : [])
        hold = new Promise<void>((resolve) => (releaseHold = resolve))
        json(response, 200, { held: [...heldLabels] })
        return
      }
      if (url.pathname === "/__test/wait" && request.method === "POST") {
        const value = await body(request)
        const labels = Array.isArray(value.labels) ? value.labels.filter((item): item is string => typeof item === "string") : []
        if (!labels.every((label) => firstRequests.has(label))) {
          await new Promise<void>((resolve) => waiters.push({ labels, resolve }))
        }
        json(response, 200, { firstRequests: [...firstRequests] })
        return
      }
      if (url.pathname === "/__test/release" && request.method === "POST") {
        releaseHold()
        heldLabels.clear()
        json(response, 200, { released: true })
        return
      }
      if (request.method !== "POST" || !/^\/v1\/(chat\/completions|responses)$/.test(url.pathname)) {
        json(response, 404, { error: "Not found" })
        return
      }

      const value = await body(request)
      const serialized = JSON.stringify(value)
      await appendFile(requestLog, `${JSON.stringify({ path: url.pathname, body: value })}\n`)
      const model = typeof value.model === "string" ? value.model : "test-model"
      if (serialized.includes("Generate a title for this conversation")) {
        fakeReply({ response, model, text: "Worktree E2E" })
        return
      }
      const label = ["alpha", "beta", "gamma"].find((item) => serialized.includes(`E2E_WORKTREE_${item.toUpperCase()}`))
      if (!label) {
        fakeReply({ response, model, text: "Unmatched fake-provider request" })
        return
      }
      const history = Array.isArray(value.messages) ? value.messages : []
      calls.push({ label, model, history })
      const count = counts.get(label) ?? 0
      counts.set(label, count + 1)
      models.set(label, model)
      if (count === 0) {
        firstRequests.add(label)
        notify()
        if (heldLabels.has(label)) await hold
        fakeReply({
          response,
          model,
          tool: {
            name: "bash",
            args: {
              command: `printf '%s\\n' "$(pwd -P)" "$(git rev-parse --show-toplevel)" "shell-${label}" | tee ${label}-shell.txt`,
            },
          },
        })
        return
      }
      if (count === 1) {
        fakeReply({
          response,
          model,
          tool: {
            name: "edit",
            args: {
              filePath: `${label}-edit.txt`,
              oldString: "",
              newString: `edit-${label}\n`,
            },
          },
        })
        return
      }
      fakeReply({ response, model, text: `WORKTREE_${label.toUpperCase()}_COMPLETE` })
    })().catch((error) => {
      if (!response.headersSent) json(response, 500, { error: String(error) })
      else response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The fake LLM did not bind a TCP port")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    controlURL: `http://127.0.0.1:${address.port}/__test`,
    close: async () => {
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error)
            return
          }
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
}

async function closeHttpServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error)
        return
      }
      resolve()
    })
    server.closeAllConnections()
  })
}

async function readProcEnv(pid: number) {
  return readFile(`/proc/${pid}/environ`).catch(() => undefined)
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)
  if (!stat) {
    if (process.platform === "linux") return
    return { pid, pgid: pid, startTime: "unavailable" }
  }
  // After the command field, stat fields 5, 6, and 22 are group, session, and start time.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  if (fields[0] === "Z" || fields[0] === "X") return
  const pgid = Number(fields[2])
  const sid = Number(fields[3])
  const startTime = fields[19]
  if (!Number.isInteger(pgid) || !Number.isInteger(sid) || !startTime) return
  return { pid, pgid, sid, startTime }
}

function matchesRun(environment: string[], root: string, runID: string) {
  return environment.includes(`OPENCODE_E2E_RUN_ID=${runID}`) && environment.includes(`OPENCODE_E2E_ROOT=${root}`)
}

async function ownedProcesses(root: string, runID: string) {
  const output: ProcessIdentity[] = []
  const entries = await readdir("/proc", { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name)
        if (pid === process.pid) return
        const identity = await processIdentity(pid)
        if (!identity) return
        const data = await readProcEnv(pid)
        if (!data) return
        const environment = data.toString("utf8").split("\0")
        if (matchesRun(environment, root, runID)) output.push(identity)
      }),
  )
  return output
}

let linuxLibrary: ReturnType<typeof loadLinuxLibrary> | undefined

async function loadLinuxLibrary() {
  const { dlopen, FFIType } = await import("bun:ffi")
  return dlopen("libc.so.6", {
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i64,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
}

async function verifyPidfdSupport() {
  const library = await (linuxLibrary ??= loadLinuxLibrary())
  const pidfd = library.symbols.syscall(434n, BigInt(process.pid), 0n, 0n, 0n)
  if (pidfd < 0n) throw new Error("Linux pidfd_open is unavailable; no test root was created")
  try {
    if (library.symbols.syscall(424n, pidfd, 0n, 0n, 0n) < 0n) {
      throw new Error("Linux pidfd_send_signal is unavailable; no test root was created")
    }
  } finally {
    library.symbols.close(Number(pidfd))
  }
}

async function signalProcess(
  candidate: ProcessIdentity,
  signal: NodeJS.Signals,
  root: string,
  runID: string,
  sessions: Set<number>,
  ownerSession?: number,
) {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`PID-safe signaling is not implemented for Linux ${process.arch}`)
  }

  const library = await (linuxLibrary ??= loadLinuxLibrary())
  const pidfd = library.symbols.syscall(434n, BigInt(candidate.pid), 0n, 0n, 0n)
  if (pidfd < 0n) {
    if (!sameProcess(candidate, await processIdentity(candidate.pid))) return
    throw new Error(`Could not pin test-owned process ${candidate.pid}`)
  }

  try {
    const current = await processIdentity(candidate.pid)
    if (!sameProcess(candidate, current)) return
    const data = await readProcEnv(candidate.pid)
    if (
      (!data || !matchesRun(data.toString("utf8").split("\0"), root, runID)) &&
      (current.sid === undefined || current.sid === ownerSession || !sessions.has(current.sid))
    ) {
      return
    }

    const number = signal === "SIGTERM" ? 15n : signal === "SIGKILL" ? 9n : undefined
    if (number === undefined) throw new Error(`Unsupported cleanup signal: ${signal}`)
    // The pidfd keeps the verified process identity stable until signal delivery.
    const result = library.symbols.syscall(424n, pidfd, number, 0n, 0n)
    if (result < 0n && sameProcess(candidate, await processIdentity(candidate.pid))) {
      throw new Error(`Could not signal test-owned process ${candidate.pid}`)
    }
  } finally {
    library.symbols.close(Number(pidfd))
  }
}

async function signalOwnedProcesses(
  root: string,
  runID: string,
  signal: NodeJS.Signals,
  sessions: Set<number>,
  ownerSession?: number,
) {
  const processes = await ownedProcesses(root, runID)
  processes.forEach((identity) => {
    if (identity.sid !== undefined && identity.sid !== ownerSession) sessions.add(identity.sid)
  })
  if (ownerSession !== undefined && sessions.has(ownerSession)) {
    throw new Error("Refusing to signal or monitor the full-stack runner session")
  }
  const members = await processSessionMembers(sessions, ownerSession)
  const targets = [...new Map([...processes, ...members].map((identity) => [identity.pid, identity])).values()]
  if (process.env.OPENCODE_E2E_DEBUG === "1") {
    console.log("Full-stack process cleanup", {
      runner: await processIdentity(process.pid),
      sessions: [...sessions],
      targets,
    })
  }
  await Promise.all(targets.map((candidate) => signalProcess(candidate, signal, root, runID, sessions, ownerSession)))
}

async function unverifiedChildren(children: ProcessIdentity[], root: string, runID: string) {
  return (
    await Promise.all(
      children.map(async (identity) => {
        if (!sameProcess(identity, await processIdentity(identity.pid))) return
        const data = await readProcEnv(identity.pid)
        if (data && matchesRun(data.toString("utf8").split("\0"), root, runID)) return
        return identity
      }),
    )
  ).filter((identity): identity is ProcessIdentity => !!identity)
}

async function processSessionMembers(sessions: Set<number>, ownerSession?: number) {
  if (sessions.size === 0) return []
  const entries = await readdir("/proc", { withFileTypes: true })
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => processIdentity(Number(entry.name))),
    )
  ).filter(
    (identity): identity is ProcessIdentity =>
      !!identity && identity.sid !== undefined && identity.sid !== ownerSession && sessions.has(identity.sid),
  )
}

async function waitForOwnedProcesses(
  root: string,
  runID: string,
  ms: number,
  sessions: Set<number>,
  ownerSession?: number,
) {
  const end = Date.now() + ms
  let emptyScans = 0
  while (Date.now() < end) {
    const processes = await ownedProcesses(root, runID)
    processes.forEach((identity) => {
      if (identity.sid !== undefined && identity.sid !== ownerSession) sessions.add(identity.sid)
    })
    if (ownerSession !== undefined && sessions.has(ownerSession)) {
      throw new Error("Refusing to monitor the full-stack runner session")
    }
    const members = await processSessionMembers(sessions, ownerSession)
    if (processes.length === 0 && members.length === 0) {
      emptyScans++
      // Repeated empty session and token scans close the fork-during-scan window before root removal.
      if (emptyScans === 3) return
    } else {
      emptyScans = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test-owned processes are still running for ${root}`)
}

async function stopOwnedProcesses(
  root: string,
  runID: string,
  initialProcesses: ProcessIdentity[] = [],
  ownerSession?: number,
) {
  if (initialProcesses.some((identity) => identity.sid === ownerSession)) {
    throw new Error("Refusing to stop the full-stack runner session")
  }
  const sessions = new Set(initialProcesses.flatMap((identity) => (identity.sid === undefined ? [] : [identity.sid])))
  await signalOwnedProcesses(root, runID, "SIGTERM", sessions, ownerSession)
  try {
    await waitForOwnedProcesses(root, runID, 15_000, sessions, ownerSession)
  } catch {
    await signalOwnedProcesses(root, runID, "SIGKILL", sessions, ownerSession)
    await waitForOwnedProcesses(root, runID, 15_000, sessions, ownerSession)
  }
}

async function recoverStale() {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error("Stale-run recovery requires Linux x64 or arm64 with pidfd support; no paths were changed")
  }
  await verifyPidfdSupport()
  const entries = await readdir("/tmp", { withFileTypes: true })
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(prefix))) {
    const root = safeRoot(path.join("/tmp", entry.name))
    let manifest: Manifest
    try {
      manifest = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8")) as Manifest
    } catch {
      continue
    }
    if (manifest.kind !== "opencode-fullstack-worktree-e2e" || manifest.root !== root || !manifest.runID) continue
    const owner = await processIdentity(manifest.owner.pid)
    if (sameProcess(manifest.owner, owner)) {
      console.log(`Preserving active full-stack run: ${root}`)
      continue
    }
    await stopOwnedProcesses(root, manifest.runID, manifest.children, manifest.owner.sid)
    if ((await unverifiedChildren(manifest.children, root, manifest.runID)).length > 0) {
      throw new Error(`Cannot verify test-owned children for ${root}; preserving this directory`)
    }
    await rm(root, { recursive: true })
    console.log(`Removed stale full-stack run: ${root}`)
  }
}

async function run() {
  if (process.argv.includes("--recover-stale")) return recoverStale()
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error("The isolated full-stack worktree harness requires Linux x64 or arm64, /proc, pidfd, and mkfifo")
  }
  await verifyPidfdSupport()

  const realGit = Bun.which("git")
  if (!realGit) throw new Error("Git is required for the isolated worktree regression")
  const originalEnvironment = { ...process.env }
  const owner = await processIdentity(process.pid)
  if (!owner) throw new Error("Could not pin the full-stack runner process identity")
  const root = safeRoot(await mkdtemp(`/tmp/${prefix}`))
  const runID = randomUUID()
  process.env.OPENCODE_E2E_ROOT = root
  process.env.OPENCODE_E2E_RUN_ID = runID
  const children: ManagedProcess[] = []
  let interrupted = false
  let interruptError: unknown
  let interruptTask: Promise<void> | undefined
  let resolveInterrupted: () => void = () => {}
  const interruptedPromise = new Promise<void>((resolve) => (resolveInterrupted = resolve))
  const interruptible = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      interruptedPromise.then(() => {
        throw new Error("Full-stack E2E run was interrupted")
      }),
    ])
  let exitCode = 0
  const interrupt = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
    if (interrupted) return
    interrupted = true
    resolveInterrupted()
    exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129
    interruptTask = (async () => {
      try {
        if (process.platform === "linux") {
          await signalOwnedProcesses(root, runID, "SIGTERM", new Set(), owner.sid)
          return
        }
        await Promise.all(
          children.map(async (child) => {
            if (child.exited || child.child.exitCode !== null || child.child.signalCode !== null) return
            child.child.kill("SIGTERM")
          }),
        )
      } catch (error) {
        interruptError = error
      }
    })()
  }
  const onSigInt = () => interrupt("SIGINT")
  const onSigTerm = () => interrupt("SIGTERM")
  const onSigHup = () => interrupt("SIGHUP")
  process.once("SIGINT", onSigInt)
  process.once("SIGTERM", onSigTerm)
  process.once("SIGHUP", onSigHup)
  const assertActive = () => {
    if (interrupted) throw new Error("Full-stack E2E run was interrupted")
  }
  let fake: Awaited<ReturnType<typeof startFakeProvider>> | undefined
  let viteServer: ViteDevServer | undefined
  let viteHTTPServer: ReturnType<typeof createServer> | undefined
  const models = path.join(root, "models-api.json")
  const manifest: Manifest = {
    kind: "opencode-fullstack-worktree-e2e",
    root,
    runID,
    owner,
    children: [],
  }
  const startChild = async (input: Omit<Parameters<typeof childProcess>[0], "children">) => {
    assertActive()
    const child = childProcess({ ...input, children })
    const identity = await child.identity
    if (identity && identity.sid === owner.sid) throw new Error(`${input.name} did not start in an isolated session`)
    if (identity) manifest.children.push(identity)
    await writeManifest(root, manifest)
    assertActive()
    return child
  }

  try {
    await writeManifest(root, manifest)
    const directories = [
      "home",
      "tmp",
      "runtime",
      "data",
      "cache",
      "config",
      "state",
      "managed",
      "bin",
      "fixtures",
      "database",
      "playwright",
    ].map((item) => path.join(root, item))
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
    await chmod(path.join(root, "runtime"), 0o700)
    await writeFile(path.join(root, "gitconfig"), "[user]\n\tname = OpenCode E2E\n\temail = e2e@opencode.test\n")
    execFileSync("mkfifo", [path.join(root, "gate.fifo")])
    await writeFile(
      path.join(root, "bin", "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "reset" ] && [ "$2" = "--hard" ] && [ -f "$OPENCODE_E2E_GIT_FAIL" ]; then',
        '  printf "%s\\n" "$PWD" > "$OPENCODE_E2E_GIT_FAILED"',
        '  rm -f "$OPENCODE_E2E_GIT_FAIL"',
        '  printf "%s\\n" "controlled worktree bootstrap failure" >&2',
        "  exit 71",
        "fi",
        'if [ "$1" = "reset" ] && [ "$2" = "--hard" ] && [ -f "$OPENCODE_E2E_GIT_GATE_ARMED" ]; then',
        '  rm -f "$OPENCODE_E2E_GIT_GATE_ARMED"',
        '  printf "%s\\n" "$PWD" > "$OPENCODE_E2E_GIT_GATE_ENTERED"',
        '  IFS= read -r _ < "$OPENCODE_E2E_GIT_GATE_FIFO"',
        "fi",
        'exec "$OPENCODE_E2E_REAL_GIT" "$@"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    )
    await chmod(path.join(root, "bin", "git"), 0o700)
    await writeFile(models, await readFile(modelsFixture))

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TEMP: path.join(root, "tmp"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      OPENCODE_TEST_HOME: path.join(root, "home"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      OPENCODE_DB: path.join(root, "database", "opencode.sqlite"),
      OPENCODE_MODELS_PATH: models,
      OPENCODE_E2E_ROOT: root,
      OPENCODE_E2E_RUN_ID: runID,
      OPENCODE_E2E_REAL_GIT: realGit,
      OPENCODE_E2E_GIT_GATE_ARMED: path.join(root, "gate.armed"),
      OPENCODE_E2E_GIT_GATE_ENTERED: path.join(root, "gate.entered"),
      OPENCODE_E2E_GIT_GATE_FIFO: path.join(root, "gate.fifo"),
      OPENCODE_E2E_GIT_FAIL: path.join(root, "git.fail"),
      OPENCODE_E2E_GIT_FAILED: path.join(root, "git.failed"),
      OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
      OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
      OPENCODE_PURE: "1",
      OPENCODE_CHANNEL: "dev",
      GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      SHELL: "/bin/sh",
      LANG: process.env.LANG ?? "C.UTF-8",
      NO_COLOR: "1",
    }
    fake = await startFakeProvider(root)
    assertActive()
    const project = path.join(root, "fixtures", "bootstrap")
    await mkdir(project, { recursive: true })
    const projectConfig = {
      $schema: "https://opencode.ai/config.json",
      model: "test/test-model",
      formatter: false,
      lsp: false,
      agent: { build: { permission: { "*": "allow", bash: "allow", edit: "allow", apply_patch: "allow" } } },
      provider: {
        test: {
          name: "Isolated E2E",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Isolated E2E Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 1, output: 1 },
              options: {},
            },
          },
          options: { apiKey: "isolated-test-key", baseURL: fake.url },
        },
      },
    }
    await writeFile(path.join(project, "opencode.json"), JSON.stringify(projectConfig, null, 2))
    await writeFile(path.join(project, "baseline.txt"), "main-checkout-baseline\n")
    for (const args of [
      ["init", "-b", "main"],
      ["config", "core.fsmonitor", "false"],
      ["config", "commit.gpgsign", "false"],
      ["config", "user.email", "e2e@opencode.test"],
      ["config", "user.name", "OpenCode E2E"],
      ["add", "opencode.json", "baseline.txt"],
      ["commit", "-m", "isolated E2E baseline"],
    ]) {
      execFileSync(realGit, args, { cwd: project, env: baseEnv, stdio: "pipe" })
    }

    const server = await startChild({
      name: "OpenCode server",
      command: process.execPath,
      args: ["run", opencodeEntry, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: project,
      env: baseEnv,
    })
    const serverURL = await interruptible(
      waitForOutput(server, /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/),
    )
    const serverPort = new URL(serverURL).port

    assertActive()
    const viteEnv = {
      ...baseEnv,
      VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
      VITE_OPENCODE_SERVER_PORT: serverPort,
      OPENCODE_E2E_BASE_URL: "",
    }
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, viteEnv)
    viteHTTPServer = createServer()
    await new Promise<void>((resolve, reject) => {
      viteHTTPServer!.once("error", reject)
      viteHTTPServer!.listen(0, "127.0.0.1", resolve)
    })
    const address = viteHTTPServer.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind a loopback TCP port")
    const viteModule = await import("vite")
    viteServer = await viteModule.createServer({
      configFile: path.join(appRoot, "e2e", "fullstack", "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: address.port,
        strictPort: true,
        allowedHosts: [],
        middlewareMode: { server: viteHTTPServer },
        hmr: { server: viteHTTPServer },
      },
    })
    viteHTTPServer.on("request", viteServer.middlewares)
    const viteURL = `http://127.0.0.1:${address.port}`

    const browserPath = path.join(root, "playwright", "browsers")
    const systemChromium = Bun.which("chromium") ?? Bun.which("chromium-browser") ?? undefined
    const playwrightEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      OPENCODE_E2E_BASE_URL: viteURL,
      OPENCODE_E2E_SERVER_URL: serverURL,
      OPENCODE_E2E_FAKE_LLM_CONTROL_URL: fake.controlURL,
      OPENCODE_E2E_CHROMIUM_EXECUTABLE: systemChromium,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
    }
    await mkdir(path.join(root, "playwright", "results"), { recursive: true })
    await mkdir(path.join(root, "playwright", "report"), { recursive: true })
    const cli = path.join(appRoot, "node_modules", ".bin", "playwright")
    if (!systemChromium) {
      await mkdir(browserPath, { recursive: true })
      const install = await startChild({
        name: "Isolated Chromium installation",
        command: cli,
        args: ["install", "chromium"],
        cwd: appRoot,
        env: playwrightEnv,
      })
      const installCode = await interruptible(Promise.resolve(waitForExit(install)))
      if (installCode !== 0) throw new Error(`Playwright Chromium installation exited with ${installCode}`)
    }

    const tests = await startChild({
      name: "Playwright full-stack tests",
      command: cli,
      args: [
        "test",
        "--config",
        path.join(appRoot, "e2e", "fullstack", "playwright.config.ts"),
        ...process.argv.slice(2),
      ],
      cwd: appRoot,
      env: playwrightEnv,
    })
    const result = await interruptible(Promise.resolve(waitForExit(tests)))
    console.log(`Playwright full-stack tests exited with ${result}`)
    if (!interrupted) exitCode = result
  } catch (error) {
    if (!interrupted) {
      console.error("Full-stack E2E runner failed", error)
      exitCode ||= 1
    } else {
      console.error("Full-stack E2E run interrupted", error)
    }
  } finally {
    const cleanupErrors: string[] = []
    if (interruptTask) await interruptTask
    try {
      if (process.platform === "linux") {
        const identities = (await Promise.all(children.map((child) => child.identity))).filter(
          (identity): identity is ProcessIdentity => !!identity,
        )
        await stopOwnedProcesses(root, runID, identities, owner.sid)
        if ((await unverifiedChildren(manifest.children, root, runID)).length > 0) {
          throw new Error("Could not verify all recorded test child processes")
        }
      } else {
        for (const child of [...children].reverse()) {
          if (child.exited || child.child.exitCode !== null || child.child.signalCode !== null) continue
          child.child.kill("SIGTERM")
        }
        await Promise.all(children.map(waitForProcessExit))
      }
    } catch (error) {
      cleanupErrors.push(String(error))
    }
    try {
      await viteServer?.close()
    } catch (error) {
      cleanupErrors.push(`Vite frontend: ${String(error)}`)
    }
    try {
      if (viteHTTPServer) await closeHttpServer(viteHTTPServer)
    } catch (error) {
      cleanupErrors.push(`Vite HTTP listener: ${String(error)}`)
    }
    try {
      await fake?.close()
    } catch (error) {
      cleanupErrors.push(`fake LLM server: ${String(error)}`)
    }
    if (interruptError) console.error(`Initial interrupt signal failed; verified teardown will retry: ${String(interruptError)}`)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    if (cleanupErrors.length > 0) {
      console.error(`Full-stack E2E cleanup failed; exact leftover path: ${root}`)
      cleanupErrors.forEach((error) => console.error(error))
      for (const child of children) {
        if (child.exited || child.child.exitCode !== null || child.child.signalCode !== null) continue
        child.child.stdout?.destroy()
        child.child.stderr?.destroy()
        child.child.unref()
      }
      exitCode ||= 1
    } else {
      try {
        const ownerMarker = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8")) as Manifest
        if (
          ownerMarker.kind !== "opencode-fullstack-worktree-e2e" ||
          ownerMarker.root !== root ||
          ownerMarker.runID !== runID
        ) {
          throw new Error("test ownership marker changed")
        }
        if (!inside(root, path.join(root, "database", "opencode.sqlite"))) throw new Error("database escaped test root")
        await rm(root, { recursive: true })
        console.log(`Full-stack E2E cleanup succeeded; removed ${root}`)
      } catch (error) {
        console.error(`Full-stack E2E cleanup failed; exact leftover path: ${root}`)
        console.error(error)
        exitCode ||= 1
      }
    }
  }
  console.log(`Full-stack runner exit code: ${exitCode}`)
  process.off("SIGINT", onSigInt)
  process.off("SIGTERM", onSigTerm)
  process.off("SIGHUP", onSigHup)
  if (exitCode !== 0) process.exitCode = exitCode
}

await run()
