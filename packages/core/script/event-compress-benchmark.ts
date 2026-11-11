import { Database } from "bun:sqlite"
import { constants } from "node:buffer"
import { randomFillSync } from "node:crypto"
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { compressEvents } from "./event-compress"

const MiB = 1024 * 1024
const limit = 8 * 1024 * MiB
const kinds = ["repetitive", "structured", "entropy"] as const
type Kind = (typeof kinds)[number]

export function parseBenchmarkArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "boolean" },
      help: { type: "boolean" },
      write: { type: "boolean" },
      "sizes-mib": { type: "string" },
      classes: { type: "string" },
      repetitions: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  })
  if (!values.run && !values.help) throw new Error("Explicit --run is required; use --help")
  const sizes = (values["sizes-mib"] ?? "1,4,16").split(",").map((value) => {
    if (!/^\d+$/.test(value)) throw new Error("Sizes must be integers from 1 to 1024 MiB")
    const size = Number(value)
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024)
      throw new Error("Sizes must be integers from 1 to 1024 MiB")
    return size
  })
  const classes = (values.classes ?? kinds.join(",")).split(",")
  if (classes.some((kind) => !kinds.some((valid) => valid === kind))) throw new Error("Unknown synthetic class")
  const repetitions = Number(values.repetitions ?? "3")
  if (!/^\d+$/.test(values.repetitions ?? "3") || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error("Repetitions must be integers from 1 to 10")
  if (sizes.length * classes.length * repetitions > 100) throw new Error("At most 100 trials are allowed")
  if (new Set(sizes).size !== sizes.length || new Set(classes).size !== classes.length)
    throw new Error("Duplicate sizes or classes are not allowed")
  return {
    sizes: sizes.toSorted((a, b) => a - b),
    classes: classes as Kind[],
    repetitions,
    write: !!values.write,
    help: !!values.help,
  }
}

export function fixturePayload(kind: Kind, bytes: number) {
  const prefix = '{"text":"'
  const suffix = '"}'
  if (!Number.isSafeInteger(bytes) || bytes < prefix.length + suffix.length) throw new Error("Invalid fixture size")
  const payload = Buffer.allocUnsafe(bytes)
  payload.write(prefix)
  payload.write(suffix, bytes - suffix.length)
  const end = bytes - suffix.length
  if (kind === "repetitive") payload.fill("synthetic event output ", prefix.length, end)
  if (kind === "structured") {
    for (let offset = prefix.length, line = 0; offset < end; line++) {
      const text = `+ file=src/module_${line % 97}.ts status=updated value=${line} | - previous output | `
      offset += payload.write(text.slice(0, end - offset), offset)
    }
  }
  if (kind === "entropy") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - prefix.length))
    for (let offset = prefix.length; offset < end; ) {
      const length = Math.min(chunk.length, end - offset)
      randomFillSync(chunk, 0, length)
      for (let i = 0; i < length; i++) payload[offset + i] = alphabet.charCodeAt(chunk[i] & 63)
      offset += length
    }
  }
  return payload
}

function scope() {
  const entry = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((line) => line.startsWith("0::"))
  if (!entry) throw new Error("cgroup v2 membership unavailable")
  const relative = entry.slice(3)
  if (!relative.startsWith("/") || relative.split("/").includes("..")) throw new Error("Invalid cgroup membership")
  const dir = path.join("/sys/fs/cgroup", relative)
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8").trim()
  if (read("memory.max") !== String(limit) || read("memory.swap.max") !== "0")
    throw new Error("Benchmark requires cgroup v2 memory.max=8589934592 and memory.swap.max=0")
  return { dir, read }
}

function counters(read: (name: string) => string) {
  const events = Object.fromEntries(
    read("memory.events")
      .split("\n")
      .map((line) => line.split(" "))
      .map(([key, value]) => [key, Number(value)]),
  )
  let peak: number | null = null
  try {
    peak = Number(read("memory.peak"))
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
  }
  return { current: Number(read("memory.current")), peak, oom: events.oom ?? 0, oomKill: events.oom_kill ?? 0 }
}

function engine() {
  using db = new Database(":memory:")
  const options = db.query<{ compile_options: string }, []>("PRAGMA compile_options").all()
  const value = options.find((row) => row.compile_options.startsWith("MAX_LENGTH="))?.compile_options.slice(11)
  if (!value || !/^\d+$/.test(value)) throw new Error("SQLite MAX_LENGTH compile option unavailable")
  return {
    sqlite: db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version,
    maxLength: Number(value),
    bun: Bun.version,
    bufferMax: constants.MAX_LENGTH,
    stringMax: constants.MAX_STRING_LENGTH,
  }
}

