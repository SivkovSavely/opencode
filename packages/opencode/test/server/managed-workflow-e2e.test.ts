import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"

// This is opt-in because the source is a real, separately maintained checkout.
// Only git archive reads it; every repository, worktree and Git write is disposable.
test.skipIf(!process.env.OPENCODE_MANAGED_BAILA_FIXTURE)(
  "managed real Baila worktree workflow",
  async () => {
    const source = await realpath(process.env.OPENCODE_MANAGED_BAILA_FIXTURE!)
    expect(await Bun.file(path.join(source, "baila-compiler", "Cargo.lock")).exists()).toBe(true)
    await mkdir("/tmp/opencode", { recursive: true })
    const staging = await mkdtemp("/tmp/opencode/managed-workflow-")
    const home = path.join(staging, "home")
    const hooks = path.join(staging, "empty-hooks")
    const repository = path.join(staging, "repository")
    const remote = path.join(staging, "remote.git")
    const slotA = path.join(staging, "slot-a")
    const slotB = path.join(staging, "slot-b")
    const snapshot = path.join(staging, "snapshot")
    await Promise.all([home, hooks, repository].map((dir) => mkdir(dir)))
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Staging",
      GIT_AUTHOR_EMAIL: "staging@example.invalid",
      GIT_COMMITTER_NAME: "Staging",
      GIT_COMMITTER_EMAIL: "staging@example.invalid",
    }
    const run = async (cwd: string, args: string[], output?: string, extra: Record<string, string> = {}) => {
      const child = Bun.spawn(args, {
        cwd,
        env: { ...env, ...extra },
        stdin: "ignore",
        stdout: output ? Bun.file(output) : "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exit] = await Promise.all([
        typeof child.stdout === "number" ? Promise.resolve("") : new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exit !== 0) throw new Error(`${args.join(" ")} exited ${exit}: ${stderr}`)
      return stdout.trim()
    }
    const git = (cwd: string, ...args: string[]) => run(cwd, ["git", "-c", `core.hooksPath=${hooks}`, ...args])
    let passed = false
    try {
      // No clone, worktree registration, checkout, or lock is performed in the source repository.
      const revision = await git(source, "rev-parse", "--verify", "HEAD^{commit}")
      const archive = path.join(staging, "source.tar")
      await run(source, ["git", "-c", `core.hooksPath=${hooks}`, "archive", "--format=tar", revision], archive)
      await run(repository, ["tar", "-xf", archive])
      expect(await Bun.file(path.join(repository, "baila-compiler/.cargo/config.toml")).text()).toMatch(
        /RUST_MIN_STACK\s*=\s*"16777216"/,
      )
      await git(repository, "init", "--initial-branch=main")
      await git(repository, "add", "--all", "--force")
      await git(repository, "commit", "-m", "Import archived Baila source")
      await git(staging, "init", "--bare", "--initial-branch=main", remote)
      await git(repository, "remote", "add", "origin", remote)
      await git(repository, "push", "origin", "main")
      await git(repository, "worktree", "add", "-b", "slot-a", slotA, "main")
      await git(repository, "worktree", "add", "-b", "slot-b", slotB, "main")

      // A clone rather than a copied linked-worktree .git file prevents exposure of
      // the common Git directory; remove all executable hooks and remote config.
      await git(staging, "clone", "--no-local", "--no-hardlinks", "--no-checkout", slotA, snapshot)
      const snapshotGit = path.join(snapshot, ".git")
      await rm(path.join(snapshotGit, "hooks"), { recursive: true, force: true })
      await Bun.write(path.join(snapshotGit, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n")
      await git(snapshot, "read-tree", "HEAD")
      expect(await Bun.file(path.join(snapshotGit, "index")).exists()).toBe(true)
      expect(await Bun.file(path.join(snapshotGit, "objects", "info", "alternates")).exists()).toBe(false)
      expect(await Bun.file(path.join(snapshotGit, "hooks")).exists()).toBe(false)
      expect(await readFile(path.join(snapshotGit, "config"), "utf8")).toBe(
        "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
      )
      const common = await realpath(await git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"))
      expect(common).toStartWith(`${staging}/`)
      expect(await realpath(await git(slotA, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(common)
      expect(await realpath(await git(slotB, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(common)
      expect(await realpath(await git(snapshot, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(
        await realpath(snapshotGit),
      )
      expect(await git(slotA, "rev-parse", "HEAD")).toBe(await git(slotB, "rev-parse", "HEAD"))
      expect(await git(slotA, "rev-parse", "HEAD")).toBe(await git(snapshot, "rev-parse", "HEAD"))
      expect(await git(slotA, "status", "--porcelain")).toBe("")
      expect(await git(slotB, "status", "--porcelain")).toBe("")
      const snapshotB = path.join(staging, "snapshot-b")
      await git(staging, "clone", "--no-local", "--no-hardlinks", "--no-checkout", slotB, snapshotB)
      await rm(path.join(snapshotB, ".git", "hooks"), { recursive: true, force: true })
      await Bun.write(path.join(snapshotB, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n")
      await git(snapshotB, "read-tree", "HEAD")
      const cargoHome = path.join(staging, "cargo-home")
      await mkdir(cargoHome)
      await cp("/home/savochek/.cargo/registry", path.join(cargoHome, "registry"), { recursive: true })
      const toolchain = "/home/savochek/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu"
      await run(
        slotA,
        [
          path.join(toolchain, "bin/cargo"),
          "vendor",
          "--locked",
          "--offline",
          "--manifest-path",
          "baila-compiler/Cargo.toml",
          "vendor",
        ],
        undefined,
        { CARGO_HOME: cargoHome, PATH: `${toolchain}/bin:/usr/bin:/bin` },
      )
      await runWorkflow({
        staging,
        repository,
        remote,
        slotA,
        slotB,
        snapshotGit,
        snapshotB: path.join(snapshotB, ".git"),
        common,
        toolchain,
        git,
      })
      passed = true
    } finally {
      await rm(path.join(staging, "cargo-home"), { recursive: true, force: true })
      await rm(path.join(slotA, "vendor"), { recursive: true, force: true })
      console.log(`Managed workflow ${passed ? "success" : "failure"} evidence: ${staging}`)
    }
  },
  1800000,
)

type Part = {
  type: string
  text?: string
  tool?: string
  state?: { status: string; output?: string; error?: string; metadata?: { exit?: number | null } }
}
type Message = { info: { finish?: string; error?: unknown; summary?: boolean }; parts: Part[] }

async function runWorkflow(input: {
  staging: string
  repository: string
  remote: string
  slotA: string
  slotB: string
  snapshotGit: string
  snapshotB: string
  common: string
  toolchain: string
  git: (cwd: string, ...args: string[]) => Promise<string>
}) {
  const root = await realpath(path.resolve(import.meta.dir, "../../../.."))
  const original = await Bun.file(path.join(input.slotA, "baila-compiler/src/lib.rs")).text()
  expect(original.startsWith("//! The Baila compiler, as a library.\n")).toBe(true)
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  let pushedSHA = ""
  let candidateSHA = ""
  const issues: Record<string, { generation: number; phase: string; checkout: string }> = {
    "STAGING-1": { generation: 7, phase: "working", checkout: input.slotA },
    "STAGING-2": { generation: 7, phase: "working", checkout: input.slotB },
  }
  const names = ["wq_get_work", "wq_update_progress", "wq_ready_to_integrate", "wq_mark_done"]
  const catalog = names.map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        ...(name === "wq_get_work"
          ? {}
          : { checkoutPath: { type: "string" }, expectedGeneration: { type: "integer" }, value: { type: "string" } }),
      },
      required: name === "wq_get_work" ? ["issueId"] : ["issueId", "checkoutPath", "expectedGeneration", "value"],
      additionalProperties: false,
    },
  }))
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).search).toBe("?project=STAGING")
      const body = await request.json()
      if (body.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "staging", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "staging" } },
        )
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list")
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: catalog } })
      expect(body.method).toBe("tools/call")
      const call = body.params as (typeof calls)[number]
      calls.push(call)
      const issue = issues[String(call.arguments.issueId)]
      expect(issue).toBeDefined()
      if (call.name !== "wq_get_work") {
        expect(call.arguments.checkoutPath).toBe(issue!.checkout)
        expect(call.arguments.expectedGeneration).toBe(issue!.generation)
        if (call.name === "wq_update_progress") expect(issue!.phase).toBe("working")
        if (call.name === "wq_ready_to_integrate") expect(issue!.phase).toBe("working")
        if (call.name === "wq_mark_done") {
          expect(issue!.phase).toBe("pushed")
          expect(call.arguments.value).toBe(pushedSHA)
        }
        issue!.generation++
        issue!.phase =
          call.name === "wq_ready_to_integrate" ? "ready" : call.name === "wq_mark_done" ? "done" : "working"
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(issue) }] },
      })
    },
  })
  const bash = (command: string) => ({
    name: "bash",
    args: { command, description: "Staging workflow", timeout: 600000 },
  })
  const task = (role: string, key: string) => ({
    name: "task",
    args: { description: `Staging ${key}`, prompt: `WF:${key}`, subagent_type: role },
  })
  const mutation = (name: string, generation: number, value: string) => ({
    name,
    args: { issueId: "STAGING-1", checkoutPath: input.slotA, expectedGeneration: generation, value },
  })
  const reviewCommand = () =>
    [
      `test "$(git rev-parse HEAD)" = "${candidateSHA}" || exit 5`,
      "git diff --cached --quiet || exit 6",
      "git status --short >/dev/null || exit 1",
      "if printf forbidden >> baila-compiler/src/lib.rs; then exit 2; fi",
      "if git config --local staging.forbidden yes; then exit 3; fi",
      "if git update-ref refs/heads/forbidden HEAD; then exit 4; fi",
      "printf REVIEW_READ_ONLY_OK",
    ].join("; ")
  const compiler = (stack: number | undefined, filter = "identifier::tests") =>
    bash(
      `mkdir -p /tmp/cargo-home; printf '[source.crates-io]\\nreplace-with = "vendored-sources"\\n[source.vendored-sources]\\ndirectory = "/work/vendor"\\n' > /tmp/cargo-home/config.toml; cd baila-compiler; CARGO_HOME=/tmp/cargo-home CARGO_TARGET_DIR=/tmp/baila-target CARGO_BUILD_JOBS=2 ${stack === undefined ? "" : `RUST_MIN_STACK=${stack} `}cargo test --locked --offline --lib ${filter} -- --quiet --test-threads=4`,
    )
  const workflow = [
    { name: "skill", args: { name: "commit-work" } },
    { name: "wq_get_work", args: { issueId: "STAGING-1" } },
    {
      name: "wq_update_progress",
      args: {
        issueId: "STAGING-2",
        checkoutPath: input.slotA,
        expectedGeneration: 7,
        value: "wrong-issue-must-not-dispatch",
      },
    },
    mutation("wq_update_progress", 7, "reviewing"),
    bash(
      'test "$GIT_DIR" = /git && test "$GIT_WORK_TREE" = /work && test "$GIT_OPTIONAL_LOCKS" = 0 && test -z "$(git remote)" && test ! -e "$HOME/.git-credentials" && git status --short && sed -i \'1c//! The Baila compiler, as a staging library.\' baila-compiler/src/lib.rs && printf EDIT_OK',
    ),
    bash(
      "cp baila-compiler/src/lib.rs /tmp/original.rs; printf '\\nthis is not valid rust;\\n' >> baila-compiler/src/lib.rs; rustc --edition=2024 --crate-type lib baila-compiler/src/lib.rs -o /tmp/invalid.rlib > /tmp/invalid.log 2>&1; result=$?; cp /tmp/original.rs baila-compiler/src/lib.rs; test $result -ne 0 && grep -q 'expected' /tmp/invalid.log && printf SOURCE_FAILURE_REPAIRED",
    ),
    compiler(2097152),
    compiler(67108864),
    compiler(2097152, ""),
    compiler(67108864, ""),
    compiler(undefined, ""),
    task("reviewer", "review-one"),
    task("reviewer", "review-two"),
    task("verifier", "verify"),
    { name: "compress", args: {} },
    mutation("wq_update_progress", 8, "prepared"),
  ]
  const turns = new Map<string, number>()
  const phaseCatalogs: Record<string, string[][]> = { ready: [], finish: [] }
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content?: unknown }[]
        tools?: { function: { name: string } }[]
      }
      const tools = body.tools?.map((tool) => tool.function.name) ?? []
      const key =
        [...JSON.stringify(body.messages.filter((message) => message.role === "user")).matchAll(/WF:([a-z-]+)/g)].at(
          -1,
        )?.[1] ?? (JSON.stringify(body.messages).includes("Summary WF:workflow") ? "workflow" : "summary")
      if (tools.length && phaseCatalogs[key]) phaseCatalogs[key].push(tools)
      const index = turns.get(key) ?? 0
      if (tools.length) turns.set(key, index + 1)
      const selected = !tools.length
        ? undefined
        : key === "workflow"
          ? workflow[index]
          : [
                "review-one",
                "review-two",
                "verify",
                "review-resolution-one",
                "review-resolution-two",
                "verify-resolution",
              ].includes(key)
            ? index === 0
              ? bash(reviewCommand())
              : index === 1
                ? mutation("wq_update_progress", 8, "child-must-not-dispatch")
                : undefined
            : key === "resolution"
              ? [
                  compiler(2097152),
                  compiler(67108864),
                  compiler(2097152, ""),
                  compiler(67108864, ""),
                  compiler(undefined, ""),
                  task("reviewer", "review-resolution-one"),
                  task("reviewer", "review-resolution-two"),
                  task("verifier", "verify-resolution"),
                ][index]
              : key === "ready"
                ? index === 0
                  ? mutation("wq_ready_to_integrate", 9, "reviewed")
                  : undefined
                : key === "slot-b"
                  ? index === 0
                    ? { name: "wq_get_work", args: { issueId: "STAGING-2" } }
                    : index === 1
                      ? mutation("wq_update_progress", 7, "slot-b-wrong-issue-must-not-dispatch")
                      : index === 2
                        ? bash("git status --short && printf SLOT_B_OK")
                        : undefined
                  : key === "finish"
                    ? index === 0
                      ? mutation("wq_mark_done", 10, pushedSHA)
                      : undefined
                    : undefined
      if (
        selected &&
        ![
          "review-one",
          "review-two",
          "verify",
          "review-resolution-one",
          "review-resolution-two",
          "verify-resolution",
        ].includes(key) &&
        !tools.includes(selected.name)
      ) {
        console.error(`Managed workflow ${key} step ${index}: missing ${selected.name}; available: ${tools.join(", ")}`)
      }
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: `chatcmpl-${key}-${index}`,
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
                    id: `call_${key}_${index}`,
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
                  ? "Prepared staging response."
                  : `Summary WF:workflow. Bound issue STAGING-1, checkout ${input.slotA}, generation 8, phase working. Candidate changes baila-compiler/src/lib.rs to the staging library; tests and reviews completed. Continue with progress prepared.`,
              }),
              chunk({}, "stop"),
            ]),
      ]
      return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const children: ReturnType<typeof Bun.spawn>[] = []
  const poll = async <T>(label: string, check: () => Promise<T | undefined>, timeout = 120000): Promise<T> => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value !== undefined) return value
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}; staging ${input.staging}`)
  }
  const stop = async (child: (typeof children)[number]) => {
    if (child.exitCode === null) child.kill("SIGTERM")
    await Promise.race([
      child.exited,
      Bun.sleep(15000).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }),
    ])
    await child.exited
  }
  const start = async (slot: string, snapshot: string, issueId: string, label: string, tools: string[]) => {
    const base = path.join(input.staging, label)
    for (const name of ["home", "test-home", "config", "data", "cache", "state", "tmp", "managed", "skills"])
      await mkdir(path.join(base, name), { recursive: true })
    const skill = path.join(base, "skills", "SKILL.md")
    await Bun.write(skill, await Bun.file(await realpath("/home/savochek/.agents/skills/commit-work/SKILL.md")).text())
    const config = path.join(base, "config", "opencode.json")
    await Bun.write(
      config,
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
        },
        provider: {
          staging: {
            npm: "@ai-sdk/openai-compatible",
            name: "Staging",
            options: { baseURL: `http://127.0.0.1:${model.port}/v1` },
            models: { staging: { name: "Staging", limit: { context: 128000, output: 8192 } } },
          },
        },
      }),
    )
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: path.join(base, "home"),
      OPENCODE_TEST_HOME: path.join(base, "test-home"),
      XDG_CONFIG_HOME: path.join(base, "config"),
      XDG_DATA_HOME: path.join(base, "data"),
      XDG_CACHE_HOME: path.join(base, "cache"),
      XDG_STATE_HOME: path.join(base, "state"),
      TMPDIR: path.join(base, "tmp"),
      OPENCODE_DB: path.join(base, "database.sqlite"),
      OPENCODE_CONFIG: config,
      OPENCODE_CONFIG_DIR: path.join(base, "config"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(base, "managed"),
      OPENCODE_MANAGED_PROFILE: "1",
      OPENCODE_MANAGED_PLUGIN_ALLOWLIST: "[]",
      OPENCODE_MANAGED_RUST_TOOLCHAIN: input.toolchain,
      OPENCODE_MANAGED_WORKSPACE: slot,
      OPENCODE_MANAGED_GIT: JSON.stringify({ directory: slot, snapshot }),
      OPENCODE_MANAGED_SKILLS: JSON.stringify({ "commit-work": skill }),
      OPENCODE_MANAGED_WORK_QUEUE: JSON.stringify({
        url: `http://127.0.0.1:${gateway.port}/mcp?project=STAGING`,
        project: "STAGING",
        directory: slot,
        issueId,
        tools,
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_TERMINAL_TITLE: "1",
    }
    const log = path.join(base, `serve-${children.length}.log`)
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
    const url = await poll(`serve ${label}`, async () => {
      if (child.exitCode !== null)
        throw new Error(
          `Serve exited ${child.exitCode}: ${await Bun.file(`${log}.stderr`).text()} ${await Bun.file(log).text()}`,
        )
      return (await Bun.file(log).text()).match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    })
    const request = async (route: string, method = "GET", body?: unknown, directory = slot) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { "Content-Type": "application/json", "x-opencode-directory": directory },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      })
      const text = await response.text()
      return { status: response.status, data: text ? (JSON.parse(text) as unknown) : undefined }
    }
    const create = async () => {
      const response = await request("/session", "POST", { title: "Staging workflow" })
      expect(response.status).toBe(200)
      return (response.data as { id: string }).id
    }
    const prompt = (id: string, key: string) =>
      request(`/session/${id}/prompt_async`, "POST", {
        model: { providerID: "staging", modelID: "staging" },
        parts: [{ type: "text", text: `WF:${key}` }],
      })
    const history = async (id: string) => {
      const response = await request(`/session/${id}/message`)
      expect(response.status).toBe(200)
      const messages = response.data as Message[]
      if (messages.some((message) => message.info.error)) throw new Error(JSON.stringify(messages))
      return messages
    }
    const completed = (id: string) =>
      poll(
        `session ${id}`,
        async () => {
          const messages = await history(id)
          const diagnostics = await Bun.file(`${log}.stderr`).text()
          const failure = diagnostics
            .split("\n")
            .find((line) => line.includes("prompt_async failed") && line.includes(id))
          if (failure) throw new Error(failure)
          return messages.at(-1)?.info.finish === "stop" ? messages : undefined
        },
        900000,
      )
    const drain = async (id: string) =>
      poll(`retirement ${id}`, async () => {
        const result = await request(`/session/${id}/retire`, "POST")
        expect(result.status).toBe(200)
        const receipt = result.data as {
          rootSessionID: string
          sessionIDs: string[]
          commandStatus: string
          membershipCoverage?: string
          historicalCleanup?: string
          evidenceHash?: string
        }
        expect(receipt.rootSessionID).toBe(id)
        expect(receipt.sessionIDs).toContain(id)
        expect(receipt.commandStatus).not.toBe("unknown")
        expect(receipt.membershipCoverage).toBeUndefined()
        expect(receipt.historicalCleanup).toBeUndefined()
        expect(receipt.evidenceHash).toBeUndefined()
        if (receipt.commandStatus !== "drained") return undefined
        const status = await request("/session/status")
        expect(status.status).toBe(200)
        const executions = status.data as Record<string, { type: string }>
        if (receipt.sessionIDs.some((sessionID) => (executions[sessionID]?.type ?? "idle") !== "idle")) return undefined
        return {
          ...receipt,
          executions: Object.fromEntries(
            receipt.sessionIDs.map((sessionID) => [sessionID, executions[sessionID]?.type ?? "idle"]),
          ),
        }
      })
    return { child, url, request, create, prompt, history, completed, drain }
  }
  try {
    const preparation = ["wq_get_work", "wq_update_progress"]
    const readiness = ["wq_get_work", "wq_ready_to_integrate"]
    const completion = ["wq_get_work", "wq_mark_done"]
    let a = await start(input.slotA, input.snapshotGit, "STAGING-1", "serve-a", preparation)
    const b = await start(input.slotB, input.snapshotB, "STAGING-2", "serve-b", preparation)
    const base = await input.git(input.slotA, "rev-parse", "HEAD")
    candidateSHA = base
    const gitPointer = await Bun.file(path.join(input.slotA, ".git")).text()
    const worktreeGit = await realpath(await input.git(input.slotA, "rev-parse", "--path-format=absolute", "--git-dir"))
    expect(worktreeGit).toStartWith(`${input.common}/worktrees/`)
    const rootA = await a.create()
    const rootB = await b.create()
    const denied = await fetch(`${b.url}/session`, { headers: { "x-opencode-directory": input.slotA } })
    expect(denied.status).toBe(403)
    const snapshotHead = await readFile(path.join(input.snapshotGit, "HEAD"))
    const snapshotIndex = await readFile(path.join(input.snapshotGit, "index"))
    expect((await a.prompt(rootA, "workflow")).status).toBe(204)
    expect((await b.prompt(rootB, "slot-b")).status).toBe(204)
    const [messages, messagesB] = await Promise.all([a.completed(rootA), b.completed(rootB)])
    const parts = messages.flatMap((message) => message.parts)
    const output = (name: string) =>
      parts
        .filter((part) => part.tool === name)
        .map((part) => part.state?.output ?? "")
        .join("\n")
    expect(output("skill")).toContain("# Commit work")
    expect(output("bash")).toContain("EDIT_OK")
    expect(output("bash")).toContain("SOURCE_FAILURE_REPAIRED")
    expect(parts.some((part) => part.tool === "wq_get_work" && part.state?.status === "completed")).toBe(true)
    expect(calls.filter((call) => call.arguments.value === "wrong-issue-must-not-dispatch")).toHaveLength(0)
    expect(calls.filter((call) => call.arguments.value === "slot-b-wrong-issue-must-not-dispatch")).toHaveLength(0)
    expect(
      calls.filter((call) => call.name === "wq_update_progress" && call.arguments.value === "reviewing"),
    ).toHaveLength(1)
    expect(
      calls.filter((call) => call.name === "wq_update_progress" && call.arguments.value === "prepared"),
    ).toHaveLength(1)
    expect(calls.filter((call) => call.name === "wq_ready_to_integrate")).toHaveLength(0)
    const compilerResults = parts
      .filter((part) => part.tool === "bash")
      .slice(2, 7)
      .map((part) => ({ exit: part.state?.metadata?.exit, output: part.state?.output ?? "" }))
    expect(compilerResults).toHaveLength(5)
    // Preserve both outcomes separately: stack-sensitive failures are not reported as successes.
    console.log(
      "Managed Baila test outcomes",
      JSON.stringify(
        compilerResults.map((result, index) => ({
          suite: index < 2 ? "identifier" : "full-lib",
          stack: [2097152, 67108864, 2097152, 67108864, 16777216][index],
          exit: result.exit,
          outcome: result.output.match(
            /test result: [^\n]+|fatal runtime error: stack overflow[^\n]*|Managed command: timeout\./,
          )?.[0],
        })),
      ),
    )
    for (const result of compilerResults) expect(result.output).toMatch(/running [1-9]\d* tests/)
    for (const result of compilerResults.slice(2)) {
      if (result.exit === 0) expect(result.output).toMatch(/test result: ok\. [1-9]\d* passed/)
      else {
        expect(result.exit).toBeDefined()
        expect(result.output).toMatch(
          /test result: FAILED|fatal runtime error: stack overflow|Managed command: timeout\./,
        )
      }
    }
    expect(compilerResults[0]!.exit).toBe(0)
    expect(compilerResults[1]!.exit).toBe(0)
    expect(compilerResults[3]!.exit).toBe(0)
    expect(compilerResults[4]!.exit).toBe(0)
    expect(parts.some((part) => part.type === "compaction")).toBe(true)
    expect(messages.some((message) => message.info.summary)).toBe(true)
    const summary = messages
      .filter((message) => message.info.summary)
      .flatMap((message) => message.parts)
      .map((part) => part.text ?? "")
      .join("\n")
    expect(summary).toContain(`Bound issue STAGING-1, checkout ${input.slotA}, generation 8`)
    expect(summary).toContain("Candidate changes baila-compiler/src/lib.rs to the staging library")
    expect(await readFile(path.join(input.snapshotGit, "HEAD"))).toEqual(snapshotHead)
    expect(await readFile(path.join(input.snapshotGit, "index"))).toEqual(snapshotIndex)
    expect(
      messagesB.flatMap((message) => message.parts).some((part) => part.state?.output?.includes("SLOT_B_OK")),
    ).toBe(true)
    expect(calls.some((call) => call.name === "wq_get_work" && call.arguments.issueId === "STAGING-2")).toBe(true)
    const descendantsResponse = await a.request(`/session/${rootA}/children`)
    expect(descendantsResponse.status).toBe(200)
    const descendants = descendantsResponse.data as { id: string; parentID: string; directory: string }[]
    expect(descendants).toHaveLength(3)
    for (const child of descendants) {
      expect(child.parentID).toBe(rootA)
      expect(child.directory).toBe(input.slotA)
      const childParts = (await a.history(child.id)).flatMap((message) => message.parts)
      expect(
        childParts.some(
          (part) =>
            part.tool === "bash" &&
            part.state?.output?.includes("REVIEW_READ_ONLY_OK") &&
            part.state.metadata?.exit === 0,
        ),
      ).toBe(true)
    }
    for (const key of ["review-one", "review-two", "verify"]) expect(turns.get(key)).toBeGreaterThanOrEqual(2)
    expect(calls.filter((call) => call.arguments.value === "child-must-not-dispatch")).toHaveLength(0)
    const [preparationReceipt, slotBReceipt] = await Promise.all([a.drain(rootA), b.drain(rootB)])
    expect(preparationReceipt.sessionIDs.toSorted()).toEqual(
      [rootA, ...descendants.map((child) => child.id)].toSorted(),
    )
    for (const id of [rootA, ...descendants.map((child) => child.id)])
      expect((await a.prompt(id, "workflow")).status).toBe(409)
    await Promise.all([stop(a.child), stop(b.child)])
    let receipt = preparationReceipt

    // The trusted fixture is the only Git writer. Every integration phase checks
    // checkout identity, phase, queue generation and exact expected parent first.
    const gate = async (head: string, phase: string, generation: number) => {
      expect(await realpath(input.slotA)).toBe(input.slotA)
      expect(await input.git(input.slotA, "rev-parse", "--show-toplevel")).toBe(input.slotA)
      expect(await Bun.file(path.join(input.slotA, ".git")).text()).toBe(gitPointer)
      expect(await realpath(await input.git(input.slotA, "rev-parse", "--path-format=absolute", "--git-dir"))).toBe(
        worktreeGit,
      )
      expect(
        await realpath(await input.git(input.slotA, "rev-parse", "--path-format=absolute", "--git-common-dir")),
      ).toBe(input.common)
      expect(await input.git(input.slotA, "remote", "get-url", "origin")).toBe(input.remote)
      expect(await input.git(input.slotA, "branch", "--show-current")).toBe("slot-a")
      expect(await input.git(input.slotA, "rev-parse", "HEAD")).toBe(head)
      expect(issues["STAGING-1"]).toEqual({ generation, phase, checkout: input.slotA })
      expect(receipt.commandStatus).toBe("drained")
      expect(Object.values(receipt.executions).every((state) => state === "idle")).toBe(true)
      expect(a.child.exitCode).not.toBeNull()
      expect(b.child.exitCode).not.toBeNull()
    }
    await gate(base, "working", 9)
    expect(await input.git(input.slotA, "diff", "--name-only")).toBe("baila-compiler/src/lib.rs")
    expect(await Bun.file(path.join(input.slotA, "baila-compiler/src/lib.rs")).text()).toBe(
      original.replace("//! The Baila compiler, as a library.", "//! The Baila compiler, as a staging library."),
    )
    await input.git(input.slotA, "add", "--", "baila-compiler/src/lib.rs")
    await input.git(
      input.slotA,
      "commit",
      "-m",
      "fix(compiler): update staging library description",
      "-m",
      "Refs: STAGING-1",
    )
    const prepared = await input.git(input.slotA, "rev-parse", "HEAD")
    expect(await input.git(input.slotA, "rev-parse", "HEAD^")).toBe(base)
    expect(await input.git(input.slotA, "log", "-1", "--format=%B")).toContain("Refs: STAGING-1")
    await gate(prepared, "working", 9)
    expect(await input.git(input.repository, "rev-parse", "HEAD")).toBe(base)
    expect(await input.git(input.remote, "rev-parse", "refs/heads/main")).toBe(base)
    await Bun.write(
      path.join(input.repository, "baila-compiler/src/lib.rs"),
      original.replace("//! The Baila compiler, as a library.", "//! The Baila compiler, as an upstream library."),
    )
    await input.git(input.repository, "add", "--", "baila-compiler/src/lib.rs")
    await input.git(input.repository, "commit", "-m", "Staging upstream change")
    const upstream = await input.git(input.repository, "rev-parse", "HEAD")
    await input.git(input.repository, "push", "origin", "main")
    await gate(prepared, "working", 9)
    await input.git(input.slotA, "fetch", "origin", "main")
    expect(await input.git(input.slotA, "rev-parse", "FETCH_HEAD")).toBe(upstream)
    await expect(input.git(input.slotA, "rebase", "FETCH_HEAD")).rejects.toThrow()
    expect(await input.git(input.slotA, "diff", "--name-only", "--diff-filter=U")).toBe("baila-compiler/src/lib.rs")
    await Bun.write(
      path.join(input.slotA, "baila-compiler/src/lib.rs"),
      original.replace(
        "//! The Baila compiler, as a library.",
        "//! The Baila compiler, as an upstream and staging library.",
      ),
    )
    expect(await input.git(input.slotA, "rev-parse", "HEAD")).toBe(upstream)
    expect(await Bun.file(path.join(input.slotA, ".git")).text()).toBe(gitPointer)
    expect(await realpath(await input.git(input.slotA, "rev-parse", "--path-format=absolute", "--git-dir"))).toBe(
      worktreeGit,
    )
    expect(issues["STAGING-1"]).toEqual({ generation: 9, phase: "working", checkout: input.slotA })
    await input.git(input.slotA, "add", "--", "baila-compiler/src/lib.rs")
    await input.git(input.slotA, "-c", "core.editor=true", "rebase", "--continue")
    const integrated = await input.git(input.slotA, "rev-parse", "HEAD")
    await gate(integrated, "working", 9)
    expect(await input.git(input.slotA, "rev-parse", "HEAD^")).toBe(upstream)
    expect(await input.git(input.slotA, "log", "-1", "--format=%B")).toContain("Refs: STAGING-1")
    // No managed command is active. Replace, rather than mutate, the Git view
    // so all re-reviewers observe the rebased candidate's own HEAD and index.
    await rm(path.dirname(input.snapshotGit), { recursive: true, force: true })
    await input.git(
      input.staging,
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      input.slotA,
      path.dirname(input.snapshotGit),
    )
    await rm(path.join(input.snapshotGit, "hooks"), { recursive: true, force: true })
    await Bun.write(path.join(input.snapshotGit, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n")
    await input.git(path.dirname(input.snapshotGit), "read-tree", "HEAD")
    expect(await input.git(path.dirname(input.snapshotGit), "rev-parse", "HEAD")).toBe(integrated)
    candidateSHA = integrated
    const resolvedCandidate = await readFile(path.join(input.slotA, "baila-compiler/src/lib.rs"))
    const resolvedHead = await readFile(path.join(input.snapshotGit, "HEAD"))
    const resolvedIndex = await readFile(path.join(input.snapshotGit, "index"))
    a = await start(input.slotA, input.snapshotGit, "STAGING-1", "serve-a", preparation)
    const resolution = await a.create()
    expect((await a.prompt(resolution, "resolution")).status).toBe(204)
    const resolutionMessages = await a.completed(resolution)
    const resolutionResults = resolutionMessages
      .flatMap((message) => message.parts)
      .filter((part) => part.tool === "bash")
      .map((part) => ({ exit: part.state?.metadata?.exit, output: part.state?.output ?? "" }))
    expect(resolutionResults).toHaveLength(5)
    for (const result of resolutionResults) expect(result.output).toMatch(/running [1-9]\d* tests/)
    for (const result of resolutionResults.slice(2)) {
      if (result.exit === 0) expect(result.output).toMatch(/test result: ok\. [1-9]\d* passed/)
      else {
        expect(result.exit).toBeDefined()
        expect(result.output).toMatch(
          /test result: FAILED|fatal runtime error: stack overflow|Managed command: timeout\./,
        )
      }
    }
    for (const result of resolutionResults.slice(0, 2)) {
      expect(result.exit).toBe(0)
      expect(result.output).toMatch(/test result: ok\. [1-9]\d* passed/)
    }
    console.log(
      "Managed Baila post-rebase test outcomes",
      JSON.stringify(
        resolutionResults.map((result, index) => ({
          suite: index < 2 ? "identifier" : "full-lib",
          stack: [2097152, 67108864, 2097152, 67108864, 16777216][index],
          exit: result.exit,
          outcome: result.output.match(
            /test result: [^\n]+|fatal runtime error: stack overflow[^\n]*|Managed command: timeout\./,
          )?.[0],
        })),
      ),
    )
    expect(resolutionResults[3]!.exit).toBe(0)
    expect(resolutionResults[4]!.exit).toBe(0)
    const resolutionChildren = (await a.request(`/session/${resolution}/children`)).data as { id: string }[]
    expect(resolutionChildren).toHaveLength(3)
    for (const child of resolutionChildren)
      expect(
        (await a.history(child.id))
          .flatMap((message) => message.parts)
          .some((part) => part.state?.output?.includes("REVIEW_READ_ONLY_OK") && part.state.metadata?.exit === 0),
      ).toBe(true)
    for (const key of ["review-resolution-one", "review-resolution-two", "verify-resolution"])
      expect(turns.get(key)).toBeGreaterThanOrEqual(2)
    expect(await readFile(path.join(input.slotA, "baila-compiler/src/lib.rs"))).toEqual(resolvedCandidate)
    expect(await readFile(path.join(input.snapshotGit, "HEAD"))).toEqual(resolvedHead)
    expect(await readFile(path.join(input.snapshotGit, "index"))).toEqual(resolvedIndex)
    const resolutionReceipt = await a.drain(resolution)
    expect(resolutionReceipt.sessionIDs.toSorted()).toEqual(
      [resolution, ...resolutionChildren.map((child) => child.id)].toSorted(),
    )
    await stop(a.child)
    receipt = resolutionReceipt
    expect(calls.filter((call) => call.arguments.value === "child-must-not-dispatch")).toHaveLength(0)
    expect(issues["STAGING-1"]).toEqual({ generation: 9, phase: "working", checkout: input.slotA })
    expect(await input.git(input.slotA, "rev-parse", "HEAD")).toBe(integrated)
    expect(
      await realpath(await input.git(input.slotA, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    ).toBe(input.common)
    await gate(integrated, "working", 9)
    expect(await Bun.file(path.join(input.slotA, "baila-compiler/src/lib.rs")).text()).toBe(
      original.replace(
        "//! The Baila compiler, as a library.",
        "//! The Baila compiler, as an upstream and staging library.",
      ),
    )
    a = await start(input.slotA, input.snapshotGit, "STAGING-1", "serve-a", readiness)
    const ready = await a.create()
    expect((await a.prompt(ready, "ready")).status).toBe(204)
    await a.completed(ready)
    expect(phaseCatalogs.ready!.length).toBeGreaterThan(0)
    for (const tools of phaseCatalogs.ready!) {
      expect(tools).toContain("wq_ready_to_integrate")
      expect(tools).not.toContain("wq_mark_done")
    }
    expect(calls.filter((call) => call.name === "wq_mark_done")).toHaveLength(0)
    const readyReceipt = await a.drain(ready)
    await stop(a.child)
    receipt = readyReceipt
    await gate(integrated, "ready", 10)
    expect(await input.git(input.slotA, "rev-parse", "HEAD^")).toBe(upstream)
    expect(await input.git(input.slotA, "log", "-1", "--format=%B")).toContain("Refs: STAGING-1")
    expect(await input.git(input.remote, "rev-parse", "refs/heads/main")).toBe(upstream)
    await input.git(input.slotA, "push", "origin", "HEAD:main")
    await input.git(input.slotA, "fetch", "origin", "main")
    pushedSHA = await input.git(input.slotA, "rev-parse", "FETCH_HEAD")
    expect(pushedSHA).toBe(integrated)
    expect(await input.git(input.slotA, "rev-parse", `${pushedSHA}^`)).toBe(upstream)
    expect(await input.git(input.slotB, "rev-parse", "HEAD")).toBe(base)
    expect(await input.git(input.slotB, "status", "--porcelain")).toBe("")
    issues["STAGING-1"]!.phase = "pushed"
    a = await start(input.slotA, input.snapshotGit, "STAGING-1", "serve-a", completion)
    const finish = await a.create()
    expect((await a.prompt(finish, "finish")).status).toBe(204)
    await a.completed(finish)
    expect(phaseCatalogs.finish!.length).toBeGreaterThan(0)
    for (const tools of phaseCatalogs.finish!) {
      expect(tools).toContain("wq_mark_done")
      expect(tools).not.toContain("wq_ready_to_integrate")
    }
    const finishReceipt = await a.drain(finish)
    expect(issues["STAGING-1"]!.phase).toBe("done")
    await stop(a.child)
    a = await start(input.slotA, input.snapshotGit, "STAGING-1", "serve-a", completion)
    expect((await a.prompt(rootA, "workflow")).status).toBe(409)
    const replacement = await a.create()
    expect((await a.prompt(replacement, "replacement")).status).toBe(204)
    await a.completed(replacement)
    await a.drain(replacement)
    await Bun.write(
      path.join(input.staging, "report.json"),
      JSON.stringify(
        {
          base,
          prepared,
          upstream,
          integrated,
          pushedSHA,
          calls,
          compilerResults,
          resolutionResults,
          rootA,
          rootB,
          descendants,
          resolution,
          resolutionChildren,
          ready,
          finish,
          replacement,
          preparationReceipt,
          slotBReceipt,
          resolutionReceipt,
          readyReceipt,
          finishReceipt,
        },
        null,
        2,
      ),
    )
  } finally {
    await Promise.all(children.map(stop))
    await model.stop(true)
    await gateway.stop(true)
  }
}
