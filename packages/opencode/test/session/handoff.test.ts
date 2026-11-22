import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionHandoffEnrollment } from "@opencode-ai/core/session/handoff-enrollment"
import { SessionHandoffNotification } from "@opencode-ai/core/session/handoff-notification"
import { SessionHandoffStore } from "@opencode-ai/core/session/handoff-store"
import { SessionHandoffRecovery } from "@opencode-ai/core/session/handoff-recovery"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { InstanceStore } from "../../src/project/instance-store"
import { RuntimeLifecycle } from "../../src/server/runtime-lifecycle"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionHandoff } from "../../src/session/handoff"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, LayerNode.compile(CrossSpawnSpawner.node)))

const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const config = testProviderConfig(llm.url)
  const directory = yield* tmpdirScoped({
    git: true,
    config: {
      ...config,
      model: "test/test-model",
      agent: { audit: { description: "Synthetic audit", mode: "subagent", prompt: "Audit synthetic changes." } },
      provider: {
        test: {
          ...config.provider.test,
          models: {
            "test-model": {
              ...config.provider.test.models["test-model"],
              variants: { high: { reasoningEffort: "high" } },
            },
            "obsolete-model": { ...config.provider.test.models["test-model"], id: "obsolete-model" },
          },
        },
      },
    },
  })
  const runtime = RuntimeLifecycle.make({ lineage: randomUUID() }, yield* Effect.scope)
  const context = yield* Layer.build(
    AppNodeBuilderV1.build(
      LayerNode.group([
        Session.node,
        SessionPrompt.node,
        InstanceStore.node,
        Database.node,
        SessionProjector.node,
        Provider.node,
        Agent.node,
      ]),
    ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime))),
  )
  const database = Context.get(context, Database.Service)
  runtime.bindDatabase(database)
  return {
    llm,
    directory,
    runtime,
    context,
    database,
    store: Context.get(context, InstanceStore.Service),
    sessions: Context.get(context, Session.Service),
  }
})

const enrolled = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    const session = yield* f.sessions.create({ title: "handoff root", agent: "build" })
    const userMessageID = MessageID.ascending()
    yield* f.runtime.admit({ sessionID: session.id, directory: f.directory })
    yield* SessionHandoffEnrollment.reserve(f.database, session.id, "reservation")
    yield* f.database.db.run(
      sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (${userMessageID},${session.id},1,1,${JSON.stringify({ role: "user", agent: "build", model: { providerID: "test", modelID: "test-model" }, time: { created: 1 } })})`,
    )
    const payload = { kind: "prompt", parts: [] }
    yield* f.database.db.run(
      sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES (${session.id},${session.id},'queue','delivered',1,${JSON.stringify(payload)},${JSON.stringify({ delivery: "queue", payload })},${userMessageID},1)`,
    )
    yield* SessionHandoffEnrollment.delivered(f.database, session.id, "reservation", session.id, userMessageID)
    const candidate = yield* SessionHandoff.candidate(session.id)
    if (!candidate) throw new Error("Missing candidate")
    yield* SessionHandoff.enroll(session.id, { ...candidate, requestID: randomUUID() })
    return session
  })

const removedTargets = (f: Effect.Success<typeof fixture>, runtime: RuntimeLifecycle.Interface) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      Bun.write(
        path.join(f.directory, "opencode.json"),
        JSON.stringify({
          ...testProviderConfig(f.llm.url),
          model: "test/test-model",
        }),
      ),
    )
    return yield* Layer.build(
      AppNodeBuilderV1.build(LayerNode.group([Session.node, InstanceStore.node, Provider.node, Database.node]), [
        [Database.node, Layer.succeed(Database.Service)(f.database)],
      ]).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(runtime)), Layer.fresh),
    )
  })

