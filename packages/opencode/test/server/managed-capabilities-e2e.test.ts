import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFile, mkdir, mkdtemp, readdir, readlink, realpath } from "node:fs/promises"
import path from "node:path"

type Message = {
  info: { role: string; finish?: string; error?: unknown; summary?: boolean }
  parts: { type: string; text?: string; tool?: string; state?: { status: string; output?: string } }[]
}

// Like managed-ai-e2e, this launches the source CLI with an explicit environment.
// Only the model and project-bound MCP peer are synthetic; admission, tools and sandbox are real.
test("isolated managed WorkQueue, children, compression and joined retirement", async () => {
  const root = await realpath(path.resolve(import.meta.dir, "../../../.."))
  await mkdir("/tmp/opencode", { recursive: true })
  const evidence = await mkdtemp("/tmp/opencode/managed-capabilities-")
  const workspace = path.join(evidence, "workspace")
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
    OPENCODE_MANAGED_RUST_TOOLCHAIN: "/home/savochek/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu",
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
  expect(path.isAbsolute(env.OPENCODE_DB!)).toBe(true)
  expect(await Bun.file(env.OPENCODE_DB!).exists()).toBe(false)
  const record = (event: string, data: unknown) =>
    appendFile(
      path.join(evidence, "events.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), event, data })}\n`,
    )
  console.log(`Managed capabilities evidence: ${evidence}`)
  const poll = async <T>(label: string, check: () => Promise<T | undefined>, timeout = 60000): Promise<T> => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value !== undefined) return value
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}; evidence: ${evidence}`)
  }
  const pendingCall = Promise.withResolvers<void>()
  const releaseCall = Promise.withResolvers<void>()
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  const catalog = [
    {
      name: "wq_get_work",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
    {
      name: "wq_update_progress",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          expectedGeneration: { type: "integer" },
          progress: { type: "string" },
        },
        required: ["issueId", "expectedGeneration", "progress"],
        additionalProperties: false,
      },
    },
  ]
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).search).toBe("?project=STAGING")
      expect(request.method).toBe("POST")
      const body = await request.json()
      await record("mcp-request", body)
      if (body.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "staging-workqueue", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "staging-only" } },
        )
      expect(request.headers.get("mcp-session-id")).toBe("staging-only")
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26")
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: catalog } })
      expect(body.method).toBe("tools/call")
      calls.push(body.params)
      expect(body.params.arguments.issueId).toMatch(/^STAGING-/)
      if (body.params.arguments.progress === "pending-retirement") {
        pendingCall.resolve()
        await releaseCall.promise
      }
      const reply = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                issueId: body.params.arguments.issueId,
                generation: body.params.name === "wq_get_work" ? 7 : 8,
                progress: body.params.arguments.progress ?? "ready",
              }),
            },
          ],
        },
      }
      await record("mcp-response", reply)
      if (body.params.name === "wq_update_progress")
        return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      return Response.json(reply)
    },
  })
  env.OPENCODE_MANAGED_WORK_QUEUE = JSON.stringify({
    url: `http://127.0.0.1:${gateway.port}/mcp?project=STAGING`,
    project: "STAGING",
    directory: workspace,
    tools: catalog.map((tool) => tool.name),
  })
  const turns = new Map<string, number>()
  const seen: { key: string; tools: string[] }[] = []
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content?: unknown }[]
        tools?: { function: { name: string } }[]
      }
      const tools = body.tools?.map((tool) => tool.function.name) ?? []
      const serialized = JSON.stringify(body.messages)
      const key =
        [...JSON.stringify(body.messages.filter((message) => message.role === "user")).matchAll(/CAP:([a-z-]+)/g)].at(
          -1,
        )?.[1] ?? (serialized.includes("Staging summary:") ? "workflow" : "summary")
      seen.push({ key, tools })
      await record("model-request", { key, tools, body })
      const index = turns.get(key) ?? 0
      if (tools.length) turns.set(key, index + 1)
      const bash = (command: string) => ({
        name: "bash",
        args: { command, description: "Disposable staging command", timeout: 600000 },
      })
      const task = (role: string, prompt: string) => ({
        name: "task",
        args: { description: `Staging ${role} check`, prompt, subagent_type: role },
      })
      const workflow = [
        { name: "wq_get_work", args: { issueId: "STAGING-1" } },
        { name: "wq_update_progress", args: { issueId: "STAGING-1", expectedGeneration: 7, progress: "reviewing" } },
        bash("printf 'root-real-output\\n'; printf root > root.txt"),
        task("reviewer", "CAP:review-child"),
        task("verifier", "CAP:verify-child"),
        { name: "compress", args: {} },
        bash("printf 'continued-after-summary\\n'; printf continued > continued.txt"),
      ]
      const selected = !tools.length
        ? undefined
        : key === "workflow"
          ? workflow[index]
          : key === "review-child" && index === 0
            ? bash(
                "cat root.txt; printf 'reviewer-scratch\\n' > /tmp/reviewer.txt && test \"$(cat /tmp/reviewer.txt)\" = reviewer-scratch && printf 'reviewer-scratch-verified\\n'; if printf malicious > reviewed.txt 2>/dev/null; then printf 'source-write-unexpectedly-succeeded\\n'; else printf 'reviewer-readonly-denied\\n'; fi",
              )
            : key === "verify-child" && index === 0
              ? bash(
                  "cat root.txt; printf 'verifier-scratch\\n' > /tmp/verifier.txt && test \"$(cat /tmp/verifier.txt)\" = verifier-scratch && printf 'verifier-scratch-verified\\n'; if printf malicious > verified.txt 2>/dev/null; then printf 'source-write-unexpectedly-succeeded\\n'; else printf 'verifier-readonly-denied\\n'; fi",
                )
              : key === "retire-child-root" && index === 0
                ? task("specialist", "CAP:slow-child")
                : key === "slow-child" && index === 0
                  ? bash(
                      "setsid /bin/sh -c 'sleep 8; printf escaped > child-late.txt' </dev/null >/dev/null 2>&1 & printf ready > child-ready.txt; sleep 120",
                    )
                  : key === "pending-root" && index === 0
                    ? {
                        name: "wq_update_progress",
                        args: { issueId: "STAGING-2", expectedGeneration: 7, progress: "pending-retirement" },
                      }
                    : undefined
      if (tools.length)
        expect(tools.toSorted()).toEqual([
          "bash",
          "compress",
          "skill",
          ...(["review-child", "verify-child", "slow-child"].includes(key) ? [] : ["task"]),
          "wq_get_work",
          ...(["review-child", "verify-child"].includes(key) ? [] : ["wq_update_progress"]),
        ])
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: `chatcmpl-${seen.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "staging",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const chunks = [
        chunk({ role: "assistant" }),
        ...(selected
          ? [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${seen.length}`,
                    type: "function",
                    function: { name: selected.name, arguments: JSON.stringify(selected.args) },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
          : [
              chunk({
                content: tools.length
                  ? "Staging completed."
                  : "Staging summary: CAP:workflow. WorkQueue updated; reviewer and verifier succeeded. Continue after compression.",
              }),
              chunk({}, "stop"),
            ]),
      ]
      return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
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
      agent: {
        reviewer: { mode: "subagent", model: "staging/staging", permission: "allow" },
        verifier: { mode: "subagent", model: "staging/staging", permission: "allow" },
        specialist: { mode: "subagent", model: "staging/staging", permission: "allow" },
      },
      provider: {
        staging: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local staging",
          options: { baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: { staging: { name: "Staging", limit: { context: 128000, output: 8192 } } },
        },
      },
    }),
  )
  const log = path.join(evidence, "serve.log")
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
  try {
    const url = await poll("source Serve startup", async () => {
      if (child.exitCode !== null)
        throw new Error(`Serve exited ${child.exitCode}: ${await Bun.file(`${log}.stderr`).text()}`)
      return (await Bun.file(log).text()).match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    })
    // Verify log, actual process environment and actual DB descriptor before the first HTTP request.
    const logs = (await Bun.file(log).text()) + (await Bun.file(`${log}.stderr`).text())
    expect(logs).toContain("databasePath")
    expect(logs).toContain(env.OPENCODE_DB!)
    const entries = (await Bun.file(`/proc/${child.pid}/environ`).text()).split("\0").filter(Boolean)
    for (const [key, value] of Object.entries(env)) expect(entries).toContain(`${key}=${value}`)
    expect(entries.some((entry) => /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENCODE_SERVER_PASSWORD)=/.test(entry))).toBe(
      false,
    )
    const fds = await Promise.all(
      (await readdir(`/proc/${child.pid}/fd`)).map((fd) =>
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
    const request = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${url}${route}`, {
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
      const result = await request("/session", "POST", { title: "Disposable capabilities staging" })
      expect(result.status).toBe(200)
      return (result.data as { id: string }).id
    }
    const prompt = (id: string, key: string) =>
      request(`/session/${id}/prompt_async`, "POST", {
        model: { providerID: "staging", modelID: "staging" },
        parts: [{ type: "text", text: `CAP:${key}` }],
      })
    const retire = async (id: string) => {
      const result = await request(`/session/${id}/retire`, "POST")
      expect(result.status).toBe(200)
      await record("retirement", { id, result: result.data })
      return result.data as { commandStatus: string }
    }
    const drained = (id: string) =>
      poll(`root ${id} joined`, async () => {
        const result = await retire(id)
        expect(result.commandStatus).not.toBe("unknown")
        return result.commandStatus === "drained" ? true : undefined
      })
    const history = async (id: string) => {
      const result = await request(`/session/${id}/message`)
      expect(result.status).toBe(200)
      const messages = result.data as Message[]
      if (messages.some((message) => message.info.error)) throw new Error(JSON.stringify(messages))
      return messages
    }
    const children = async (id: string) => {
      const result = await request(`/session/${id}/children`)
      expect(result.status).toBe(200)
      return result.data as { id: string; parentID: string; directory: string; workspaceID?: string }[]
    }
    const workflow = await create()
    expect((await prompt(workflow, "workflow")).status).toBe(204)
    const messages = await poll("workflow completion after native summary", async () => {
      const messages = await history(workflow)
      return (await Bun.file(path.join(workspace, "continued.txt")).exists()) && messages.at(-1)?.info.finish === "stop"
        ? messages
        : undefined
    })
    const parts = messages.flatMap((message) => message.parts)
    for (const name of ["wq_get_work", "wq_update_progress", "bash", "task", "compress"])
      expect(parts.some((part) => part.tool === name && part.state?.status === "completed")).toBe(true)
    expect(parts.some((part) => part.type === "compaction")).toBe(true)
    expect(messages.some((message) => message.info.summary === true && message.info.finish === "stop")).toBe(true)
    expect(
      parts
        .filter((part) => part.tool === "bash")
        .map((part) => part.state?.output)
        .join("\n"),
    ).toContain("continued-after-summary")
    expect(await Bun.file(path.join(workspace, "root.txt")).text()).toBe("root")
    const descendants = await children(workflow)
    expect(descendants).toHaveLength(2)
    for (const descendant of descendants) {
      expect(descendant.parentID).toBe(workflow)
      expect(descendant.directory).toBe(workspace)
      expect(descendant.workspaceID).toBeUndefined()
      const output = (await history(descendant.id))
        .flatMap((message) => message.parts)
        .filter((part) => part.tool === "bash")
        .map((part) => part.state?.output)
        .join("\n")
      expect(output).toMatch(/reviewer-readonly-denied|verifier-readonly-denied/)
      expect(output).toContain("root")
      expect(output).toMatch(/reviewer-scratch-verified|verifier-scratch-verified/)
    }
    expect(await Bun.file(path.join(workspace, "reviewed.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(workspace, "verified.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(evidence, "tmp", "reviewer.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(evidence, "tmp", "verifier.txt")).exists()).toBe(false)
    expect(calls).toEqual([
      { name: "wq_get_work", arguments: { issueId: "STAGING-1" } },
      { name: "wq_update_progress", arguments: { issueId: "STAGING-1", expectedGeneration: 7, progress: "reviewing" } },
    ])
    await drained(workflow)
    const db = new Database(env.OPENCODE_DB!, { readonly: true })
    try {
      const members = db
        .query(
          "SELECT session_id, parent_session_id, root_session_id, directory, workspace_id FROM managed_session_member WHERE root_session_id = ? ORDER BY session_id",
        )
        .all(workflow)
      expect(members).toHaveLength(2)
      expect(members).toEqual(
        descendants
          .map((descendant) => ({
            session_id: descendant.id,
            parent_session_id: workflow,
            root_session_id: workflow,
            directory: workspace,
            workspace_id: null,
          }))
          .sort((a, b) => a.session_id.localeCompare(b.session_id)),
      )
      const permits = db
        .query(
          "SELECT session_id, root_session_id, state, execution_generation FROM managed_command WHERE root_session_id = ?",
        )
        .all(workflow) as { session_id: string; root_session_id: string; state: string; execution_generation: string }[]
      expect(permits.every((permit) => permit.state === "confirmed")).toBe(true)
      expect(
        permits
          .filter((permit) => permit.execution_generation === "managed-execution")
          .map((permit) => permit.session_id)
          .sort(),
      ).toEqual([workflow, ...descendants.map((descendant) => descendant.id)].sort())
      await record("workflow-db-evidence", { workflow, members, permits, messages })
    } finally {
      db.close()
    }
    const beforeLate = seen.length
    for (const id of [workflow, ...descendants.map((descendant) => descendant.id)])
      expect((await prompt(id, "workflow")).status).toBe(409)
    expect(seen.length).toBe(beforeLate)
    const running = await create()
    expect((await prompt(running, "retire-child-root")).status).toBe(204)
    await poll("child sandbox started", async () =>
      (await Bun.file(path.join(workspace, "child-ready.txt")).exists()) ? true : undefined,
    )
    const runningChildren = await children(running)
    expect(runningChildren).toHaveLength(1)
    await retire(running)
    await drained(running)
    for (const id of [running, runningChildren[0]!.id]) expect((await prompt(id, "workflow")).status).toBe(409)
    await Bun.sleep(8500)
    expect(await Bun.file(path.join(workspace, "child-late.txt")).exists()).toBe(false)
    await record("retired-child-delayed-write-absent", { running, runningChildren })
    const pending = await create()
    expect((await prompt(pending, "pending-root")).status).toBe(204)
    await poll("gateway mutation dispatched", async () =>
      calls.some((call) => call.arguments.progress === "pending-retirement") ? true : undefined,
    )
    await pendingCall.promise
    expect((await retire(pending)).commandStatus).toBe("draining")
    expect((await retire(pending)).commandStatus).toBe("draining")
    expect((await prompt(pending, "workflow")).status).toBe(409)
    releaseCall.resolve()
    await drained(pending)
    expect(calls.filter((call) => call.arguments.progress === "pending-retirement")).toHaveLength(1)
    const finalCount = seen.length
    expect((await prompt(pending, "workflow")).status).toBe(409)
    expect(seen.length).toBe(finalCount)
    await record("passed", { workflow, descendants, running, pending, calls, modelRequests: seen.length })
  } finally {
    releaseCall.resolve()
    if (child.exitCode === null) child.kill("SIGTERM")
    await Promise.race([
      child.exited,
      Bun.sleep(15000).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }),
    ])
    await child.exited
    await model.stop(true)
    await gateway.stop(true)
    await record("owned-subprocess-stopped", { pid: child.pid, exitCode: child.exitCode })
  }
}, 240000)
