import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixture/sqlite-execution.ts", import.meta.url))

async function capture(
  enabled: string | undefined,
  check: (dir: string, logs: string[]) => void,
  mode: "bun" | "node" | "node-bundle" | "volume" = "bun",
) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-sqlite-execution-"))
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_DATA_HOME: dir,
      XDG_CACHE_HOME: dir,
      XDG_STATE_HOME: dir,
      XDG_CONFIG_HOME: dir,
      OPENCODE_HANG_DIAGNOSTICS: "1",
    }
    delete env.OPENCODE_SQLITE_EXECUTION_DIAGNOSTICS
    if (enabled !== undefined) env.OPENCODE_SQLITE_EXECUTION_DIAGNOSTICS = enabled
    const command = [process.execPath, fixture, dir, mode]
    if (mode === "node" || mode === "node-bundle") {
      const bundled = mode === "node-bundle"
      const outdir = bundled ? join(dir, "out", "main", "chunks") : dir
      const naming = bundled ? "node-[hash].js" : "sqlite-execution.mjs"
      const build = await Bun.build({
        entrypoints: [fixture],
        target: "node",
        outdir,
        sourcemap: bundled ? "none" : "inline",
        naming,
      })
      expect(build.success, JSON.stringify(build.logs)).toBe(true)
      command.splice(0, 2, "node", ...(bundled ? [] : ["--enable-source-maps"]), build.outputs[0].path)
    }
    const result = Bun.spawnSync(command, { env, timeout: 15_000 })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    const log = join(dir, "opencode", "log")
    const names = existsSync(log) ? readdirSync(log) : []
    check(
      dir,
      names.filter((name) => name.startsWith(`sqlite-execution-${result.pid}-`)).map((name) => join(log, name)),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readRecords(filename: string) {
  return readFileSync(filename, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
}

const posixTest = process.platform === "win32" ? test.skip : test

posixTest.each(["bun", "node", "node-bundle"] as const)(
  "attributes %s rows, values, startup SQL and transactions before native execution",
  async (runtime) => {
    await capture(
      "1",
      (dir, logs) => {
        expect(logs).toHaveLength(1)
        const file = join(logs[0], "queries.jsonl")
        const records = readRecords(file)
        const starts = records.filter((record) => record.marker === "sqlite_query_start")
        const ends = records.filter((record) => record.marker === "sqlite_query_end")
        const during = JSON.parse(readFileSync(join(dir, "in-native.json"), "utf8"))
        const source =
          runtime === "node-bundle"
            ? /^out\/main\/chunks\/node-[\w-]+\.js:\d+:\d+$/
            : /^packages\/core\/test\/fixture\/sqlite-execution\.ts:\d+:\d+$/
        expect(during).toMatchObject({ marker: "sqlite_query_start", mode: "rows", shape: "SELECT ? AS ?" })
        expect(during.origin).toEqual(expect.arrayContaining([expect.stringMatching(source)]))
        expect(during.fiberID).toEqual(expect.any(Number))
        expect(during.databaseID).toEqual(expect.any(Number))
        expect(starts).toContainEqual(during)
        expect(starts).toContainEqual(expect.objectContaining({ mode: "values", statementID: during.statementID }))
        for (const shape of ["SELECT ?", "SELECT ? FROM ( SELECT ? )"]) {
          const repeated = starts.filter((record) => record.shape === shape)
          expect(repeated).toHaveLength(4)
          expect(new Set(repeated.map((record) => record.statementID)).size).toBe(1)
          for (const record of repeated) expect(record.origin[0]).toMatch(source)
          const origins = repeated.map((record) =>
            runtime === "node-bundle" ? record.origin.join("\n") : record.origin[0],
          )
          expect(new Set(origins).size).toBe(4)
        }
        const first = starts.findIndex((record) => record.shape === "BEGIN DEFERRED")
        const [beginOne, bodyOne, commitOne, beginTwo, bodyTwo, commitTwo] = starts.slice(first, first + 6)
        expect([beginOne, beginTwo].map((record) => record.shape)).toEqual(["BEGIN DEFERRED", "BEGIN DEFERRED"])
        expect([commitOne, commitTwo].map((record) => record.shape)).toEqual(["COMMIT", "COMMIT"])
        expect(beginOne.origin).not.toEqual(beginTwo.origin)
        for (const [begin, body, commit] of [
          [beginOne, bodyOne, commitOne],
          [beginTwo, bodyTwo, commitTwo],
        ]) {
          expect(begin.origin[0]).toMatch(source)
          expect(commit.origin).toEqual(begin.origin)
          expect(body.origin).not.toEqual(begin.origin)
        }
        expect(starts).toContainEqual(expect.objectContaining({ mode: "compatibility", shape: "BEGIN" }))
        expect(starts).toContainEqual(expect.objectContaining({ mode: "wal", shape: "PRAGMA JOURNAL_MODE = WAL ;" }))
        expect(starts.map((record) => record.shape)).toEqual(
          expect.arrayContaining(["BEGIN DEFERRED", "COMMIT", "ROLLBACK"]),
        )
        expect(ends.map((record) => record.queryID)).toEqual(starts.map((record) => record.queryID))
        expect(new Set(starts.map((record) => record.queryID)).size).toBe(starts.length)
        expect(ends.filter((record) => record.status === "failure").map((record) => record.queryID)).toEqual(
          starts.slice(-2).map((record) => record.queryID),
        )
        expect(
          ends.map((record) => record.durationMs).filter((duration) => !Number.isFinite(duration) || duration < 0),
        ).toEqual([])
        expect(ends.find((record) => record.queryID === during.queryID)).toMatchObject({
          status: "success",
          durationMs: expect.any(Number),
          wallClock: expect.any(String),
          uptimeMs: expect.any(Number),
        })
        expect(
          records.filter(
            (record) => record.statementID === during.statementID && record.marker === "sqlite_query_start",
          ),
        ).toHaveLength(2)
        const raw = readFileSync(file, "utf8")
        expect(raw).not.toMatch(
          /fixture[-_](?:bound|inline|alias|dqs|comment|missing)|cafebabe|34567890|12345678|87654321|integer overflow/i,
        )
        if (runtime === "bun") {
          expect(starts.find((record) => record.shape.includes("DISTINCT FROM"))?.shape).toBe(
            "SELECT ? IS DISTINCT FROM ? AS ?",
          )
        }
        expect(starts.find((record) => record.shape.startsWith("SELECT ? AS ? ,"))?.shape).toBe(
          runtime === "bun" ? "SELECT ? AS ? , ? , ? , ? , ?" : "SELECT ? AS ? , ? , ?",
        )
        expect(statSync(logs[0]).mode & 0o777).toBe(0o700)
        expect(statSync(file).mode & 0o777).toBe(0o600)
      },
      runtime,
    )
  },
)

test("hang diagnostics alone and non-opt-in values do not enable SQL tracing", async () => {
  for (const flag of [undefined, "0"]) {
    await capture(flag, (dir, logs) => {
      expect(logs).toEqual([])
      expect(existsSync(join(dir, "in-native.json"))).toBe(false)
    })
  }
})

test.skipIf(process.platform !== "win32")("does not create a capture on Windows even when opted in", async () => {
  await capture("1", (dir, logs) => {
    expect(logs).toEqual([])
    expect(existsSync(join(dir, "in-native.json"))).toBe(false)
  })
})

posixTest(
  "keeps only the active and previous size-bounded JSONL files",
  async () => {
    await capture(
      "1",
      (_dir, logs) => {
        expect(logs).toHaveLength(1)
        expect(readdirSync(logs[0]).sort()).toEqual(["queries.jsonl", "queries.previous.jsonl"])
        for (const name of readdirSync(logs[0])) {
          const file = join(logs[0], name)
          expect(statSync(file).size).toBeLessThanOrEqual(4 * 1024 * 1024)
          expect(readRecords(file).length).toBeGreaterThan(0)
        }
        expect(readRecords(join(logs[0], "queries.previous.jsonl"))[0].queryID).toBeGreaterThan(1)
        expect(readRecords(join(logs[0], "queries.jsonl")).at(-1)).toMatchObject({
          marker: "sqlite_query_end",
          status: "success",
        })
      },
      "volume",
    )
  },
  20_000,
)
