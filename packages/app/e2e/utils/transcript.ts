import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { TranscriptSearch } from "@opencode/schema/transcript-search"

export const transcriptHit = (input: Partial<TranscriptSearch.Hit> = {}): TranscriptSearch.Hit => ({
  documentID: "document",
  messageID: "msg_search",
  partID: "msg_search:text:0",
  sessionID: "ses_search",
  projectID: "project",
  projectPath: "C:/closed",
  directory: "C:/closed",
  title: "Closed historical session",
  role: "user",
  category: "text",
  archived: false,
  timeCreated: 1700000000000,
  excerpt: "😀 needle\n<script>plain text</script>",
  excerptOffset: 0,
  offset: 3,
  matchLength: 6,
  truncated: false,
  ...input,
})

export const transcriptPage = (hits: TranscriptSearch.Hit[], nextCursor?: string): TranscriptSearch.Response => ({
  hits,
  nextCursor,
  status: { ready: true, generation: "fixture", backfillCursor: "part:" },
  scanned: hits.length,
  complete: !nextCursor,
  contentLimit: 65536,
  scanLimit: 500,
  scanLimited: false,
  truncatedDocuments: 0,
})

export async function startTranscriptServer() {
  const root = await mkdtemp(join(tmpdir(), "opencode-f002-browser-"))
  await Promise.all(["home", "config", "cache", "data", "state", "tmp"].map((name) => mkdir(`${root}/${name}`)))
  const log = createWriteStream(`${root}/server.log`)

  const child = spawn(
    "bun",
    [fileURLToPath(new URL("../../../server/test/fixture/transcript-server.ts", import.meta.url))],
    {
      cwd: `${root}/home`,
      env: {
        PATH: process.env.PATH,
        HOME: `${root}/home`,
        USERPROFILE: `${root}/home`,
        APPDATA: `${root}/config`,
        LOCALAPPDATA: `${root}/cache`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_CACHE_HOME: `${root}/cache`,
        XDG_DATA_HOME: `${root}/data`,
        XDG_STATE_HOME: `${root}/state`,
        TMPDIR: `${root}/tmp`,
        TMP: `${root}/tmp`,
        TEMP: `${root}/tmp`,
        OPENCODE_TEST_HOME: `${root}/home`,
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        CI: "1",
        OPENCODE_DISABLE_TELEMETRY: "1",
        TURBO_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const ready = Promise.withResolvers<string>()
  let output = ""
  child.stdout.on("data", (chunk) => {
    output += String(chunk)
    const match = /F002_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output)

    if (match) ready.resolve(match[1]!)
  })
  child.once("error", ready.reject)
  child.once("exit", (code) => ready.reject(new Error(`Fixture exited ${code}; ${root}/server.log`)))

  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit")
      child.kill("SIGTERM")
      await ended
    }

    log.end()
    await Promise.all(
      ["home", "config", "cache", "data", "state", "tmp"].map((name) =>
        rm(`${root}/${name}`, { recursive: true, force: true }),
      ),
    )
  }

  try {
    return { origin: await ready.promise, log: `${root}/server.log`, [Symbol.asyncDispose]: close }
  } catch (error) {
    await close()
    throw error
  }
}
