import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Exit, Layer, Schema } from "effect"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { tmpdirScoped } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { createCodexServer } from "../lib/codex-server"
import { pathToFileURL } from "node:url"
import { candidate, compiledPort, compiledProxy, compiledReady } from "./fixtures/compiled-codex"

const compiled = process.env.PHASE14_COMPILED === "1"
const catalogue = process.env.PHASE14_CATALOGUE === "1"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

async function poll<T>(name: string, read: () => Promise<T | undefined>, duration = 20_000) {
  const deadline = Date.now() + duration
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await setTimeout(25)
  }
  throw new Error(`Timed out: ${name}`)
}

for (const transport of compiled ? (["http", "ws"] as const) : (["compatible", "http", "ws"] as const))
  it.live(
    `holds a genuinely killed ${transport} Task tree and reconciles lost and pending controls after same-input recovery${catalogue ? " [embedded catalogue]" : ""}`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const codex =
          transport === "compatible"
            ? undefined
            : yield* Effect.acquireRelease(
                Effect.promise(() => createCodexServer(llm.url)),
                (owned) => Effect.promise(() => owned.close()),
              )
        const config = testProviderConfig(llm.url)
        const proxy =
          compiled && codex
            ? yield* Effect.acquireRelease(
                Effect.promise(() => compiledProxy(codex.issuer)),
                (value) => Effect.promise(() => value.close()),
              )
            : undefined
        const providerID = codex ? "openai" : "test"
        const originalModel = codex ? (catalogue ? "gpt-5.4-mini" : "gpt-5.3-codex") : "test-model"
        const targetModel = codex ? "gpt-5.4" : "test-model"
        const futureModel = codex ? "gpt-5.5" : "future-model"
        const variant = codex ? "xhigh" : "high"
        const defaultEffort = codex ? "medium" : undefined
        const effort = (input: Record<string, unknown> | undefined) =>
          codex
            ? input?.reasoning && typeof input.reasoning === "object" && "effort" in input.reasoning
              ? input.reasoning.effort
              : undefined
            : input?.reasoning_effort
        const directory = yield* tmpdirScoped({
          git: true,
          // The file plugin resolves from this checkout; config initialization must not install packages.
          init: (directory) =>
            Effect.promise(() =>
              Promise.all(
                ["config", "config/opencode"].map((dir) => markPluginDependenciesReady(path.join(directory, dir))),
              ),
            ).pipe(Effect.asVoid),
          config: {
            ...config,
            model: `${providerID}/${originalModel}`,
            ...(codex
              ? {
                  enabled_providers: ["openai"],
                  ...(compiled
                    ? {}
                    : {
                        plugin: [pathToFileURL(path.resolve(import.meta.dir, "fixtures/handoff-codex-plugin.ts")).href],
                      }),
                }
              : {}),
            permission: { task: "allow" },
            agent: { title: { disable: true } },
            provider: catalogue
              ? undefined
              : {
                  [providerID]: {
                    ...config.provider.test,
                    models: {
                      [originalModel]: {
                        ...config.provider.test.models["test-model"],
                        id: originalModel,
                        variants: { high: { reasoningEffort: "high" } },
                      },
                      ...(codex
                        ? {
                            [targetModel]: {
                              ...config.provider.test.models["test-model"],
                              id: targetModel,
                              reasoning: true,
                              variants: { xhigh: { reasoningEffort: "xhigh" } },
                            },
                          }
                        : {}),
                      [futureModel]: {
                        ...config.provider.test.models["test-model"],
                        id: futureModel,
                        variants: { [variant]: { reasoningEffort: variant } },
                      },
                    },
                    ...(codex ? { npm: "@ai-sdk/openai", options: { baseURL: `${codex.issuer}/v1` } } : {}),
                  },
                },
          },
        })
        const lineage = randomUUID()
        const database = path.join(directory, "handoff.sqlite")
        const launch = (port: number, seed = false) =>
          Effect.acquireRelease(
            Effect.promise(async () => {
              const ready = path.join(directory, `${randomUUID()}.ready`)
              const selectedPort = compiled && port === 0 ? await compiledPort() : port
              const child = Bun.spawn(
                compiled
                  ? [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(selectedPort)]
                  : [process.execPath, "run", "./test/server/fixtures/handoff-server.ts"],
                {
                  cwd: path.resolve(import.meta.dir, "../.."),
                  env: {
                    PATH: process.env.PATH,
                    HOME: directory,
                    TMPDIR: directory,
                    ...(catalogue
                      ? {}
                      : { OPENCODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json") }),
                    OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
                    OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
                    OPENCODE_TEST_HOME: directory,
                    XDG_CONFIG_HOME: `${directory}/config`,
                    XDG_DATA_HOME: `${directory}/data`,
                    XDG_CACHE_HOME: `${directory}/cache`,
                    XDG_STATE_HOME: `${directory}/state`,
                    OPENCODE_TEST_MANAGED_CONFIG_DIR: `${directory}/managed`,
                    OPENCODE_DB: database,
                    OPENCODE_CONFIG: "",
                    OPENCODE_CONFIG_DIR: `${directory}/config`,
                    OPENCODE_CONFIG_CONTENT: "{}",
                    OPENCODE_PURE: compiled ? "1" : codex ? "0" : "1",
                    OPENCODE_DISABLE_DEFAULT_PLUGINS: codex ? "0" : "1",
                    OPENCODE_MANAGED_PROFILE: "0",
                    OPENCODE_MANAGED_WORKSPACE: "",
                    OPENCODE_SERVER_PASSWORD: "",
                    ...(codex
                      ? {
                          HANDOFF_CODEX_ISSUER: codex.issuer,
                          HANDOFF_CODEX_ENDPOINT: codex.endpoint,
                          HANDOFF_CODEX_TRANSPORT: transport,
                          HANDOFF_OAUTH_SEED: seed ? "1" : "0",
                        }
                      : { OPENCODE_AUTH_CONTENT: "{}" }),
                    OPENCODE_RUNTIME_LINEAGE: lineage,
                    HANDOFF_DIRECTORY: directory,
                    HANDOFF_PORT: String(port),
                    HANDOFF_READY: ready,
                    ...(proxy
                      ? {
                          NODE_EXTRA_CA_CERTS: `${process.env.PHASE14_DIR}/ca.pem`,
                          HTTPS_PROXY: proxy.url,
                          HTTP_PROXY: proxy.url,
                          NO_PROXY: "127.0.0.1,localhost",
                          OPENCODE_EXPERIMENTAL_WEBSOCKETS: String(transport === "ws"),
                          BUN_OPTIONS: "--no-env-file --no-install",
                        }
                      : {}),
                  },
                  stdout: "pipe",
                  stderr: "pipe",
                },
              )
              const stdout = new Response(child.stdout).text()
              const stderr = new Response(child.stderr).text()
              // Start draining output immediately, including when readiness fails.
              try {
                if (compiled) {
                  await poll(
                    "compiled Serve ready",
                    async () => {
                      if (child.exitCode !== null) throw new Error(`Compiled Serve exited ${child.exitCode}`)
                      const health = await fetch(`http://127.0.0.1:${selectedPort}/global/health`, {
                        signal: AbortSignal.timeout(1000),
                      }).catch(() => undefined)
                      if (health?.status !== 200) return
                      await compiledReady(child.pid, selectedPort, seed)
                      return true
                    },
                    60_000,
                  )
                  await Bun.write(ready, JSON.stringify({ pid: child.pid, port: selectedPort, database }))
                }
                const state = await poll(
                  "isolated Serve ready",
                  async () => {
                    if (child.exitCode !== null)
                      throw new Error(`Serve exited ${child.exitCode}: ${await stdout}\n${await stderr}`)
                    if (!(await Bun.file(ready).exists())) return
                    return Schema.decodeUnknownSync(
                      Schema.Struct({ pid: Schema.Number, port: Schema.Number, database: Schema.String }),
                    )(await Bun.file(ready).json())
                  },
                  60_000,
                )
                expect(state).toMatchObject({ pid: child.pid, database })
                if (port !== 0) expect(state.port).toBe(port)
                return { child, stdout, stderr, port: state.port }
              } catch (error) {
                child.kill("SIGKILL")
                await child.exited
                throw error
              }
            }),
            (owned, exit) =>
              Effect.promise(async () => {
                if (owned.child.exitCode === null) owned.child.kill("SIGKILL")
                await owned.child.exited
                const output = await Promise.all([owned.stdout, owned.stderr])
                if (Exit.isFailure(exit)) console.error(output.join("\n").slice(-12_000))
              }),
          )
        const first = yield* launch(0, true)
        const baseUrl = `http://127.0.0.1:${first.port}`
        const sdk = createOpencodeClient({ baseUrl, directory, throwOnError: true })
        const request = async (route: string, body?: unknown) => {
          const url = new URL(route, baseUrl)
          url.searchParams.set("directory", directory)
          return fetch(url, {
            ...(body === undefined
              ? {}
              : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
          })
        }
        const view = async (id: string) => {
          const response = await request(`/session/${id}/execution`)
          expect(response.status).toBe(200)
          return Schema.decodeUnknownSync(SessionHandoffV1.ExecutionView)(await response.json())
        }
        const control = async (id: string, input: unknown, route = "model-control") => {
          const response = await request(`/session/${id}/${route}`, input)
          const body = await response.json()
          expect({ route, status: response.status, body }).toMatchObject({ route, status: 200 })
          return Schema.decodeUnknownSync(SessionHandoffV1.ControlReceipt)(body)
        }
        const receipt = async (id: string, requestID: string) => {
          const response = await request(`/session/${id}/handoff/${requestID}`)
          expect(response.status).toBe(200)
          return Schema.decodeUnknownSync(SessionHandoffV1.ControlReceipt)(await response.json())
        }
        if (catalogue) {
          yield* Effect.promise(async () => {
            expect(compiled).toBe(true)
            const emitted = await Bun.file(path.join(directory, "opencode.json")).json()
            expect(emitted.provider).toBeUndefined()
            expect(emitted.plugin).toBeUndefined()
            const pinned = await Bun.file(process.env.PHASE14_PINNED_CATALOGUE!).json()
            const provider = (await sdk.provider.list()).data!.all.find((provider) => provider.id === "openai")
            expect(provider).toBeDefined()
            await Bun.write(
              `${process.env.PHASE14_DIR}/${transport}-public-models.json`,
              JSON.stringify({ ids: Object.keys(provider!.models) }),
            )
            const models = [originalModel, targetModel, futureModel].map((id) => {
              const expected = pinned.openai.models[id]
              const model = provider!.models[id]
              expect(model).toBeDefined()
              expect(expected.tool_call).toBe(true)
              expect(expected.structured_output).toBe(true)
              expect(model.capabilities).toMatchObject({ reasoning: expected.reasoning, toolcall: expected.tool_call })
              expect(model.api.npm).toBe(pinned.openai.npm)
              expect(model.limit).toEqual(
                id === "gpt-5.5" ? { context: 400_000, input: 272_000, output: 128_000 } : expected.limit,
              )
              const efforts = expected.reasoning_options.find(
                (option: { type: string }) => option.type === "effort",
              ).values
              expect(efforts).toContain(variant)
              expect(Object.keys(model.variants ?? {})).toEqual(efforts)
              expect(model.variants?.[variant]).toEqual({
                reasoningEffort: variant,
                reasoningSummary: "auto",
                include: ["reasoning.encrypted_content"],
              })
              return {
                id,
                api: model.api,
                capabilities: model.capabilities,
                limit: model.limit,
                variants: model.variants,
              }
            })
            await Bun.write(
              `${process.env.PHASE14_DIR}/${transport}-catalogue.json`,
              JSON.stringify({ models, emittedConfig: emitted, modelPathOverride: false }),
            )
          })
        }
        const rootGate = Promise.withResolvers<void>()
        const childGate = Promise.withResolvers<void>()
        const recoveryGate = Promise.withResolvers<void>()
        const rootCompletionGate = Promise.withResolvers<void>()
        const reportSchema = {
          type: "object",
          properties: {
            version: { type: "number", const: 2 },
            status: { type: "string" },
            summary: { type: "string" },
            checks: { type: "array", items: { type: "string" } },
          },
          required: ["version"],
          additionalProperties: false,
        }
        const reportFormat = { type: "json_schema" as const, retryCount: 0, schema: reportSchema }
        const malformedReport = { version: 2 }
        const replacementReport = {
          version: 2,
          status: "complete",
          summary: "Original-role reporting action unaffected by obsolete control",
          checks: ["permanent interrupted Task error retained", "original child actual result completed"],
        }
        const reportV2 = Schema.Struct({
          version: Schema.Literal(2),
          status: Schema.Literal("complete"),
          summary: Schema.String,
          checks: Schema.Array(Schema.String),
        })
        expect(Schema.is(reportV2)(malformedReport)).toBe(false)
        expect(Schema.is(reportV2)(replacementReport)).toBe(true)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rootGate.resolve()
            childGate.resolve()
            recoveryGate.resolve()
            rootCompletionGate.resolve()
          }),
        )
        yield* llm.push(
          reply().wait(rootGate.promise).tool("task", {
            description: "review exact input",
            subagent_type: "general",
            prompt: "Review original child input without invoking tools.",
          }),
          reply().wait(childGate.promise).text("This response belongs to the killed request").stop(),
          reply().wait(recoveryGate.promise).text("Actual recovered reviewer result").stop(),
          reply().wait(rootCompletionGate.promise).tool("StructuredOutput", malformedReport).stop(),
        )
        const session = yield* Effect.promise(
          async () => (await sdk.session.create({ title: "bounded handoff restart", agent: "build" })).data!,
        )
        yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID: session.id,
            id: "handoff-restart-root",
            payload: {
              kind: "prompt",
              agent: "build",
              model: { providerID, modelID: originalModel },
              variant: "default",
              format: reportFormat,
              parts: [{ type: "text", text: "Delegate one exact review to the general Task agent." }],
            },
          }),
        )
        yield* awaitWithTimeout(llm.wait(1), "original root provider request did not start", "20 seconds")
        const authFile = path.join(directory, "data/opencode/auth.json")
        const refreshedAuth = codex
          ? yield* Effect.promise(async () => {
              const stored = await Bun.file(authFile).json()
              expect(stored.openai?.access === "fixture-refreshed-access").toBe(true)
              expect(stored.openai?.refresh === "fixture-refreshed-refresh").toBe(true)
              expect(stored.openai?.expires > Date.now()).toBe(true)
              if (compiled) expect(codex.refreshes()).toBeGreaterThanOrEqual(1)
              if (!compiled) expect(codex.refreshes()).toBe(1)
              return Bun.file(authFile).text()
            })
          : undefined
        yield* Effect.promise(() =>
          poll("queue prompt enrollment", async () => {
            const candidate = (await view(session.id)).candidate
            if (!candidate) return
            const response = await request(`/session/${session.id}/enrollment`, {
              ...candidate,
              requestID: randomUUID(),
            })
            const body = await response.json()
            // Stream-start bookkeeping may change the read-only candidate snapshot.
            // Only the contract's explicit rediscover-and-retry response is accepted.
            if (response.status === 409) {
              expect(body).toMatchObject({ code: "stale_context" })
              return
            }
            expect({ status: response.status, body }).toMatchObject({ status: 200, body: { state: "enrolled" } })
            return true
          }),
        )
        const enrolled = yield* Effect.promise(() => view(session.id))
        if (!enrolled.identity) throw new Error("Missing enrolled identity")
        const lost: SessionHandoffV1.ControlRequest = {
          requestID: randomUUID(),
          expected: enrolled.identity,
          target: { providerID, modelID: targetModel, variant },
        }
        // The network boundary accepts the entire POST, loses the connection before
        // forwarding it, and gives the caller no admission acknowledgement.
        const loss = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const received = Promise.withResolvers<void>()
            const server = createServer((req) => {
              req.resume()
              req.once("end", () => {
                received.resolve()
                req.socket.destroy()
              })
            })
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
            const address = server.address()
            if (!address || typeof address === "string") throw new Error("Missing network-loss port")
            return { server, received: received.promise, port: address.port }
          }),
          ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        )
        yield* Effect.promise(async () => {
          await expect(
            fetch(
              `http://127.0.0.1:${loss.port}/session/${session.id}/model-control?directory=${encodeURIComponent(directory)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(lost),
                signal: AbortSignal.timeout(5_000),
              },
            ),
          ).rejects.toThrow()
          await loss.received
          expect((await request(`/session/${session.id}/handoff/${lost.requestID}`)).status).toBe(404)
        })
        const pendingInput = { ...lost, requestID: randomUUID() }
        const pending = yield* Effect.promise(() => control(session.id, pendingInput))
        expect(pending).toMatchObject({ state: "pending", dispatch: "none", boundary: null })
        expect(yield* Effect.promise(() => receipt(session.id, pendingInput.requestID))).toEqual(pending)
        rootGate.resolve()
        const before = yield* Effect.promise(() =>
          poll("original Task child provider in flight", async () => {
            const current = await view(session.id)
            return current.descendants.length === 1 && current.descendants[0].proof === "verified" ? current : undefined
          }),
        )
        yield* awaitWithTimeout(llm.wait(2), "original child provider request did not start", "20 seconds")
        if (!before.descendants[0].link) throw new Error("Missing verified Task link")
        const link = before.descendants[0].link
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(database, { readonly: true })),
          (db) => Effect.sync(() => db.close()),
        )
        const runtimeRows = () => db.query("SELECT * FROM runtime_execution ORDER BY session_id").all()
        const nativeHistory = db.transaction(() => ({
          session: db.query("SELECT * FROM session WHERE id=?").get(session.id),
          ...Object.fromEntries(
            [
              "message",
              "part",
              "session_handoff_root",
              "session_queue",
              "session_queue_state",
              "session_handoff_notification",
              "session_handoff_compaction",
            ].map((table) => [
              table,
              db.query(`SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`).all(session.id),
            ]),
          ),
        }))
        const inputs = () =>
          db
            .query(
              "SELECT id,session_id,json_remove(data,'$.summary') AS data FROM message WHERE json_extract(data,'$.role')='user' ORDER BY id",
            )
            .all()
        const inputParts = () =>
          db
            .query(
              "SELECT id,message_id,data FROM part WHERE message_id IN (SELECT id FROM message WHERE json_extract(data,'$.role')='user') ORDER BY id",
            )
            .all()
        const sessionIDs = () => db.query("SELECT id FROM session ORDER BY id").all()
        const childSession = () =>
          db.query("SELECT agent,model,permission,metadata FROM session WHERE id=?").get(link.childSessionID)
        const task = () =>
          db
            .query<
              { data: string },
              [string, string]
            >("SELECT data FROM part WHERE session_id=? AND json_extract(data,'$.callID')=?")
            .get(session.id, link.parentCallID)
        const savedInputs = inputs()
        const savedParts = inputParts()
        const savedSessionIDs = sessionIDs()
        const savedChild = childSession()
        const savedRows = runtimeRows()
        const savedTask = task()
        expect(savedTask && JSON.parse(savedTask.data)).toMatchObject({
          type: "tool",
          tool: "task",
          state: { status: "running" },
        })
        first.child.kill("SIGKILL")
        yield* Effect.promise(() => first.child.exited)
        expect(first.child.signalCode).toBe("SIGKILL")
        const restarted = yield* launch(first.port)
        if (codex) {
          expect((yield* Effect.promise(() => Bun.file(authFile).text())) === refreshedAuth).toBe(true)
          if (compiled) expect(codex.refreshes()).toBeGreaterThanOrEqual(1)
          if (!compiled) expect(codex.refreshes()).toBe(1)
        }
        const held = yield* Effect.promise(() => view(session.id))
        const actionView = async () => {
          const response = await request(
            `/session/${session.id}/execution?queueID=${lost.expected.queueID}&userMessageID=${lost.expected.userMessageID}`,
          )
          expect(response.status).toBe(200)
          return Schema.decodeUnknownSync(SessionHandoffV1.ExecutionView)(await response.json())
        }
        const descendant = held.descendants[0]
        expect(held).toMatchObject({
          state: "held",
          eligibility: "eligible",
          ownerLiveness: "dead",
          identity: before.identity,
        })
        expect(held.descendants).toMatchObject([
          { childSessionID: link.childSessionID, proof: "verified", state: "held", ownerLiveness: "dead", link },
        ])
        expect(runtimeRows()).toEqual(savedRows)
        expect(inputs()).toEqual(savedInputs)
        expect(inputParts()).toEqual(savedParts)
        expect(sessionIDs()).toEqual(savedSessionIDs)
        expect(task()).toEqual(savedTask)
        expect(JSON.parse(task()?.data ?? "null")).toMatchObject({ state: { status: "running" } })
        const pairedHeld = yield* Effect.promise(actionView)
        expect(pairedHeld.descendants).toEqual(held.descendants)
        expect(pairedHeld.interruptedResources).toEqual(held.interruptedResources)
        expect(yield* llm.calls).toBe(2)
        expect(yield* Effect.promise(() => receipt(session.id, pendingInput.requestID))).toEqual(pending)
        expect(yield* Effect.promise(() => control(session.id, pendingInput))).toEqual(pending)
        expect((yield* Effect.promise(() => request(`/session/${session.id}/handoff/${lost.requestID}`))).status).toBe(
          404,
        )
        if (
          !held.identity ||
          !held.descendantDigest ||
          held.recoveryRevision === null ||
          !descendant.inputDigest ||
          descendant.ownerLineage === null ||
          descendant.ownerInstance === null ||
          descendant.fence === null ||
          descendant.recoveryRevision === null
        )
          throw new Error("Missing guarded recovery identity")
        const recovery: SessionHandoffV1.RecoveryRequest = {
          requestID: randomUUID(),
          expected: held.identity,
          expectedRecoveryRevision: held.recoveryRevision,
          target: { providerID, modelID: targetModel, variant },
          expectedDescendantDigest: held.descendantDigest,
          children: [
            {
              link,
              inputDigest: descendant.inputDigest,
              ownerLineage: descendant.ownerLineage,
              ownerInstance: descendant.ownerInstance,
              fence: descendant.fence,
              recoveryRevision: descendant.recoveryRevision,
            },
          ],
        }
        yield* Effect.promise(async () => {
          const response = await request(`/session/${session.id}/recovery`, {
            ...recovery,
            requestID: randomUUID(),
            children: [],
          })
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ code: "stale_context" })
        })
        expect(runtimeRows()).toEqual(savedRows)
        expect(inputs()).toEqual(savedInputs)
        const applied = yield* Effect.promise(() => control(session.id, recovery, "recovery"))
        // Startup only installed a hold. The guarded transaction is the first
        // operation allowed to reconcile this Task to permanent error evidence.
        expect(JSON.parse(task()?.data ?? "null")).toMatchObject({
          state: { status: "error", metadata: { interrupted: true, handoffRecovery: true } },
        })
        const pairedClaimed = yield* Effect.promise(actionView)
        expect(pairedClaimed.descendants[0]).toMatchObject({
          link,
          resultState: "none",
          fence: applied.children[0].recoveryFence,
        })
        recoveryGate.resolve()
        expect(applied).toMatchObject({
          state: "applied",
          boundary: { kind: "recovery" },
          children: [{ link, priorFence: descendant.fence }],
        })
        expect(applied.recoveryFence).toBeGreaterThan(held.identity.fence)
        expect(applied.children[0].recoveryFence).toBeGreaterThan(descendant.fence)
        yield* awaitWithTimeout(llm.wait(4), "root final structured provider turn did not start", "20 seconds").pipe(
          Effect.tapError(() =>
            Effect.sync(() =>
              console.error({
                unsupportedDispatch: Boolean(
                  db
                    .query("SELECT 1 FROM message WHERE session_id=? AND data LIKE '%unsupported_dispatch%' LIMIT 1")
                    .get(session.id),
                ),
              }),
            ),
          ),
        )
        const progress = yield* Effect.promise(() =>
          poll("actual child result while root remains active", async () => {
            const current = await receipt(session.id, recovery.requestID)
            return current.children[0]?.resultState === "completed" ? current : undefined
          }),
        )
        expect(progress.children[0]).toMatchObject({
          link,
          state: "continuing",
          resultState: "completed",
          resultAssistantMessageID: expect.any(String),
        })
        expect(db.query("SELECT state FROM runtime_execution WHERE session_id=?").get(session.id)).toEqual({
          state: "active",
        })
        expect(
          db
            .query("SELECT count(*) AS count FROM session_handoff_recovery_hold WHERE root_session_id=?")
            .get(session.id),
        ).toEqual({ count: 2 })
        for (const id of [session.id, link.childSessionID]) {
          const blocked = yield* Effect.promise(async () => (await sdk.session.queueList({ sessionID: id })).data!)
          expect(blocked).toMatchObject({ paused: false, blocked: true, items: [] })
        }
        const growing = yield* Effect.promise(actionView)
        expect(growing.descendants[0]).toMatchObject({ link, resultState: "completed" })
        expect(growing.descendants[0].inputDigest).not.toBe(descendant.inputDigest)
        expect(yield* llm.calls).toBe(4)
        rootCompletionGate.resolve()
        const completed = yield* Effect.promise(() =>
          poll("separate real child result receipt", async () => {
            const current = await receipt(session.id, recovery.requestID)
            return current.children[0]?.state === "terminal" && current.children[0].resultState === "completed"
              ? current
              : undefined
          }),
        )
        yield* Effect.promise(() =>
          poll("root runtime completed", async () => {
            const current = db
              .query<{ state: string }, [string]>("SELECT state FROM runtime_execution WHERE session_id=?")
              .get(session.id)
            return current?.state === "completed" ? true : undefined
          }),
        )
        expect(completed.children[0]).toMatchObject({ link, resultState: "completed" })
        const nativeFinal = yield* Effect.promise(async () =>
          (await sdk.session.messages({ sessionID: session.id })).data!.findLast(
            (message) => message.info.role === "assistant",
          ),
        )
        expect(nativeFinal?.info).toMatchObject({
          role: "assistant",
          structured: malformedReport,
          time: { completed: expect.any(Number) },
        })
        expect(nativeFinal?.info.role === "assistant" && nativeFinal.info.error).toBeUndefined()
        expect(nativeFinal?.info.role === "assistant" && Schema.is(reportV2)(nativeFinal.info.structured)).toBe(false)
        const resultAssistantMessageID = completed.children[0].resultAssistantMessageID
        if (!resultAssistantMessageID) throw new Error("Missing actual child result ID")
        const result = yield* Effect.promise(
          async () => (await sdk.session.messages({ sessionID: link.childSessionID })).data!,
        )
        expect(result.map((message) => message.info.id)).toContain(resultAssistantMessageID)
        expect(result.find((message) => message.info.id === resultAssistantMessageID)?.parts).toContainEqual(
          expect.objectContaining({ type: "text", text: "Actual recovered reviewer result" }),
        )
        const interruptedTask = task()
        if (!interruptedTask) throw new Error("Interrupted Task disappeared")
        expect(JSON.parse(interruptedTask.data)).toMatchObject({
          state: { status: "error", metadata: { interrupted: true, handoffRecovery: true } },
        })
        expect(inputs()).toEqual(savedInputs)
        expect(childSession()).toEqual(savedChild)
        expect(inputParts()).toEqual(savedParts)
        expect(sessionIDs()).toEqual(savedSessionIDs)
        expect((yield* llm.inputs).map((input) => ({ model: input.model, effort: effort(input) }))).toEqual([
          { model: originalModel, effort: defaultEffort },
          { model: originalModel, effort: defaultEffort },
          { model: originalModel, effort: defaultEffort },
          { model: targetModel, effort: variant },
        ])
        const after = yield* Effect.promise(() => view(session.id))
        expect(after.descendants).toMatchObject([
          {
            link,
            proof: "verified",
            state: "terminal",
            resultState: "completed",
            resultAssistantMessageID,
            selection: { providerID, modelID: originalModel, variant: "default" },
          },
        ])
        expect(after.boundaries.map((boundary) => boundary.kind)).toEqual(["recovery"])
        expect(after.assistants.at(-1)).toMatchObject({
          controlRequestID: recovery.requestID,
          selection: recovery.target,
          selectionEvidence: "normalized_dispatch",
        })
        const expired = yield* Effect.promise(() => control(session.id, lost))
        expect(expired).toMatchObject({ state: "expired", dispatch: "none", boundary: null, expected: lost.expected })
        expect(expired.reason === "stale_fence" || expired.reason === "terminal_action").toBe(true)
        expect(yield* Effect.promise(() => receipt(session.id, lost.requestID))).toEqual(expired)
        expect(yield* Effect.promise(() => control(session.id, lost))).toEqual(expired)
        expect(yield* Effect.promise(() => view(session.id))).toEqual(after)
        const expiredPending = yield* Effect.promise(() => receipt(session.id, pendingInput.requestID))
        expect(expiredPending).toMatchObject({ state: "expired", dispatch: "none", boundary: null })
        expect(yield* Effect.promise(() => control(session.id, pendingInput))).toEqual(expiredPending)
        expect(yield* llm.calls).toBe(4)
        yield* Effect.promise(() =>
          poll("successful guarded worker released startup holds", async () =>
            db.query("SELECT 1 FROM session_handoff_recovery_hold WHERE root_session_id=?").get(session.id)
              ? undefined
              : true,
          ),
        )
        const retainedA = yield* Effect.promise(actionView)
        expect(retainedA.descendants).toEqual(after.descendants)
        expect(retainedA.interruptedResources).toEqual(after.interruptedResources)
        for (const id of [session.id, link.childSessionID]) {
          const queue = yield* Effect.promise(async () => (await sdk.session.queueList({ sessionID: id })).data!)
          expect(queue).toMatchObject({ paused: false, blocked: false, items: [] })
          expect(
            db
              .query(
                "SELECT state,recovery_request_id FROM session_handoff_recovery_queue_block WHERE session_id=? AND recovery_request_id=?",
              )
              .get(id, recovery.requestID),
          ).toEqual({ state: "restored", recovery_request_id: recovery.requestID })
        }
        expect(yield* llm.calls).toBe(4)
        const ownRequestSchema = (body: Record<string, unknown>) =>
          codex
            ? Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, parameters: Schema.Json })))(
                body.tools,
              ).find((tool) => tool.name === "StructuredOutput")?.parameters
            : Schema.decodeUnknownSync(
                Schema.Array(
                  Schema.Struct({ function: Schema.Struct({ name: Schema.String, parameters: Schema.Json }) }),
                ),
              )(body.tools).find((tool) => tool.function.name === "StructuredOutput")?.function.parameters
        expect(ownRequestSchema((yield* llm.hits)[0].body)).toEqual(reportSchema)
        expect(ownRequestSchema((yield* llm.hits)[3].body)).toEqual(reportSchema)
        const nextGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => nextGate.resolve()))
        yield* llm.push(reply().wait(nextGate.promise).tool("StructuredOutput", replacementReport).stop())
        yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID: session.id,
            id: "handoff-restart-report",
            payload: {
              kind: "prompt",
              agent: "build",
              model: { providerID, modelID: originalModel },
              variant: "default",
              format: reportFormat,
              parts: [{ type: "text", text: "R: report only, using the original role" }],
            },
          }),
        )
        yield* awaitWithTimeout(llm.wait(5), "next input provider request did not start", "20 seconds")
        // Request receipt precedes snapshot.track() and the durable step-start write.
        // Keep the response gated and wait for R's own step, not an older assistant's.
        const reporting = yield* Effect.promise(() =>
          poll(
            "reporting provider step persisted",
            async () =>
              db
                .query<{ userMessageID: string }, [string, string]>(
                  `
            SELECT queue.message_id AS userMessageID FROM session_queue queue
            JOIN message ON message.session_id=queue.session_id
              AND json_extract(message.data,'$.parentID')=queue.message_id
            JOIN part ON part.message_id=message.id AND part.session_id=message.session_id
            WHERE queue.session_id=? AND queue.id=? AND queue.state='delivered'
              AND json_extract(message.data,'$.role')='assistant'
              AND json_extract(part.data,'$.type')='step-start'
          `,
                )
                .get(session.id, "handoff-restart-report") ?? undefined,
          ),
        )
        const next = yield* Effect.promise(() => view(session.id))
        const nextHistory = nativeHistory()
        expect(next.candidate).toMatchObject({
          queueID: "handoff-restart-report",
          userMessageID: reporting.userMessageID,
        })
        const nextInputs = inputs()
        const nextRows = runtimeRows()
        expect(nextInputs).toHaveLength(savedInputs.length + 1)
        expect((yield* llm.inputs).at(-1)).toMatchObject({ model: originalModel })
        expect(effort((yield* llm.inputs).at(-1))).toBe(defaultEffort)
        expect(ownRequestSchema((yield* llm.hits)[4].body)).toEqual(reportSchema)
        for (const retry of [
          { input: lost, receipt: expired },
          { input: pendingInput, receipt: expiredPending },
        ]) {
          expect(yield* Effect.promise(() => control(session.id, retry.input))).toEqual(retry.receipt)
          expect(nativeHistory()).toEqual(nextHistory)
          expect(yield* Effect.promise(() => view(session.id))).toEqual(next)
          expect(inputs()).toEqual(nextInputs)
          expect(runtimeRows()).toEqual(nextRows)
          expect(yield* llm.calls).toBe(5)
        }
        const historical = yield* Effect.promise(async () => {
          const response = await request(
            `/session/${session.id}/execution?queueID=${lost.expected.queueID}&userMessageID=${lost.expected.userMessageID}`,
          )
          expect(response.status).toBe(200)
          return Schema.decodeUnknownSync(SessionHandoffV1.ExecutionView)(await response.json())
        })
        expect(historical).toMatchObject({
          viewKind: "historical",
          isCurrent: false,
          eligibility: "stale",
          descendants: retainedA.descendants,
          interruptedResources: retainedA.interruptedResources,
          descendantDigest: retainedA.descendantDigest,
        })
        expect(historical.boundaries).toEqual(after.boundaries)
        expect(historical.assistants).toEqual(after.assistants)
        expect(yield* llm.calls).toBe(5)
        expect(task()).toEqual(interruptedTask)
        nextGate.resolve()
        yield* Effect.promise(() =>
          poll("next input completed", async () => {
            const current = db
              .query<{ state: string }, [string]>("SELECT state FROM runtime_execution WHERE session_id=?")
              .get(session.id)
            return current?.state === "completed" ? true : undefined
          }),
        )
        const replacement = yield* Effect.promise(async () =>
          (await sdk.session.messages({ sessionID: session.id })).data!.findLast(
            (message) => message.info.role === "assistant",
          ),
        )
        expect(replacement?.info).toMatchObject({ role: "assistant", structured: replacementReport })
        expect(replacement?.info.role === "assistant" && Schema.is(reportV2)(replacement.info.structured)).toBe(true)
        expect(task()).toEqual(interruptedTask)
        expect(childSession()).toEqual(savedChild)
        expect(
          yield* Effect.promise(async () => (await sdk.session.messages({ sessionID: link.childSessionID })).data!),
        ).toEqual(result)
        const futureGate = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => futureGate.resolve()))
        yield* llm.push(reply().wait(futureGate.promise).text("B: distinct future role result").stop())
        yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID: session.id,
            id: "handoff-restart-future",
            payload: {
              kind: "prompt",
              agent: "plan",
              model: { providerID, modelID: futureModel },
              variant,
              parts: [{ type: "text", text: "B: a new input with the future planning role" }],
            },
          }),
        )
        yield* awaitWithTimeout(llm.wait(6), "future role did not dispatch", "20 seconds")
        expect((yield* llm.inputs).at(-1)).toMatchObject({ model: futureModel })
        expect(effort((yield* llm.inputs).at(-1))).toBe(variant)
        const futureHistorical = yield* Effect.promise(actionView)
        expect(futureHistorical.descendants).toEqual(retainedA.descendants)
        expect(futureHistorical.interruptedResources).toEqual(retainedA.interruptedResources)
        expect(futureHistorical.descendantDigest).toBe(retainedA.descendantDigest)
        expect(futureHistorical.assistants).toEqual(after.assistants)
        expect(task()).toEqual(interruptedTask)
        const users = yield* Effect.promise(async () =>
          (await sdk.session.messages({ sessionID: session.id })).data!.filter(
            (message) => message.info.role === "user",
          ),
        )
        expect(users.map((message) => message.info.agent)).toEqual(["build", "build", "plan"])
        for (const selector of [
          `queueID=${lost.expected.queueID}&userMessageID=unrelated`,
          `queueID=unrelated&userMessageID=${lost.expected.userMessageID}`,
        ])
          expect((yield* Effect.promise(() => request(`/session/${session.id}/execution?${selector}`))).status).toBe(
            404,
          )
        futureGate.resolve()
        yield* Effect.promise(() =>
          poll("future input completed", async () =>
            db
              .query<{ state: string }, [string]>("SELECT state FROM runtime_execution WHERE session_id=?")
              .get(session.id)?.state === "completed"
              ? true
              : undefined,
          ),
        )
        restarted.child.kill("SIGKILL")
        yield* Effect.promise(() => restarted.child.exited)
        yield* launch(first.port)
        if (codex) {
          expect((yield* Effect.promise(() => Bun.file(authFile).text())) === refreshedAuth).toBe(true)
          if (compiled) expect(codex.refreshes()).toBeGreaterThanOrEqual(1)
          if (!compiled) expect(codex.refreshes()).toBe(1)
          expect(codex.frames).toHaveLength(6)
          if (proxy) {
            expect(proxy.observations.failures).toEqual([])
            expect(proxy.observations.refresh).toBeGreaterThanOrEqual(1)
            expect(transport === "http" ? proxy.observations.http : proxy.observations.ws).toBeGreaterThan(0)
            yield* Effect.promise(() =>
              Bun.write(
                `${process.env.PHASE14_DIR}/${transport}-wire.json`,
                JSON.stringify({
                  transport,
                  observations: proxy.observations,
                  authenticated: codex.observations,
                  requests: codex.frames.map((frame) => ({ model: frame.model, effort: effort(frame) })),
                  recoveryReceipts: { pending, expired, expiredPending, applied, completed },
                  history: {
                    historical: {
                      viewKind: historical.viewKind,
                      isCurrent: historical.isCurrent,
                      descendants: historical.descendants,
                      boundaries: historical.boundaries,
                    },
                    future: {
                      descendants: futureHistorical.descendants,
                      descendantDigest: futureHistorical.descendantDigest,
                    },
                    agentPolicy: users.map((message) => message.info.agent),
                  },
                  assertions: "existing full SIGKILL/same-input recovery scenario reached final assertions",
                }),
              ),
            )
          }
          expect(codex.observations).toEqual(
            Array.from(
              { length: 6 },
              () =>
                ({
                  transport: transport === "ws" ? "ws" : "http",
                  authorized: true,
                  accountMatched: true,
                  internalHeaderPresent: false,
                }) as const,
            ),
          )
          expect(codex.frames.map((frame) => ({ model: frame.model, effort: effort(frame) }))).toEqual([
            { model: originalModel, effort: defaultEffort },
            { model: originalModel, effort: defaultEffort },
            { model: originalModel, effort: defaultEffort },
            { model: targetModel, effort: variant },
            { model: originalModel, effort: defaultEffort },
            { model: futureModel, effort: variant },
          ])
          expect(
            codex.frames.every((frame) => (transport === "ws" ? frame.type === "response.create" : !("type" in frame))),
          ).toBe(true)
          if (transport === "ws") {
            expect(codex.frames[2]).not.toHaveProperty("previous_response_id")
            expect(codex.frames[3]).not.toHaveProperty("previous_response_id")
          }
        }
        const reopened = yield* Effect.promise(actionView)
        expect(reopened.descendants).toEqual(retainedA.descendants)
        expect(reopened.interruptedResources).toEqual(retainedA.interruptedResources)
        expect(reopened.descendantDigest).toBe(retainedA.descendantDigest)
        expect(reopened.assistants).toEqual(after.assistants)
        expect(task()).toEqual(interruptedTask)
        expect(yield* llm.calls).toBe(6)
        expect(
          yield* Effect.promise(async () => (await sdk.session.messages({ sessionID: link.childSessionID })).data!),
        ).toEqual(result)
      }).pipe(Effect.timeout("110 seconds")),
    120_000,
  )
