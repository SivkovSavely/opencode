import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFile, cp, mkdir, mkdtemp, readdir, readlink, realpath } from "node:fs/promises"
import path from "node:path"

type ModelRequest = {
  messages: { role: string; content?: unknown }[]
  tools?: { function: { name: string } }[]
}
type Message = {
  info: { role: string; finish?: string; error?: unknown }
  parts: {
    type: string
    text?: string
    tool?: string
    state?: { status: string; output?: string; error?: string; metadata?: { exit?: number; truncated?: boolean } }
  }[]
}

// This intentionally tests the source CLI, HTTP admission, provider streaming and real sandbox,
// not a fake route or a direct ManagedLinux invocation. No parent environment is forwarded.
test("source Serve managed model-to-bash staging", async () => {
  const root = await realpath(path.resolve(import.meta.dir, "../../../.."))
  await mkdir("/tmp/opencode", { recursive: true })
  const evidence = await mkdtemp("/tmp/opencode/managed-ai-")
  const workspace = path.join(evidence, "workspace")
  const toolchain = "/home/savochek/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu"
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(evidence, "home"),
    OPENCODE_TEST_HOME: path.join(evidence, "test-home"),
    XDG_CONFIG_HOME: path.join(evidence, "xdg-config"),
    XDG_DATA_HOME: path.join(evidence, "xdg-data"),
    XDG_CACHE_HOME: path.join(evidence, "xdg-cache"),
    XDG_STATE_HOME: path.join(evidence, "xdg-state"),
    TMPDIR: path.join(evidence, "tmp"),
    OPENCODE_DB: path.join(evidence, "database.sqlite"),
    OPENCODE_CONFIG: path.join(evidence, "config", "opencode.json"),
    OPENCODE_CONFIG_DIR: path.join(evidence, "config"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(evidence, "managed-config"),
    OPENCODE_MANAGED_PROFILE: "1",
    OPENCODE_MANAGED_PLUGIN_ALLOWLIST: "[]",
    OPENCODE_MANAGED_RUST_TOOLCHAIN: toolchain,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_TERMINAL_TITLE: "1",
  }
  for (const key of [
    "HOME",
    "OPENCODE_TEST_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_TEST_MANAGED_CONFIG_DIR",
  ]) {
    await mkdir(env[key]!, { recursive: true })
    expect(await realpath(env[key]!)).toStartWith(`${evidence}/`)
    expect(env[key]!.startsWith(`${workspace}/`)).toBe(false)
    expect(env[key]!.startsWith(`${root}/`)).toBe(false)
  }
  await mkdir(workspace)
  const record = async (event: string, data: unknown) => {
    await appendFile(
      path.join(evidence, "events.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), event, data })}\n`,
    )
  }
  console.log(`Managed AI staging evidence: ${evidence}`)
  const commands: Record<string, string> = {
    success: "printf 'managed-success\\n'; printf 'real-output\\n' > success.txt",
    failure: "rustc --test fail.rs -o /tmp/fail-test && /tmp/fail-test --nocapture",
    long: "printf 'long-start\\n'; sleep 65; printf 'long-complete\\n'",
    bounded: "head -c 2097152 /dev/zero | tr '\\000' x",
    "abort-resume":
      "setsid /bin/sh -c 'sleep 8; printf escaped > abort-resume-late.txt' </dev/null >/dev/null 2>&1 & printf ready > abort-resume-ready.txt; sleep 120",
    "resume-success": "printf 'resumed-success\\n'; printf 'resumed-output\\n' > resumed.txt",
    cancel:
      "setsid /bin/sh -c 'sleep 8; printf escaped > cancelled-late.txt' </dev/null >/dev/null 2>&1 & printf ready > cancel-ready.txt; sleep 120",
    retire:
      "setsid /bin/sh -c 'sleep 8; printf escaped > retired-late.txt' </dev/null >/dev/null 2>&1 & printf ready > retire-ready.txt; sleep 120",
    race: "printf stale > stale-executed.txt",
    replacement: "printf replacement > replacement.txt; printf 'replacement-ok\\n'",
    "baila-build": "cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo build --locked --offline",
    "baila-identifiers":
      "cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib identifier::tests",
    "baila-full": "cd baila-compiler && CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib",
    "baila-full-stack":
      "cd baila-compiler && RUST_MIN_STACK=67108864 CARGO_TARGET_DIR=/tmp/baila-target cargo test --locked --offline --lib -- --quiet",
  }
  await Bun.write(
    path.join(workspace, "fail.rs"),
    '#[test]\nfn deliberate_failure() { assert_eq!(1, 2, "managed-real-rust-failure"); }\n',
  )
  const gate = Promise.withResolvers<void>()
  const raceRequested = Promise.withResolvers<void>()
  const seen: string[] = []
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as ModelRequest
      const turn = body.messages.slice(body.messages.findLastIndex((message) => message.role === "user"))
      const key = JSON.stringify(turn[0]?.content ?? "").match(/STAGING:([a-z-]+)/)?.[1] ?? "unknown"
      const tools = body.tools?.map((tool) => tool.function.name) ?? []
      seen.push(key)
      await record("model-request", { key, tools, path: new URL(request.url).pathname })
      expect(tools.toSorted()).toEqual(["bash", "compress", "skill", "task"])
      const call = !turn.some((message) => message.role === "tool")
      if (key === "race" && call) {
        raceRequested.resolve()
        await gate.promise
      }
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: `chatcmpl-${key}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "staging",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const chunks = [
        chunk({ role: "assistant" }),
        ...(call
          ? [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${key}`,
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: commands[key],
                        description: `Staging ${key}`,
                        timeout: 600000,
                      }),
                    },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ content: "Staging completed." }), chunk({}, "stop")]),
      ]
      await record("model-response", { key, tool: call ? "bash" : undefined })
      return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  await Bun.write(
    env.OPENCODE_CONFIG!,
    JSON.stringify({
      model: "staging/staging",
      small_model: "staging/staging",
      plugin: [],
      mcp: {},
      permission: "allow",
      snapshot: false,
      provider: {
        staging: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local staging",
          options: { baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: {
            staging: { name: "Staging", limit: { context: 128000, output: 8192 } },
          },
        },
      },
    }),
  )
  const poll = async <T>(label: string, check: () => Promise<T | undefined>, timeout = 30000): Promise<T> => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value !== undefined) return value
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}; evidence: ${evidence}`)
  }
  const children: ReturnType<typeof Bun.spawn>[] = []
  const start = async () => {
    const log = path.join(evidence, `serve-${children.length}.log`)
    const child = Bun.spawn(
      [process.execPath, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
      {
        cwd: path.join(root, "packages/opencode"),
        env,
        stdin: "ignore",
        stdout: Bun.file(log),
        stderr: Bun.file(`${log}.stderr`),
      },
    )
    children.push(child)
    const url = await poll(
      "source Serve startup",
      async () => {
        const text = await Bun.file(log).text()
        if (child.exitCode !== null)
          throw new Error(`Serve exited ${child.exitCode}: ${await Bun.file(`${log}.stderr`).text()}`)
        return text.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      },
      60000,
    )
    // No HTTP readiness probe is allowed until the log, environment and actual open DB agree.
    const logs = (await Bun.file(log).text()) + (await Bun.file(`${log}.stderr`).text())
    expect(logs).toContain(`databasePath`)
    expect(logs).toContain(env.OPENCODE_DB!)
    const entries = (await Bun.file(`/proc/${child.pid}/environ`).text()).split("\0").filter(Boolean)
    for (const [key, value] of Object.entries(env)) expect(entries).toContain(`${key}=${value}`)
    expect(entries.some((entry) => /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENCODE_SERVER_PASSWORD)=/.test(entry))).toBe(
      false,
    )
    const fds = await Promise.all(
      (await readdir(`/proc/${child.pid}/fd`)).map(async (fd) =>
        readlink(`/proc/${child.pid}/fd/${fd}`).catch(() => "closed"),
      ),
    )
    expect(fds).toContain(env.OPENCODE_DB!)
    expect(fds.filter((fd) => /\.(sqlite|db)(-wal|-shm)?$/.test(fd)).every((fd) => fd.startsWith(`${evidence}/`))).toBe(
      true,
    )
    await record("pre-http-isolation", {
      pid: child.pid,
      url,
      env: entries,
      databaseFDs: fds.filter((fd) => fd.includes("sqlite")),
      log,
    })
    return { child, url }
  }
  const stop = async (child: ReturnType<typeof Bun.spawn>) => {
    if (child.exitCode !== null) return
    child.kill("SIGTERM")
    await Promise.race([
      child.exited,
      Bun.sleep(15000).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }),
    ])
    await child.exited
  }
  try {
    let server = await start()
    const request = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${server.url}${route}`, {
        method,
        headers: { "Content-Type": "application/json", "x-opencode-directory": workspace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      })
      const text = await response.text()
      await record("http", { route, method, status: response.status, ...(response.ok ? {} : { body: text }) })
      return { status: response.status, data: text ? (JSON.parse(text) as unknown) : undefined }
    }
    const create = async () => {
      const result = await request("/session", "POST", { title: "Disposable managed staging" })
      expect(result.status).toBe(200)
      return (result.data as { id: string }).id
    }
    const prompt = async (id: string, key: string) =>
      request(`/session/${id}/prompt_async`, "POST", {
        model: { providerID: "staging", modelID: "staging" },
        parts: [{ type: "text", text: `STAGING:${key}` }],
      })
    const retire = async (id: string) => {
      const result = await request(`/session/${id}/retire`, "POST")
      expect(result.status).toBe(200)
      await record("command-status", { id, result: result.data })
      return result.data as { commandStatus: string }
    }
    const drained = (id: string) =>
      poll(`root ${id} drained`, async () => {
        const result = await retire(id)
        expect(result.commandStatus).not.toBe("unknown")
        return result.commandStatus === "drained" ? result : undefined
      })
    const run = async (key: string, exit: number | undefined, timeout = 120000, existingID?: string) => {
      const id = existingID ?? (await create())
      const began = Date.now()
      expect((await prompt(id, key)).status).toBe(204)
      const messages = await poll(
        `${key} model/tool completion`,
        async () => {
          const result = await request(`/session/${id}/message`)
          expect(result.status).toBe(200)
          const history = result.data as Message[]
          const messages = history.slice(history.findLastIndex((message) => message.info.role === "user"))
          if (!messages[0]?.parts.some((part) => part.type === "text" && part.text === `STAGING:${key}`))
            return undefined
          const error = messages.find((message) => message.info.error)
          if (error) throw new Error(`${key}: ${JSON.stringify(error)}`)
          return messages.some((message) => message.info.role === "assistant" && message.info.finish === "stop")
            ? messages
            : undefined
        },
        timeout,
      )
      const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
      await record("case-result", { key, id, command: commands[key], elapsedMs: Date.now() - began, tool })
      expect(tool?.tool).toBe("bash")
      expect(tool?.state?.status).toBe("completed")
      if (exit !== undefined) expect(tool?.state?.metadata?.exit).toBe(exit)
      if (exit === undefined)
        expect(tool?.state?.metadata?.exit === 0 || tool?.state?.metadata?.exit === 101).toBe(true)
      await drained(id)
      return { id, tool }
    }
    expect((await run("success", 0)).tool?.state?.output).toContain("managed-success")
    expect(await Bun.file(path.join(workspace, "success.txt")).text()).toBe("real-output\n")
    expect((await run("failure", 101)).tool?.state?.output).toContain("managed-real-rust-failure")
    const began = Date.now()
    expect((await run("long", 0)).tool?.state?.output).toContain("long-complete")
    expect(Date.now() - began).toBeGreaterThanOrEqual(65000)
    const bounded = (await run("bounded", 0)).tool
    expect(bounded?.state?.metadata?.truncated).toBe(true)
    expect(bounded?.state?.output).toContain("discarded output was not saved")
    expect(Buffer.byteLength(bounded?.state?.output ?? "")).toBeLessThan(1100000)
    const resumable = await create()
    expect((await prompt(resumable, "abort-resume")).status).toBe(204)
    await poll("abort-resume detached descendant started", async () =>
      (await Bun.file(path.join(workspace, "abort-resume-ready.txt")).exists()) ? true : undefined,
    )
    expect((await request(`/session/${resumable}/abort`, "POST")).status).toBe(200)
    await poll("aborted tool cleanup and idle root", async () => {
      const messages = await request(`/session/${resumable}/message`)
      expect(messages.status).toBe(200)
      const tools = (messages.data as Message[])
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool")
      if (!tools.length || tools.some((part) => !["completed", "error"].includes(part.state?.status ?? "")))
        return undefined
      const status = await request("/session/status")
      expect(status.status).toBe(200)
      if (((status.data as Record<string, { type: string }>)[resumable]?.type ?? "idle") !== "idle") return undefined
      await record("abort-cleanup-idle", { id: resumable, tools })
      return true
    })
    await Bun.sleep(8500)
    expect(await Bun.file(path.join(workspace, "abort-resume-late.txt")).exists()).toBe(false)
    await record("abort-cleanup-delayed-write-absent", { id: resumable })
    const resumed = await run("resume-success", 0, 120000, resumable)
    expect(resumed.id).toBe(resumable)
    expect(resumed.tool?.state?.output).toContain("resumed-success")
    expect(await Bun.file(path.join(workspace, "resumed.txt")).text()).toBe("resumed-output\n")
    const resumedCount = seen.length
    expect((await prompt(resumable, "success")).status).toBe(409)
    expect(seen.length).toBe(resumedCount)
    await record("abort-resume-verified", { id: resumable, tool: resumed.tool })
    for (const key of ["cancel", "retire"]) {
      const id = await create()
      expect((await prompt(id, key)).status).toBe(204)
      await poll(`${key} detached descendant started`, async () =>
        (await Bun.file(path.join(workspace, `${key}-ready.txt`)).exists()) ? true : undefined,
      )
      if (key === "cancel") expect((await request(`/session/${id}/abort`, "POST")).status).toBe(200)
      await record("retirement-initial", { key, id, result: await retire(id) })
      await drained(id)
      const count = seen.length
      expect((await prompt(id, "success")).status).toBe(409)
      expect(seen.length).toBe(count)
      await Bun.sleep(8500)
      expect(
        await Bun.file(path.join(workspace, key === "cancel" ? "cancelled-late.txt" : "retired-late.txt")).exists(),
      ).toBe(false)
      await record("delayed-write-absent-after-drained", { key, id })
    }
    const race = await create()
    expect((await prompt(race, "race")).status).toBe(204)
    await Promise.race([
      raceRequested.promise,
      Bun.sleep(30000).then(() => {
        throw new Error("Race model not requested")
      }),
    ])
    await retire(race)
    gate.resolve()
    await drained(race)
    expect(await Bun.file(path.join(workspace, "stale-executed.txt")).exists()).toBe(false)
    expect((await prompt(race, "success")).status).toBe(409)
    await record("retired-provider-response-no-execution", { id: race })
    // A replacement is allowed only after all prior roots have reported joined cleanup.
    const replacement = await run("replacement", 0)
    expect(await Bun.file(path.join(workspace, "replacement.txt")).text()).toBe("replacement")
    const bailaResults: {
      key: string
      exit: number | undefined
      validOutput: boolean
      tests?: string
      outcome?: string
    }[] = []
    if (process.env.OPENCODE_MANAGED_BAILA_FIXTURE) {
      const fixture = await realpath(process.env.OPENCODE_MANAGED_BAILA_FIXTURE)
      expect(fixture.startsWith("/tmp/opencode/")).toBe(true)
      expect(fixture.startsWith(root)).toBe(false)
      await Promise.all(
        (await readdir(fixture)).map((entry) =>
          cp(path.join(fixture, entry), path.join(workspace, entry), {
            recursive: true,
            force: false,
            errorOnExist: true,
          }),
        ),
      )
      await record("baila-fixture-copied", { fixture, workspace, hardlinks: false })
      for (const key of ["baila-build", "baila-identifiers", "baila-full", "baila-full-stack"]) {
        const result = await run(key, undefined, 600000)
        const exit = result.tool?.state?.metadata?.exit
        const output = result.tool?.state?.output ?? ""
        const tests = output.match(/running [1-9]\d* tests/)?.[0]
        const outcome = output.match(/test result: [^\r\n]+|fatal runtime error: stack overflow[^\r\n]*/)?.[0]
        bailaResults.push({
          key,
          exit,
          tests,
          outcome,
          validOutput:
            key === "baila-build"
              ? output.includes("Finished `dev` profile")
              : !!tests &&
                (exit === 0
                  ? /^test result: ok\. [1-9]\d* passed/.test(outcome ?? "")
                  : /^test result: FAILED\.|^fatal runtime error: stack overflow/.test(outcome ?? "")),
        })
      }
    }
    await stop(server.child)
    // Insert a deliberately untracked historical root only while the disposable DB is closed.
    const db = new Database(env.OPENCODE_DB!)
    const historical = `ses_historical${Date.now()}`
    db.query(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) SELECT ?, project_id, ?, directory, 'historical untracked', version, time_created, time_updated FROM session WHERE id = ?",
    ).run(historical, historical, replacement.id)
    db.close()
    server = await start()
    expect((await retire(replacement.id)).commandStatus).toBe("drained")
    expect((await prompt(replacement.id, "success")).status).toBe(409)
    expect((await retire(historical)).commandStatus).toBe("unknown")
    await record("durable-restart-verified", { retired: replacement.id, historical })
    await record("baila-results", bailaResults)
    // Attempt every diagnostic before failing focused compiler validation. Full-suite
    // candidate failures are evidence, not silently reclassified as runtime failures.
    expect(
      bailaResults.filter(
        (result) => !result.validOutput || (!result.key.startsWith("baila-full") && result.exit !== 0),
      ),
    ).toEqual([])
    await record("passed", { modelRequests: seen.length })
  } finally {
    gate.resolve()
    await Promise.all(children.map(stop))
    await model.stop(true)
    await record(
      "owned-subprocesses-stopped",
      children.map((child) => ({ pid: child.pid, exitCode: child.exitCode })),
    )
  }
}, 1800000)