it.live("obsolete terminal controls reconcile removed models and variants before configuration validation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        if (!view.identity) throw new Error("Missing identity")
        const requests = [
          {
            requestID: randomUUID(),
            expected: view.identity,
            target: { providerID: "test", modelID: "test-model", variant: "high" },
          },
          {
            requestID: randomUUID(),
            expected: view.identity,
            target: { providerID: "test", modelID: "obsolete-model", variant: "default" },
          },
        ]
        for (const request of requests)
          expect(yield* Effect.flip(SessionHandoff.receipt(session.id, request.requestID))).toMatchObject({
            code: "not_found",
          })
        const boundary = yield* SessionHandoffNotification.boundary(f.database, session.id)
        yield* SessionHandoffNotification.terminalize(f.database, session.id, boundary)
        const removed = yield* removedTargets(f, f.runtime)
        yield* Effect.gen(function* () {
          for (const request of requests) {
            const receipt = yield* SessionHandoff.modelControl(session.id, request)
            expect(receipt).toMatchObject({
              state: "expired",
              reason: "terminal_action",
              dispatch: "none",
              boundary: null,
              target: request.target,
            })
            expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(receipt)
            expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(receipt)
            expect(
              yield* Effect.flip(
                SessionHandoff.modelControl(session.id, {
                  ...request,
                  target: { ...request.target, variant: "changed" },
                }),
              ),
            ).toMatchObject({ code: "request_id_conflict" })
          }
          expect(
            yield* Effect.flip(
              SessionHandoff.modelControl(session.id, {
                ...requests[0],
                requestID: randomUUID(),
                expected: { ...view.identity, contextDigest: "forged" },
              }),
            ),
          ).toMatchObject({ code: "stale_context" })
        }).pipe(Effect.provide(removed), Effect.provideService(RuntimeLifecycle.Service, f.runtime))
        expect(
          (yield* SessionHandoffStore.lookup(f.database, {
            sessionID: session.id,
            queueID: session.id,
            userMessageID: view.identity.userMessageID,
          }))?.boundaries,
        ).toEqual([])
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("removed live targets are not admitted while an exact pending control keeps its real receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        if (!view.identity) throw new Error("Missing identity")
        const request = {
          requestID: randomUUID(),
          expected: view.identity,
          target: { providerID: "test", modelID: "test-model", variant: "high" },
        }
        const pending = yield* SessionHandoff.modelControl(session.id, request)
        expect(pending.state).toBe("pending")
        const current = yield* SessionHandoff.execution(session.id)
        const removed = yield* removedTargets(f, f.runtime)
        yield* Effect.gen(function* () {
          expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(pending)
          for (const [target, code] of [
            [{ providerID: "test", modelID: "obsolete-model", variant: "default" }, "unsupported_model"],
            [request.target, "unsupported_variant"],
          ] as const) {
            const unsupported = { requestID: randomUUID(), expected: current.identity, target }
            expect(yield* Effect.flip(SessionHandoff.modelControl(session.id, unsupported))).toMatchObject({ code })
            expect(yield* Effect.flip(SessionHandoff.receipt(session.id, unsupported.requestID))).toMatchObject({
              code: "not_found",
            })
          }
          expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(pending)
        }).pipe(Effect.provide(removed), Effect.provideService(RuntimeLifecycle.Service, f.runtime))
        expect(yield* f.llm.calls).toBe(0)
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live("strict aggregate requests and terminal lost-response retries have no admission side effects", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.store.provide(
      { directory: f.directory },
      Effect.gen(function* () {
        const session = yield* enrolled(f)
        const view = yield* SessionHandoff.execution(session.id)
        Schema.decodeUnknownSync(SessionHandoffV1.ExecutionView)(view)
        if (!view.identity) throw new Error("Missing identity")
        const request = {
          requestID: randomUUID(),
          expected: view.identity,
          target: { providerID: "test", modelID: "test-model", variant: "default" },
        }
        expect(yield* Effect.flip(SessionHandoff.receipt(session.id, request.requestID))).toMatchObject({
          code: "not_found",
        })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, extra: true } }),
          ),
        ).toMatchObject({ code: "invalid_request" })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, {
              ...request,
              target: { ...request.target, variant: "not-configured" },
            }),
          ),
        ).toMatchObject({ code: "unsupported_variant" })
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, modelID: "missing" } }),
          ),
        ).toMatchObject({ code: "unsupported_model" })
        expect(
          yield* f.database.db.get(sql`SELECT 1 FROM session_handoff_request WHERE request_id = ${request.requestID}`),
        ).toBeUndefined()
        const boundary = yield* SessionHandoffNotification.boundary(f.database, session.id)
        expect(yield* SessionHandoffNotification.terminalize(f.database, session.id, boundary)).toBe(true)
        const before = yield* f.database.db.get(
          sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`,
        )
        const receipt = yield* SessionHandoff.modelControl(session.id, request)
        expect(receipt).toMatchObject({ state: "expired", reason: "terminal_action", dispatch: "none" })
        expect(yield* SessionHandoff.modelControl(session.id, request)).toEqual(receipt)
        expect(yield* SessionHandoff.receipt(session.id, request.requestID)).toEqual(receipt)
        expect(
          yield* f.database.db.get(sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`),
        ).toEqual(before)
        expect(
          yield* Effect.flip(
            SessionHandoff.modelControl(session.id, { ...request, target: { ...request.target, modelID: "missing" } }),
          ),
        ).toMatchObject({ code: "request_id_conflict" })
      }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
    )
  }),
)

