import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fixturePayload, parseBenchmarkArgs, runBenchmarkTrial } from "../script/event-compress-benchmark"

test("synthetic classes produce exact-size valid JSON", () => {
  for (const kind of ["repetitive", "structured", "entropy"] as const) {
    for (const size of [4096, 4097, 4100]) {
      const bytes = fixturePayload(kind, size)
      expect(bytes.byteLength).toBe(size)
      expect(typeof JSON.parse(bytes.toString()).text).toBe("string")
    }
  }
})

test("benchmark arguments require opt-in and bound case dimensions", () => {
  expect(() => parseBenchmarkArgs([])).toThrow("--run")
  expect(() => parseBenchmarkArgs(["--run", "--db", "x"])).toThrow()
  for (const size of ["0", "1.5", "Infinity", "1025", "1,"])
    expect(() => parseBenchmarkArgs(["--run", "--sizes-mib", size])).toThrow()
  for (const reps of ["0", "11", "1.5"]) expect(() => parseBenchmarkArgs(["--run", "--repetitions", reps])).toThrow()
  expect(() => parseBenchmarkArgs(["--run", "--classes", "other"])).toThrow()
  expect(parseBenchmarkArgs(["--run"]).sizes).toEqual([1, 4, 16])
})

test("worker rejects malformed case arguments before opening a fixture", async () => {
  for (const args of [
    ["1,4", "repetitive", "1", "dry-run", "/not-a-fixture"],
    ["1", "repetitive,entropy", "1", "dry-run", "/not-a-fixture"],
    ["1", "repetitive", "1", "unexpected", "/not-a-fixture"],
    ["1", "repetitive", "1", "dry-run", "/not-a-fixture", "extra"],
  ]) {
    const child = Bun.spawn([process.execPath, "script/event-compress-benchmark.ts", "--worker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain("Invalid worker arguments")
  }
})

test.skipIf(process.platform !== "linux")("an unscoped run fails before creating a fixture", async () => {
  const entry = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((line) => line.startsWith("0::"))
  if (!entry || entry.slice(3).split("/").includes("..")) return
  const dir = path.join("/sys/fs/cgroup", entry.slice(3))
  if (
    readFileSync(path.join(dir, "memory.max"), "utf8").trim() === "8589934592" &&
    readFileSync(path.join(dir, "memory.swap.max"), "utf8").trim() === "0"
  )
    return
  const temp = await mkdtemp(path.join(tmpdir(), "event-benchmark-guard-test-"))
  try {
    const child = Bun.spawn([process.execPath, "script/event-compress-benchmark.ts", "--run"], {
      env: { ...process.env, TMPDIR: temp },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain("cgroup")
    expect(await readdir(temp)).toEqual([])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("cancelling a benchmark trial joins its worker and removes its SQLite fixtures", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "event-benchmark-cancellation-test-"))
  const ready = path.join(temp, "ready.json")
  const controller = new AbortController()
  const running = runBenchmarkTrial(
    [
      process.execPath,
      "-e",
      `const { Database } = await import("bun:sqlite");
       const { renameSync } = await import("node:fs");
       const dir = process.argv.at(-1);
       const db = new Database(dir + "/synthetic.sqlite");
       db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (data TEXT); INSERT INTO fixture VALUES ('small synthetic payload');");
       await Bun.write(${JSON.stringify(ready + ".next")}, JSON.stringify({ dir, pid: process.pid }));
       renameSync(${JSON.stringify(ready + ".next")}, ${JSON.stringify(ready)});
       setInterval(() => db.query("SELECT 1").get(), 1000);`,
    ],
    controller.signal,
  )
  try {
    const deadline = Date.now() + 2000
    while (!(await Bun.file(ready).exists())) {
      if (Date.now() >= deadline) throw new Error("Synthetic worker did not become ready")
      await Bun.sleep(5)
    }
    const worker = (await Bun.file(ready).json()) as { dir: string; pid: number }
    expect(await readdir(worker.dir)).toContain("synthetic.sqlite-wal")
    controller.abort()
    const [, , code] = await running
    expect(code).not.toBe(0)
    expect(() => process.kill(worker.pid, 0)).toThrow()
    await expect(readdir(worker.dir)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    controller.abort()
    await running
    await rm(temp, { recursive: true, force: true })
  }
})

test("an already cancelled trial does not spawn its worker", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    runBenchmarkTrial([process.execPath, "-e", "throw new Error('worker must not start')"], controller.signal),
  ).rejects.toThrow()
})