function skipReason(bytes: number, limits: ReturnType<typeof engine>, current: number, disk: number) {
  // SQLite's row encoding includes other columns and a record header.
  if (bytes + 1024 >= limits.maxLength)
    return `SQLite MAX_LENGTH=${limits.maxLength} includes row overhead; ${bytes} payload bytes exceed the conservative row limit`
  if (bytes >= limits.bufferMax || bytes >= limits.stringMax)
    return `Payload ${bytes} reaches runtime Buffer/string limit (${limits.bufferMax}/${limits.stringMax})`
  const memory = bytes * 12 + 512 * MiB
  if (!Number.isFinite(current) || current + memory > limit)
    return `Insufficient cgroup memory: current=${current}, budget=${memory}, limit=${limit}`
  const required = bytes * 4 + 1024 * MiB
  if (disk < required) return `Insufficient temporary disk space: available=${disk}, required=${required}`
}

function createFixture(filename: string, kind: Kind, bytes: number) {
  closeSync(openSync(filename, "wx", 0o600))
  using db = new Database(filename, { create: false, strict: true })
  db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id), seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq);
    INSERT INTO event_sequence VALUES ('synthetic', 1, 'benchmark');`)
  db.query("INSERT INTO event VALUES ('evt_synthetic', 'synthetic', 0, 'benchmark.synthetic.1', CAST(? AS TEXT))").run(
    fixturePayload(kind, bytes),
  )
}

export async function runBenchmarkTrial(command: string[], signal: AbortSignal) {
  signal.throwIfAborted()
  const dir = await mkdtemp(path.join(realpathSync(tmpdir()), "event-compress-synthetic-"))
  try {
    signal.throwIfAborted()
    const child = Bun.spawn([...command, dir], { stdout: "pipe", stderr: "pipe" })
    const abort = () => child.kill("SIGKILL")
    signal.addEventListener("abort", abort, { once: true })
    try {
      return await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    } finally {
      signal.removeEventListener("abort", abort)
      if (child.exitCode === null) abort()
      await child.exited
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type Trial = {
  sizeMiB: number
  kind: Kind
  repetition: number
  compressionMs: number
  totalMs: number
  savingsPercent: number
  throughputMiBps: number
}

async function worker(sizeMiB: number, kind: Kind, repetition: number, write: boolean, dir: string) {
  const cgroup = scope()
  const tempRoot = realpathSync(tmpdir())
  const info = lstatSync(dir)
  if (
    path.dirname(dir) !== tempRoot ||
    !path.basename(dir).startsWith("event-compress-synthetic-") ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    realpathSync(dir) !== dir
  )
    throw new Error("Invalid synthetic temporary directory")
  const limits = engine()
  const disk = statfsSync(tmpdir())
  const reason = skipReason(sizeMiB * MiB, limits, counters(cgroup.read).current, disk.bavail * disk.bsize)
  if (reason) throw new Error(reason)
  const filename = path.join(dir, "synthetic.sqlite")
  createFixture(filename, kind, sizeMiB * MiB)
  Bun.gc(true)
  const options = {
    db: filename,
    mode: write ? ("write" as const) : ("dry-run" as const),
    offline: write,
    maxPayloadBytes: sizeMiB * MiB,
    maxScanned: 1,
    timings: true,
  }
  const stats = await compressEvents(options)
  const timing = stats.timings
  if (
    !timing ||
    timing.buckets.length !== 1 ||
    timing.buckets[0].phases.compression.count !== 1 ||
    timing.buckets[0].phases.total.count !== 1
  )
    throw new Error("Compressor timing integration missing or incomplete; no trial result produced")
  const peak = readFileSync("/proc/self/status", "utf8").match(/^VmHWM:\s+(\d+)\s+kB$/m)
  if (!peak) throw new Error("Process VmHWM unavailable")
  const compressionMs = timing.buckets[0].phases.compression.totalMs
  const totalMs = timing.buckets[0].phases.total.totalMs
  console.log(
    JSON.stringify({
      sizeMiB,
      kind,
      repetition,
      mode: options.mode,
      compressionMs,
      totalMs,
      savingsPercent: (100 * (stats.inputBytes - stats.outputBytes)) / stats.inputBytes,
      throughputMiBps: sizeMiB / (compressionMs / 1000),
      processPeakRssBytes: Number(peak[1]) * 1024,
      sampledStatsRssBytes: stats.peakRssBytes,
      cgroup: counters(cgroup.read),
      stats,
    }),
  )
}

function summary(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    mean,
    stddev: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

const help = `Synthetic event compression benchmark (temporary databases only).
Usage: bun script/event-compress-benchmark.ts --run [--sizes-mib 1,4,16] [--classes repetitive,structured,entropy] [--repetitions 3] [--write]
Default is dry-run. Entropy is random base64-like ASCII (six bits per character), not incompressible bytes.
Run in an 8 GiB, swap-free cgroup v2 scope, e.g.:
systemd-run --user --scope --expand-environment=no -p MemoryMax=8G -p MemorySwapMax=0 bun script/event-compress-benchmark.ts --run
SIGINT/SIGTERM stops and joins the active worker, removes its fixtures, and exits 130/143.
`

if (import.meta.main) {
  const controller = new AbortController()
  let interrupted = 0
  const interrupt = () => {
    interrupted ||= 130
    controller.abort()
  }
  const terminate = () => {
    interrupted ||= 143
    controller.abort()
  }
  if (process.argv[2] !== "--worker") {
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
  }
  try {
    if (process.argv[2] === "--worker") {
      if (
        process.argv.length !== 8 ||
        process.argv[3].includes(",") ||
        process.argv[4].includes(",") ||
        !["write", "dry-run"].includes(process.argv[6])
      )
        throw new Error("Invalid worker arguments")
      const parsed = parseBenchmarkArgs([
        "--run",
        "--sizes-mib",
        process.argv[3] ?? "",
        "--classes",
        process.argv[4] ?? "",
        "--repetitions",
        process.argv[5] ?? "",
        ...(process.argv[6] === "write" ? ["--write"] : []),
      ])
      await worker(parsed.sizes[0], parsed.classes[0], parsed.repetitions, parsed.write, process.argv[7] ?? "")
    } else {
      const options = parseBenchmarkArgs(process.argv.slice(2))
      if (options.help) console.log(help)
      else {
        const cgroup = scope()
        const limits = engine()
        console.log(
          JSON.stringify({
            type: "metadata",
            ...limits,
            cgroup: cgroup.dir,
            memoryMax: limit,
            swapMax: 0,
            classes: {
              repetitive: "repeated synthetic text",
              structured: "varying diff-like text",
              entropy: "random base64-like ASCII, six bits per character",
            },
          }),
        )
        const trials: Trial[] = []
        let failed = false
        let stop = false
        runs: for (const size of options.sizes) {
          for (const kind of options.classes) {
            for (let repetition = 1; repetition <= options.repetitions; repetition++) {
              if (controller.signal.aborted) break runs
              const before = counters(cgroup.read)
              const disk = statfsSync(tmpdir())
              const reason = stop
                ? "Stopped after failed trial to avoid escalating memory pressure"
                : skipReason(size * MiB, limits, before.current, disk.bavail * disk.bsize)
              if (reason) {
                console.log(JSON.stringify({ type: "skip", sizeMiB: size, kind, repetition, reason, cgroup: before }))
                continue
              }
              const result = await runBenchmarkTrial(
                [
                  process.execPath,
                  import.meta.path,
                  "--worker",
                  String(size),
                  kind,
                  String(repetition),
                  options.write ? "write" : "dry-run",
                ],
                controller.signal,
              )
              if (controller.signal.aborted) break runs
              const [stdout, stderr, code] = result
              const after = counters(cgroup.read)
              if (code !== 0) {
                failed = true
                stop = true
                console.log(
                  JSON.stringify({
                    type: "failure",
                    sizeMiB: size,
                    kind,
                    repetition,
                    exitCode: code,
                    error: stderr.trim().slice(0, 2048),
                    cgroup: after,
                    oomDelta: after.oom - before.oom,
                    oomKillDelta: after.oomKill - before.oomKill,
                  }),
                )
                continue
              }
              const trial = JSON.parse(stdout) as Trial
              trials.push(trial)
              console.log(
                JSON.stringify({
                  type: "trial",
                  ...trial,
                  oomDelta: after.oom - before.oom,
                  oomKillDelta: after.oomKill - before.oomKill,
                }),
              )
            }
          }
        }
        for (const size of options.sizes)
          for (const kind of options.classes) {
            const group = trials.filter((trial) => trial.sizeMiB === size && trial.kind === kind)
            if (!group.length) continue
            console.error(
              `${size} MiB ${kind} n=${group.length}: ${JSON.stringify({ compressionMs: summary(group.map((t) => t.compressionMs)), totalMs: summary(group.map((t) => t.totalMs)), savingsPercent: summary(group.map((t) => t.savingsPercent)), throughputMiBps: summary(group.map((t) => t.throughputMiBps)) })}`,
            )
          }
        if (failed) process.exitCode = 1
      }
    }
  } catch (cause) {
    if (!(controller.signal.aborted && cause instanceof Error && cause.name === "AbortError"))
      console.error(`${cause instanceof Error ? cause.message : "Benchmark failed"}\n${help}`)
    process.exitCode = 1
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    if (interrupted) process.exitCode = interrupted
  }
}