it.live(
  "dead-owner recovery atomically fences the existing input and expires authentic unadmitted control retries",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          const live = yield* SessionHandoff.execution(session.id)
          if (!live.identity) throw new Error("Missing identity")
          const lost = {
            requestID: randomUUID(),
            expected: live.identity,
            target: { providerID: "test", modelID: "test-model", variant: "default" },
          }
          const removedRequests = [
            { ...lost, requestID: randomUUID(), target: { ...lost.target, modelID: "obsolete-model" } },
            { ...lost, requestID: randomUUID(), target: { ...lost.target, variant: "high" } },
          ]
          for (const saved of removedRequests)
            expect(yield* Effect.flip(SessionHandoff.receipt(session.id, saved.requestID))).toMatchObject({
              code: "not_found",
            })
          expect(yield* Effect.flip(SessionHandoff.receipt(session.id, lost.requestID))).toMatchObject({
            code: "not_found",
          })
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const restarted = RuntimeLifecycle.make(
            { lineage: f.runtime.identity.lineage },
            yield* Effect.scope,
            f.database,
          )
          const fresh = yield* Layer.build(
            AppNodeBuilderV1.build(
              LayerNode.group([
                Session.node,
                SessionPrompt.node,
                InstanceStore.node,
                Database.node,
                SessionProjector.node,
                Provider.node,
                Agent.node,
              ]),
              [[Database.node, Layer.succeed(Database.Service)(f.database)]],
            ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
          )
          yield* Effect.gen(function* () {
            yield* restarted.recover(() => Effect.die("enrolled recovery must be explicit"))
            const held = yield* SessionHandoff.execution(session.id)
            expect(held).toMatchObject({ state: "held", eligibility: "eligible", ownerLiveness: "dead" })
            if (!held.identity || held.recoveryRevision === null || !held.descendantDigest)
              throw new Error("Missing recovery guards")
            const request = {
              requestID: randomUUID(),
              expected: held.identity,
              expectedRecoveryRevision: held.recoveryRevision,
              target: { ...lost.target, variant: "high" },
              expectedDescendantDigest: held.descendantDigest,
              children: [],
            }
            const fence = yield* f.database.db.get(
              sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`,
            )
            expect(
              yield* Effect.flip(
                SessionHandoff.recover(session.id, {
                  ...request,
                  expectedRecoveryRevision: request.expectedRecoveryRevision + 1,
                }),
              ),
            ).toMatchObject({ code: "stale_context" })
            expect(
              yield* f.database.db.get(sql`SELECT fence FROM runtime_execution WHERE session_id = ${session.id}`),
            ).toEqual(fence)
            const release = Promise.withResolvers<void>()
            yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
            yield* f.llm.push(reply().wait(release.promise).text("Recovered same input").stop())
            const recovered = yield* SessionHandoff.recover(session.id, request)
            expect(recovered).toMatchObject({
              kind: "recovery",
              state: "applied",
              recoveryFence: held.identity.fence + 1,
              boundary: { kind: "recovery", selection: request.target },
            })
            expect(yield* SessionHandoff.recover(session.id, request)).toMatchObject({
              requestID: request.requestID,
              state: "applied",
              recoveryFence: recovered.recoveryFence,
            })
            const removed = yield* removedTargets(f, restarted)
            yield* Effect.gen(function* () {
              for (const saved of removedRequests) {
                const receipt = yield* SessionHandoff.modelControl(session.id, saved)
                expect(receipt).toMatchObject({
                  state: "expired",
                  reason: "stale_fence",
                  dispatch: "none",
                  boundary: null,
                  target: saved.target,
                })
                expect(yield* SessionHandoff.modelControl(session.id, saved)).toEqual(receipt)
                expect(yield* SessionHandoff.receipt(session.id, saved.requestID)).toEqual(receipt)
              }
            }).pipe(
              Effect.provide(removed),
              Effect.provideService(RuntimeLifecycle.Service, restarted),
              Effect.ensuring(Effect.sync(() => release.resolve())),
            )
            yield* pollWithTimeout(
              Effect.gen(function* () {
                const row = yield* f.database.db.get<{ state: string }>(
                  sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`,
                )
                return row?.state === "completed" ? true : undefined
              }),
              "same-input recovery did not finish",
            )
            expect(
              yield* f.database.db.get<{ count: number }>(
                sql`SELECT count(*) AS count FROM message WHERE session_id = ${session.id} AND json_extract(data,'$.role') = 'user'`,
              ),
            ).toEqual({ count: 1 })
            const expired = yield* SessionHandoff.modelControl(session.id, lost)
            expect(expired).toMatchObject({ state: "expired", dispatch: "none", boundary: null })
            expect(yield* SessionHandoff.modelControl(session.id, lost)).toEqual(expired)
            const receipt = yield* SessionHandoff.receipt(session.id, request.requestID)
            expect(
              (yield* f.llm.inputs).map((input) => ({ model: input.model, effort: input.reasoning_effort })),
            ).toEqual([{ model: "test-model", effort: "high" }])
            expect(receipt).toMatchObject({
              state: "applied",
              dispatch: "started_or_unknown",
              boundary: { firstOrdinaryAssistantMessageID: expect.any(String) },
            })
          }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
  30_000,
)

it.live(
  "terminal reconciliation records an expired receipt without claims and historical selectors never gain eligibility",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          const before = yield* SessionHandoff.execution(session.id)
          if (!before.identity) throw new Error("Missing enrolled identity")
          const pending = {
            requestID: randomUUID(),
            expected: before.identity,
            target: { providerID: "test", modelID: "test-model", variant: "high" },
          }
          expect(yield* SessionHandoff.modelControl(session.id, pending)).toMatchObject({ state: "pending" })
          const observed = yield* SessionHandoffNotification.boundary(f.database, session.id)
          yield* SessionHandoffNotification.terminalize(f.database, session.id, observed)
          expect(yield* SessionHandoff.modelControl(session.id, pending)).toMatchObject({
            state: "expired",
            reason: "terminal_action",
            dispatch: "none",
          })
          yield* f.runtime.release(session.id)
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const view = yield* SessionHandoff.execution(session.id)
          if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
            throw new Error("Missing terminal proof")
          const request = {
            requestID: randomUUID(),
            expected: view.identity,
            expectedRecoveryRevision: view.recoveryRevision,
            expectedDescendantDigest: view.descendantDigest,
            target: pending.target,
            children: [],
          }
          const runtime = yield* f.database.db.get(
            sql`SELECT * FROM runtime_execution WHERE session_id = ${session.id}`,
          )
          expect(yield* SessionHandoff.recover(session.id, request)).toMatchObject({
            state: "expired",
            reason: "terminal_action",
            recoveryFence: null,
            boundary: null,
            dispatch: "none",
          })
          expect(
            yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${session.id}`),
          ).toEqual(runtime)
          expect(
            yield* SessionHandoff.execution(session.id, {
              queueID: view.identity.queueID,
              userMessageID: view.identity.userMessageID,
            }),
          ).toMatchObject({ viewKind: "historical", eligibility: "stale", descendants: [] })
          expect(
            yield* Effect.flip(SessionHandoff.execution(session.id, { queueID: view.identity.queueID })),
          ).toMatchObject({ code: "incomplete_action_selector" })
          expect(
            yield* Effect.flip(
              SessionHandoff.execution(session.id, { queueID: "other", userMessageID: view.identity.userMessageID }),
            ),
          ).toMatchObject({ code: "not_found" })
          expect(yield* f.llm.calls).toBe(0)
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
)

it.live(
  "a persisted root provider error leaves recovery held and records continuation failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.store.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const session = yield* enrolled(f)
          yield* f.database.db.run(
            sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id = ${session.id}`,
          )
          const restarted = RuntimeLifecycle.make(
            { lineage: f.runtime.identity.lineage },
            yield* Effect.scope,
            f.database,
          )
          const fresh = yield* Layer.build(
            AppNodeBuilderV1.build(
              LayerNode.group([
                Session.node,
                SessionPrompt.node,
                InstanceStore.node,
                Database.node,
                SessionProjector.node,
                Provider.node,
                Agent.node,
              ]),
              [[Database.node, Layer.succeed(Database.Service)(f.database)]],
            ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
          )
          yield* Effect.gen(function* () {
            yield* restarted.recover(() => Effect.die("automatic recovery must remain held"))
            const view = yield* SessionHandoff.execution(session.id)
            if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
              throw new Error("Missing recovery guards")
            const request = {
              requestID: randomUUID(),
              expected: view.identity,
              expectedRecoveryRevision: view.recoveryRevision,
              expectedDescendantDigest: view.descendantDigest,
              target: { providerID: "test", modelID: "test-model", variant: "default" },
              children: [],
            }
            yield* f.llm.push({
              type: "http-error",
              status: 400,
              body: { error: { message: "Synthetic rejected request", type: "invalid_request_error" } },
            })
            yield* SessionHandoff.recover(session.id, request)
            const receipt = yield* pollWithTimeout(
              SessionHandoff.receipt(session.id, request.requestID).pipe(
                Effect.map((value) =>
                  "reason" in value && value.reason === "continuation_failed" ? value : undefined,
                ),
              ),
              "root provider error was treated as successful recovery",
            )
            expect(receipt).toMatchObject({ state: "applied", reason: "continuation_failed" })
            expect(
              yield* f.database.db.get(sql`SELECT state FROM runtime_execution WHERE session_id = ${session.id}`),
            ).toEqual({ state: "recovery_needed" })
            expect(
              yield* f.database.db.get(
                sql`SELECT 1 AS held FROM session_handoff_recovery_hold WHERE root_session_id = ${session.id}`,
              ),
            ).toEqual({ held: 1 })
          }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
        }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
      )
    }),
  30_000,
)

for (const scenario of ["root", "terminal", "new_tasks", "compaction"] as const) {
  const terminalRoot = scenario === "terminal"
  const newTasks = scenario === "new_tasks"
  const compaction = scenario === "compaction"
  it.live(
    newTasks
      ? "recovered root admits a new reviewer and audit without releasing the original closure holds"
      : compaction
        ? "recovered root automatic compaction preserves exact owned queue restoration"
        : terminalRoot
          ? "terminal-root recovery resumes only the existing background child without changing or rerunning the root"
          : "service recovery preserves a Task child's original input and selection and reports its actual result separately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* f.store.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const root = yield* enrolled(f)
            const original = yield* SessionHandoff.execution(root.id)
            if (!original.identity) throw new Error("Missing root identity")
            const key = { queueID: original.identity.queueID, userMessageID: original.identity.userMessageID }
            const parentMessageID = MessageID.ascending()
            const childUserID = MessageID.ascending()
            const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
            const task = {
              parentSessionId: root.id,
              parentMessageID,
              parentCallID: "review-call",
              messageID: childUserID,
              model,
              ...(newTasks ? { variant: "" } : {}),
            }
            const child = yield* f.sessions.create({
              title: "reviewer",
              parentID: root.id,
              agent: "general",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
              metadata: { task },
            })
            yield* f.sessions.updateMessage({
              id: parentMessageID,
              sessionID: root.id,
              role: "assistant",
              parentID: MessageID.make(original.identity.userMessageID),
              agent: "build",
              mode: "build",
              modelID: model.modelID,
              providerID: model.providerID,
              path: { cwd: f.directory, root: f.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 2, ...(compaction ? { completed: 2 } : {}) },
              ...(compaction
                ? {
                    finish: "tool-calls",
                    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  }
                : {}),
            })
            yield* SessionHandoffStore.appendAssistant(
              f.database,
              {
                sessionID: root.id,
                queueID: original.identity.queueID,
                userMessageID: original.identity.userMessageID,
              },
              {
                kind: "ordinary",
                messageID: parentMessageID,
                parentUserMessageID: original.identity.userMessageID,
                authorizationUserMessageID: original.identity.userMessageID,
                epochSequence: 0,
                controlRequestID: null,
                selection: { ...model, variant: "default" },
                selectionEvidence: "persisted_message",
                dispatch: "unknown",
              },
            )
            const partID = PartID.ascending()
            yield* f.sessions.updatePart({
              id: partID,
              sessionID: root.id,
              messageID: parentMessageID,
              type: "tool",
              tool: "task",
              callID: "review-call",
              state: {
                status: "running",
                input: { prompt: "Review the existing input", subagent_type: "general", command: "review" },
                metadata: { ...task, sessionId: child.id, ...(terminalRoot ? { background: true } : {}) },
                time: { start: 2 },
              },
            })
            yield* f.sessions.updateMessage({
              id: childUserID,
              sessionID: child.id,
              role: "user",
              agent: "general",
              model: newTasks ? { ...model, variant: "" } : model,
              time: { created: 3 },
            })
            yield* f.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: child.id,
              messageID: childUserID,
              type: "text",
              text: "Review the existing input",
            })
            yield* f.runtime.admit({
              sessionID: child.id,
              directory: f.directory,
              parentSessionID: root.id,
              parentMessageID,
              parentCallID: "review-call",
              parentMode: terminalRoot ? "background" : "foreground",
            })
            if (terminalRoot) {
              const boundary = yield* SessionHandoffNotification.boundary(f.database, root.id)
              yield* SessionHandoffNotification.terminalize(f.database, root.id, boundary)
              yield* f.runtime.release(root.id)
            }
            const input = yield* f.database.db.get(
              sql`SELECT id,session_id,json_remove(data,'$.summary') AS data FROM message WHERE id = ${childUserID}`,
            )
            yield* f.database.db.run(
              sql`UPDATE runtime_execution SET owner_start_time = '0' WHERE session_id IN (${root.id},${child.id})`,
            )
            const originalParts = yield* f.database.db.all(
              sql`SELECT id,message_id,data FROM part WHERE message_id=${childUserID} ORDER BY id`,
            )
            const originalSelection = yield* f.database.db.get(
              sql`SELECT agent,model,permission,metadata FROM session WHERE id=${child.id}`,
            )
            const rootRuntime = yield* f.database.db.get(
              sql`SELECT * FROM runtime_execution WHERE session_id = ${root.id}`,
            )
            const restarted = RuntimeLifecycle.make(
              { lineage: f.runtime.identity.lineage },
              yield* Effect.scope,
              f.database,
            )
            const fresh = yield* Layer.build(
              AppNodeBuilderV1.build(
                LayerNode.group([
                  Session.node,
                  SessionPrompt.node,
                  InstanceStore.node,
                  Database.node,
                  SessionProjector.node,
                  Provider.node,
                  Agent.node,
                ]),
                [[Database.node, Layer.succeed(Database.Service)(f.database)]],
              ).pipe(Layer.provide(Layer.succeed(RuntimeLifecycle.Service)(restarted)), Layer.fresh),
            )
            yield* Effect.gen(function* () {
              yield* restarted.recover(() => Effect.die("automatic child recovery must remain held"))
              const view = yield* SessionHandoff.execution(root.id)
              if (!view.identity || view.recoveryRevision === null || !view.descendantDigest)
                throw new Error("Missing root recovery guards")
              const descendant = view.descendants[0]
              if (
                !descendant?.link ||
                !descendant.inputDigest ||
                !descendant.ownerLineage ||
                !descendant.ownerInstance ||
                descendant.fence === null ||
                descendant.recoveryRevision === null
              )
                throw new Error("Missing child guards")
              expect(descendant).toMatchObject({
                proof: "verified",
                selection: { ...model, variant: "default" },
                agent: "general",
                resultState: "none",
                interruptedResources: [],
              })
              const request = {
                requestID: randomUUID(),
                expected: view.identity,
                expectedRecoveryRevision: view.recoveryRevision,
                target: { ...model, variant: "high" },
                expectedDescendantDigest: view.descendantDigest,
                children: [
                  {
                    link: descendant.link,
                    inputDigest: descendant.inputDigest,
                    ownerLineage: descendant.ownerLineage,
                    ownerInstance: descendant.ownerInstance,
                    fence: descendant.fence,
                    recoveryRevision: descendant.recoveryRevision,
                  },
                ],
              }
              const prior = yield* f.database.db.all(
                sql`SELECT session_id,fence FROM runtime_execution WHERE session_id IN (${root.id},${child.id}) ORDER BY session_id`,
              )
              expect(yield* Effect.flip(SessionHandoff.recover(root.id, { ...request, children: [] }))).toMatchObject({
                code: "stale_context",
              })
              expect(
                yield* f.database.db.all(
                  sql`SELECT session_id,fence FROM runtime_execution WHERE session_id IN (${root.id},${child.id}) ORDER BY session_id`,
                ),
              ).toEqual(prior)
              const reviewerGate = Promise.withResolvers<void>()
              const finalGate = Promise.withResolvers<void>()
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  reviewerGate.resolve()
                  finalGate.resolve()
                }),
              )
              yield* f.llm.push(
                ...(terminalRoot
                  ? [reply().text("Actual reviewer result").stop()]
                  : newTasks
                    ? [
                        reply().text("Actual reviewer result").stop(),
                        reply().tool("task", {
                          description: "second reviewer",
                          subagent_type: "general",
                          model: "test/test-model",
                          prompt: "Perform a new second review.",
                        }),
                        reply().wait(reviewerGate.promise).text("Second reviewer actual result").stop(),
                        reply().tool("task", {
                          description: "audit",
                          subagent_type: "audit",
                          model: "test/test-model",
                          variant: "high",
                          prompt: "Perform a new audit.",
                        }),
                        reply().text("Audit actual result").stop(),
                        reply().wait(finalGate.promise).text("Root continuation").stop(),
                      ]
                    : compaction
                      ? [
                          reply().text("Actual reviewer result").stop(),
                          reply().text("Synthetic compacted summary").stop(),
                          reply().text("Root continuation").stop(),
                        ]
                      : [reply().text("Actual reviewer result").stop(), reply().text("Root continuation").stop()]),
              )
              yield* f.database.db
                .run(sql`CREATE TRIGGER IF NOT EXISTS reject_early_recovery_final_receipt BEFORE INSERT ON session_handoff_receipt
                WHEN json_extract(NEW.data,'$.kind')='recovery'
                  AND json_extract(NEW.data,'$.children[0].state')='terminal'
                  AND json_extract(NEW.data,'$.children[0].recoveryFence')>json_extract(NEW.data,'$.children[0].priorFence')
                  AND json_extract(NEW.data,'$.reason') IS NOT 'continuation_failed'
                  AND EXISTS (SELECT 1 FROM runtime_execution WHERE session_id=json_extract(NEW.data,'$.sessionID') AND state <> 'completed')
                BEGIN SELECT RAISE(ABORT,'terminal recovery receipt before actual root completion'); END`)
              expect(yield* SessionHandoff.recover(root.id, request)).toMatchObject({
                state: terminalRoot ? "expired" : "applied",
                children: [{ link: descendant.link, state: "claimed" }],
                interruptedResources: [{ tool: "task", effect: "uncertain" }],
              })
              if (newTasks) {
                yield* pollWithTimeout(
                  f.llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
                  "new reviewer did not dispatch",
                  "20 seconds",
                )
                const control = yield* f.database.db.get<{ reservation: string; data: string }>(
                  sql`SELECT reservation,data FROM session_handoff_control WHERE session_id=${root.id}`,
                )
                const running = yield* f.database.db.get<{
                  session_id: string
                  parent_message_id: string
                  parent_call_id: string
                }>(
                  sql`SELECT session_id,parent_message_id,parent_call_id FROM runtime_execution WHERE parent_session_id=${root.id} AND session_id!=${child.id} AND state='active'`,
                )
                const owner = yield* f.database.db.get<{ fence: number }>(
                  sql`SELECT fence FROM runtime_execution WHERE session_id=${root.id}`,
                )
                if (!control || !running || !owner) throw new Error("Missing admitted reviewer authority")
                const authority = {
                  sessionID: root.id,
                  reservation: control.reservation,
                  controlData: control.data,
                  ownerLineage: restarted.identity.lineage,
                  ownerInstance: restarted.identity.instance,
                  fence: owner.fence,
                }
                const binding = {
                  sessionID: running.session_id,
                  parentMessageID: running.parent_message_id,
                  parentCallID: running.parent_call_id,
                  parentFence: owner.fence,
                }
                const check = (
                  proof: SessionHandoffRecovery.RootAdmission | undefined,
                  caller = { ownerLineage: authority.ownerLineage, ownerInstance: authority.ownerInstance },
                ) =>
                  SessionHandoffEnrollment.newTaskAllowed(f.database, running.session_id, caller).pipe(
                    Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, proof),
                    Effect.provideService(SessionHandoffRecovery.CurrentNewTask, {
                      ...binding,
                      parentFence: proof?.fence ?? binding.parentFence,
                    }),
                  )
                expect(yield* check(authority)).toBe(true)
                expect(yield* check(undefined)).toBe(false)
                expect(yield* check({ ...authority, fence: authority.fence + 1 })).toBe(false)
                expect(
                  yield* check(
                    { ...authority, ownerInstance: "stale-owner" },
                    { ownerLineage: authority.ownerLineage, ownerInstance: "stale-owner" },
                  ),
                ).toBe(false)
                expect(
                  yield* check(authority, { ownerLineage: authority.ownerLineage, ownerInstance: "foreign-caller" }),
                ).toBe(false)
                expect(yield* check({ ...authority, controlData: `${authority.controlData} ` })).toBe(false)
                expect(
                  yield* SessionHandoffEnrollment.newTaskAllowed(f.database, child.id).pipe(
                    Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                    Effect.provideService(SessionHandoffRecovery.CurrentNewTask, { ...binding, sessionID: child.id }),
                  ),
                ).toBe(false)
                for (const mutation of [
                  sql`UPDATE session SET permission='[]' WHERE id=${root.id}`,
                  sql`UPDATE runtime_execution SET fence=fence+1 WHERE session_id=${root.id}`,
                  sql`UPDATE runtime_execution SET owner_instance='replacement-owner' WHERE session_id=${root.id}`,
                  sql`INSERT INTO session_handoff_root (session_id,reservation,state) VALUES (${root.id},'competing-preparation','reserved')`,
                ]) {
                  expect(
                    yield* Effect.flip(
                      f.database.db.transaction(
                        (tx) =>
                          Effect.gen(function* () {
                            yield* tx.run(mutation)
                            expect(
                              yield* SessionHandoffEnrollment.newTaskAllowed({ db: tx }, running.session_id).pipe(
                                Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                                Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                              ),
                            ).toBe(false)
                            return yield* Effect.fail("rollback" as const)
                          }),
                        { behavior: "immediate" },
                      ),
                    ),
                  ).toBe("rollback")
                }
                expect(
                  yield* Effect.flip(
                    SessionHandoffEnrollment.reserve(f.database, running.session_id, "unclaimed-preparation"),
                  ),
                ).toMatchObject({ code: "invalidated" })
                const foreign = RuntimeLifecycle.make(
                  { lineage: restarted.identity.lineage },
                  yield* Effect.scope,
                  f.database,
                )
                expect(
                  yield* Effect.flip(
                    foreign
                      .admit({
                        sessionID: running.session_id,
                        directory: f.directory,
                        parentSessionID: root.id,
                        parentMessageID: running.parent_message_id,
                        parentCallID: running.parent_call_id,
                        parentMode: "foreground",
                      })
                      .pipe(
                        Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                        Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                      ),
                  ),
                ).toMatchObject({ _tag: "RuntimeDrainingError" })
                for (const mismatch of [
                  { parentCallID: "wrong-call" },
                  { parentSessionID: child.id },
                  { parentMode: "background" },
                ] as const) {
                  expect(
                    yield* Effect.flip(
                      restarted
                        .admit({
                          sessionID: running.session_id,
                          directory: f.directory,
                          parentSessionID: root.id,
                          parentMessageID: running.parent_message_id,
                          parentCallID: running.parent_call_id,
                          parentMode: "foreground",
                          ...mismatch,
                        })
                        .pipe(
                          Effect.provideService(SessionHandoffRecovery.CurrentRootAdmission, authority),
                          Effect.provideService(SessionHandoffRecovery.CurrentNewTask, binding),
                        ),
                    ),
                  ).toMatchObject({ _tag: "RuntimeDrainingError" })
                }
                reviewerGate.resolve()
                yield* pollWithTimeout(
                  f.llm.calls.pipe(Effect.map((calls) => (calls === 6 ? true : undefined))),
                  "new reviewer and audit did not run",
                  "20 seconds",
                )
                expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                  children: [{ state: "continuing", resultState: "completed" }],
                })
                const live = yield* SessionHandoff.execution(root.id)
                expect(live.descendants).toHaveLength(3)
                expect(live.descendants.find((item) => item.childSessionID === child.id)).toMatchObject({
                  state: "terminal",
                  resultState: "completed",
                  link: descendant.link,
                })
                for (const item of live.descendants.filter((item) => item.childSessionID !== child.id)) {
                  expect(item).toMatchObject({
                    proof: "verified",
                    state: "terminal",
                    resultState: "completed",
                    fence: 0,
                    selection: {
                      providerID: "test",
                      modelID: "test-model",
                      variant: item.agent === "audit" ? "high" : "default",
                    },
                  })
                  expect(typeof item.resultAssistantMessageID).toBe("string")
                  expect(
                    yield* f.database.db.get(
                      sql`SELECT count(*) AS count FROM message WHERE session_id=${item.childSessionID} AND json_extract(data,'$.role')='user'`,
                    ),
                  ).toEqual({ count: 1 })
                  expect(
                    yield* f.database.db.get(
                      sql`SELECT json_extract(data,'$.text') AS text FROM part WHERE message_id=${item.resultAssistantMessageID} AND json_extract(data,'$.type')='text'`,
                    ),
                  ).toEqual({ text: item.agent === "audit" ? "Audit actual result" : "Second reviewer actual result" })
                }
                expect(
                  live.descendants
                    .filter((item) => item.childSessionID !== child.id)
                    .map((item) => item.agent)
                    .sort(),
                ).toEqual(["audit", "general"])
                expect(live.descendants.find((item) => item.childSessionID === child.id)?.fence).toBe(
                  descendant.fence + 1,
                )
                expect(
                  yield* f.database.db.get(
                    sql`SELECT count(*) AS count FROM session_handoff_recovery_hold WHERE root_session_id=${root.id}`,
                  ),
                ).toEqual({ count: 2 })
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,state,reason FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID} ORDER BY session_id`,
                  ),
                ).toEqual(
                  [root.id, child.id].sort().map((session_id) => ({ session_id, state: "owned", reason: null })),
                )
                finalGate.resolve()
              }
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const row = yield* f.database.db.get<{ state: string }>(
                    sql`SELECT state FROM runtime_execution WHERE session_id = ${terminalRoot ? child.id : root.id}`,
                  )
                  return row?.state === "completed" ? true : undefined
                }),
                "Task tree continuation did not finish",
              )
              if (newTasks) {
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,id,state,delivery FROM session_queue WHERE state IN ('pending','claimed','uncertain')`,
                  ),
                ).toEqual([])
                expect(
                  yield* f.database.db.all(sql`SELECT session_id,paused FROM session_queue_state WHERE paused=1`),
                ).toEqual([])
              }
              if (!terminalRoot)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT state,reason FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID}`,
                  ),
                ).toEqual([
                  { state: "restored", reason: null },
                  { state: "restored", reason: null },
                ])
              expect(
                (yield* f.llm.inputs).map((input) => ({ model: input.model, effort: input.reasoning_effort })),
              ).toEqual(
                terminalRoot
                  ? [{ model: "test-model", effort: undefined }]
                  : newTasks
                    ? [
                        { model: "test-model", effort: undefined },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: undefined },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: "high" },
                        { model: "test-model", effort: "high" },
                      ]
                    : compaction
                      ? [
                          { model: "test-model", effort: undefined },
                          { model: "test-model", effort: "high" },
                          { model: "test-model", effort: "high" },
                        ]
                      : [
                          { model: "test-model", effort: undefined },
                          { model: "test-model", effort: "high" },
                        ],
              )
              if (terminalRoot)
                expect(
                  yield* f.database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${root.id}`),
                ).toEqual(rootRuntime)
              if (compaction)
                expect(
                  yield* f.database.db.all(
                    sql`SELECT kind FROM session_handoff_compaction WHERE session_id=${root.id} AND kind IN ('request','continuation') ORDER BY rowid`,
                  ),
                ).toEqual([{ kind: "request" }, { kind: "continuation" }])
              expect((yield* f.llm.inputs)[0]).not.toHaveProperty("reasoning_effort")
              expect(
                yield* f.database.db.get(
                  sql`SELECT id,session_id,json_remove(data,'$.summary') AS data FROM message WHERE id = ${childUserID}`,
                ),
              ).toEqual(input)
              expect(
                yield* f.database.db.all(
                  sql`SELECT id,message_id,data FROM part WHERE message_id=${childUserID} ORDER BY id`,
                ),
              ).toEqual(originalParts)
              expect(
                yield* f.database.db.get(sql`SELECT agent,model,permission,metadata FROM session WHERE id=${child.id}`),
              ).toEqual(originalSelection)
              expect(
                yield* f.database.db.get(
                  sql`SELECT count(*) AS count FROM message WHERE session_id = ${child.id} AND json_extract(data,'$.role') = 'user'`,
                ),
              ).toEqual({ count: 1 })
              expect(
                yield* f.database.db.get<{ status: string }>(
                  sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id = ${partID}`,
                ),
              ).toEqual({ status: "error" })
              expect(yield* SessionHandoff.receipt(root.id, request.requestID)).toMatchObject({
                children: [
                  {
                    link: descendant.link,
                    state: "terminal",
                    resultState: "completed",
                    resultAssistantMessageID: expect.any(String),
                  },
                ],
              })
              expect(
                (yield* SessionHandoff.execution(root.id)).descendants.find((item) => item.childSessionID === child.id),
              ).toMatchObject({
                link: descendant.link,
                state: "terminal",
                resultState: "completed",
                resultAssistantMessageID: expect.any(String),
              })
              if (terminalRoot)
                expect(
                  yield* f.database.db.get(
                    sql`SELECT 1 AS held FROM session_handoff_recovery_hold WHERE root_session_id=${root.id} LIMIT 1`,
                  ),
                ).toEqual({ held: 1 })
              if (!terminalRoot)
                yield* pollWithTimeout(
                  f.database.db
                    .get(sql`SELECT 1 FROM session_handoff_recovery_hold WHERE root_session_id=${root.id}`)
                    .pipe(Effect.map((row) => (row ? undefined : true))),
                  "history capture did not finish",
                )
              if (!terminalRoot) {
                expect(
                  yield* f.database.db.all(
                    sql`SELECT session_id,state FROM session_handoff_recovery_queue_block WHERE recovery_request_id=${request.requestID} ORDER BY session_id`,
                  ),
                ).toEqual([root.id, child.id].sort().map((session_id) => ({ session_id, state: "restored" })))
                expect(
                  yield* f.database.db.all(
                    sql`SELECT blocked,paused FROM session_queue_state WHERE session_id IN (${root.id},${child.id})`,
                  ),
                ).toEqual([
                  { blocked: 0, paused: 0 },
                  { blocked: 0, paused: 0 },
                ])
              }
              const action = yield* SessionHandoff.execution(root.id, key)
              const current = yield* SessionHandoff.execution(root.id)
              expect(action.descendants).toEqual(current.descendants)
              expect(action.descendantDigest).toBe(current.descendantDigest)
              expect(action.descendants.find((item) => item.childSessionID === child.id)).toMatchObject({
                link: descendant.link,
                agent: "general",
                resultState: "completed",
                selection: { providerID: "test", modelID: "test-model", variant: "default" },
              })
              yield* f.database.db.run(
                sql`UPDATE session SET metadata='{}',agent='plan',permission='[]' WHERE id=${child.id}`,
              )
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET parent_call_id='reused-before-next-root',fence=fence+1 WHERE session_id=${child.id}`,
              )
              yield* SessionHandoffRecovery.captureCurrent(
                f.database,
                child.id,
                restarted.verifyOwner,
                RuntimeLifecycle.processLiveness,
              )
              expect((yield* SessionHandoff.execution(root.id, key)).descendants).toEqual(action.descendants)
              // A later generation and reused child are mutable current state,
              // never evidence for the retained original action selector.
              yield* f.database.db.run(
                sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id) VALUES (${root.id},'later-role','active','later-queue','later-user')`,
              )
              yield* f.database.db.run(
                sql`UPDATE session SET metadata='{}',agent='plan',permission='[]' WHERE id IN (${child.id},${root.id})`,
              )
              yield* f.database.db.run(
                sql`UPDATE runtime_execution SET parent_call_id='later-call',fence=fence+1 WHERE session_id=${child.id}`,
              )
              const historical = yield* SessionHandoff.execution(root.id, key)
              expect(historical).toMatchObject({ isCurrent: false, eligibility: "stale", viewKind: "historical" })
              expect(historical.descendants).toEqual(action.descendants)
              expect(historical.interruptedResources).toEqual(action.interruptedResources)
              expect(historical.descendantDigest).toBe(action.descendantDigest)
              expect(historical.assistants).toEqual(action.assistants)
              expect(yield* SessionHandoff.execution(root.id)).toMatchObject({ enrolled: false, descendants: [] })
              expect(
                yield* Effect.flip(SessionHandoff.execution(root.id, { ...key, userMessageID: "later-user" })),
              ).toMatchObject({ code: "not_found" })
              yield* f.database.db.run(
                sql`INSERT INTO session_handoff_recovery_history (session_id,queue_id,user_message_id,revision,data) SELECT session_id,queue_id,user_message_id,MAX(revision)+1,'{}' FROM session_handoff_recovery_history WHERE session_id=${root.id} AND queue_id=${key.queueID} AND user_message_id=${key.userMessageID}`,
              )
              expect(yield* Effect.flip(SessionHandoff.execution(root.id, key))).toMatchObject({
                code: "history_unavailable",
              })
            }).pipe(Effect.provide(fresh), Effect.provideService(RuntimeLifecycle.Service, restarted))
          }).pipe(Effect.provide(f.context), Effect.provideService(RuntimeLifecycle.Service, f.runtime)),
        )
      }),
    30_000,
  )
}
