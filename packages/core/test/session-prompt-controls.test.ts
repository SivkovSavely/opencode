import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, type LLMRequest } from "@opencode-ai/llm"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { Catalog } from "../src/catalog"
import { CommandV2 } from "../src/command"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { ModelV2 } from "../src/model"
import { PermissionV2 } from "../src/permission"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionActiveSelection } from "../src/session/active-selection"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionRunner } from "../src/session/runner"
import { node } from "../src/session/runner/llm"
import { SessionTable } from "../src/session/sql"
import { SkillV2 } from "../src/skill"
import { Snapshot } from "../src/snapshot"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_controls")
const providerID = ProviderV2.ID.make("fake")
const directory = AbsolutePath.make(import.meta.dir)
const base = ModelV2.Ref.make({ providerID, id: ModelV2.ID.make("base"), variant: ModelV2.VariantID.make("default") })
const replacement = ModelV2.Ref.make({
  providerID,
  id: ModelV2.ID.make("replacement"),
  variant: ModelV2.VariantID.make("default"),
})
const requests: LLMRequest[] = []
const responses: Stream.Stream<LLMEvent>[] = []
let catalogGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
let agentGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void>; fail?: boolean } | undefined
const agentLayer = Layer.effect(
  AgentV2.Service,
  AgentV2.Service.use((service) =>
    Effect.succeed(
      AgentV2.Service.of({
        ...service,
        select: (id) =>
          Effect.suspend(() => {
            const gate = agentGate
            agentGate = undefined
            return service
              .select(id)
              .pipe(
                Effect.tap(() =>
                  gate
                    ? Deferred.succeed(gate.entered, undefined).pipe(
                        Effect.andThen(Deferred.await(gate.release)),
                        Effect.andThen(gate.fail ? Effect.die("Next-attempt preparation failed") : Effect.void),
                      )
                    : Effect.void,
                ),
              )
          }),
      }),
    ),
  ),
).pipe(Layer.provide(AgentV2.locationLayer))
const catalog = Layer.effect(
  Catalog.Service,
  Catalog.Service.use((service) =>
    Effect.succeed(
      Catalog.Service.of({
        ...service,
        model: {
          ...service.model,
          available: () =>
            Effect.suspend(() => {
              const gate = catalogGate
              catalogGate = undefined
              return service.model
                .available()
                .pipe(
                  Effect.tap(() =>
                    gate
                      ? Deferred.succeed(gate.entered, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
                      : Effect.void,
                  ),
                )
            }),
        },
      }),
    ),
  ),
).pipe(Layer.provide(Catalog.layer))
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    generate: () => Effect.die("unused"),
    stream: (request) => {
      requests.push(request)
      return (
        responses.shift() ??
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop" })])
      )
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      node,
      SessionV2.node,
      SessionActiveSelection.node,
      Database.node,
      Catalog.node,
      EventV2.node,
      AgentV2.node,
      SkillV2.node,
      PermissionV2.node,
      ToolRegistry.node,
      LocationServiceMap.node,
    ]),
    [
      [Location.node, Location.boundNode({ directory })],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LayerNodePlatform.llmClient, client],
      [Catalog.node, { ...Catalog.node, implementation: catalog }],
      [AgentV2.node, { ...AgentV2.node, implementation: agentLayer }],
      [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    ],
  ),
)

const setup = Effect.gen(function* () {
  requests.length = 0
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: directory,
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "controls",
      directory,
      title: "controls",
      version: "test",
      model: base,
    })
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  const sessions = yield* SessionV2.Service
  const locations = yield* LocationServiceMap.Service
  const populateCatalog = Catalog.Service.use((catalog) =>
    catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => {
        provider.api = { type: "aisdk", package: "@ai-sdk/openai", settings: {} }
      })
      for (const id of [base.id, replacement.id])
        draft.model.update(providerID, id, (model) => {
          model.api = { type: "aisdk", package: "@ai-sdk/openai", id, settings: {} }
        })
    }),
  )
  yield* populateCatalog
  yield* populateCatalog.pipe(Effect.provide(locations.get((yield* sessions.get(sessionID)).location)))
  yield* agents.transform((draft) =>
    draft.update(AgentV2.defaultID, (agent) => {
      agent.permissions = [{ action: "skill", resource: "*", effect: "ask" }]
    }),
  )
  const skills = yield* SkillV2.Service
  yield* skills.transform((draft) =>
    draft.source({
      type: "embedded",
      skill: {
        name: "review",
        content: "Review implementation carefully.",
        location: AbsolutePath.make("/skills/review.md"),
      },
    }),
  )
})

describe("current prompt controls", () => {
  for (const outcome of ["continue", "interrupt", "error"] as const) {
    it.effect(`retains a pending accepted steer after terminal stop, then cleans up on ${outcome}`, () =>
      Effect.gen(function* () {
        yield* setup
        const sessions = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const events = yield* EventV2.Service
        const active = yield* SessionActiveSelection.Service
        const locations = yield* LocationServiceMap.Service
        const high = ModelV2.VariantID.make("high")
        const variants = Catalog.Service.use((catalog) =>
          catalog.transform((draft) => {
            draft.model.update(providerID, base.id, (model) => {
              model.variants = [{ id: high, headers: {}, body: { reasoning_effort: "high" } }]
            })
          }),
        )
        yield* variants
        yield* variants.pipe(Effect.provide(locations.get((yield* sessions.get(sessionID)).location)))
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Ended.type && requests.length === 1)
            agentGate = { entered, release, fail: outcome === "error" }
          return Effect.void
        })
        responses.push(
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
            Stream.fromEffect(
              Deferred.await(finish).pipe(Effect.as(LLMEvent.stepFinish({ index: 0, reason: "stop" }))),
            ),
          ),
        )
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: { text: "start Luna", selection: { model: { providerID, modelID: replacement.id } } },
        })
        const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        const token = active.parent(sessionID)?.token
        const selected = yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "accept B/high before Luna ends",
            selection: { inheritActive: true, model: { providerID, modelID: base.id }, variant: high },
          },
        })
        expect(selected.prompt.model).toEqual({ ...base, variant: high })
        yield* Deferred.succeed(finish, undefined)
        yield* Deferred.await(entered)
        expect(active.parent(sessionID)?.token).toBe(token)
        expect(
          (yield* sessions.prompt({
            sessionID,
            resume: false,
            prompt: { text: "inherit B/high after terminal stop", selection: { inheritActive: true } },
          })).prompt.model,
        ).toEqual(selected.prompt.model)
        if (outcome === "interrupt") yield* Fiber.interrupt(running)
        if (outcome !== "interrupt") {
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(running))._tag).toBe(outcome === "continue" ? "Success" : "Failure")
        }
        if (outcome === "continue") {
          expect(requests).toHaveLength(2)
          expect(String(requests[1]?.model.id)).toBe(base.id)
          expect(requests[1]?.model.route.defaults?.http?.body).toMatchObject({ reasoning_effort: "high" })
        }
        expect(active.get(sessionID)).toBeUndefined()
        expect((yield* sessions.get(sessionID)).model).toEqual(base)
        expect(
          (yield* sessions.prompt({
            sessionID,
            resume: false,
            prompt: { text: "fresh uses saved base", selection: { inheritActive: true } },
          })).prompt.model,
        ).toEqual(base)
      }),
    )
  }

  for (const outcome of ["continue", "interrupt", "error"] as const) {
    it.effect(`retains active inheritance between settled tools and preparation, then cleans up on ${outcome}`, () =>
      Effect.gen(function* () {
        yield* setup
        const sessions = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const registry = yield* ToolRegistry.Service
        const events = yield* EventV2.Service
        const active = yield* SessionActiveSelection.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Ended.type && requests.length === 1)
            agentGate = { entered, release, fail: outcome === "error" }
          return Effect.void
        })
        yield* registry.register({
          settled: Tool.make({
            description: "Settle before delaying the next provider attempt",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.succeed({}),
          }),
        })
        responses.push(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "settled", name: "settled", input: {} }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          ]),
        )
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: { text: "use override", selection: { model: { providerID, modelID: replacement.id } } },
        })
        const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered)
        expect(active.get(sessionID)).toEqual(replacement)
        expect(
          (yield* sessions.prompt({
            sessionID,
            resume: false,
            prompt: { text: "plain steer in preparation gap", selection: { inheritActive: true } },
          })).prompt.model,
        ).toEqual(replacement)
        // A newer accepted selection must win when the next attempt finally prepares.
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "new override in gap",
            selection: { inheritActive: true, model: { providerID, modelID: base.id } },
          },
        })
        expect(
          (yield* sessions.prompt({
            sessionID,
            resume: false,
            prompt: {
              text: "inherit newest gap selection",
              selection: { inheritActive: true },
            },
          })).prompt.model,
        ).toEqual(base)
        if (outcome === "interrupt") yield* Fiber.interrupt(running)
        if (outcome !== "interrupt") {
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(running))._tag).toBe(outcome === "continue" ? "Success" : "Failure")
        }
        expect(requests).toHaveLength(outcome === "continue" ? 2 : 1)
        if (outcome === "continue") expect(String(requests[1]?.model.id)).toBe(base.id)
        expect(active.get(sessionID)).toBeUndefined()
        // A later fresh input/forced drain must not resurrect the abandoned parent.
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: { text: "fresh", selection: { inheritActive: true } },
        })
        yield* runner.run({ sessionID, force: true })
        expect(String(requests.at(-1)?.model.id)).toBe(base.id)
        expect(active.get(sessionID)).toBeUndefined()
      }),
    )
  }

  for (const overflow of [false, true]) {
    it.effect(`preserves ownership and accepted steers across ${overflow ? "overflow" : "automatic"} compaction`, () =>
      Effect.gen(function* () {
        yield* setup
        const sessions = yield* SessionV2.Service
        const runner = yield* SessionRunner.Service
        const events = yield* EventV2.Service
        const active = yield* SessionActiveSelection.Service
        const locations = yield* LocationServiceMap.Service
        const high = ModelV2.VariantID.make("high")
        const selected = { ...base, variant: high }
        const limits = Catalog.Service.use((catalog) =>
          catalog.transform((draft) => {
            draft.model.update(providerID, replacement.id, (model) => {
              model.limit = { context: overflow ? 100_000 : 50_000, output: 4096 }
            })
            draft.model.update(providerID, base.id, (model) => {
              model.variants = [{ id: high, headers: {}, body: { reasoning_effort: "high" } }]
            })
          }),
        )
        yield* limits
        yield* limits.pipe(Effect.provide(locations.get((yield* sessions.get(sessionID)).location)))
        const summarizing = yield* Deferred.make<void>()
        const summarized = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const resumed = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        yield* events.listen((event) => {
          if (event.type === SessionEvent.Compaction.Ended.type) agentGate = { entered, release }
          return Effect.void
        })
        if (overflow)
          responses.push(
            Stream.make(LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })),
          )
        responses.push(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(summarizing, undefined).pipe(
                Effect.as(LLMEvent.textDelta({ id: "summary", text: "Compact summary." })),
              ),
            ),
            Stream.fromEffect(Deferred.await(summarized).pipe(Effect.as(LLMEvent.finish({ reason: "stop" })))),
          ),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(resumed, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
            Stream.fromEffect(
              Deferred.await(finish).pipe(Effect.as(LLMEvent.stepFinish({ index: 0, reason: "stop" }))),
            ),
          ),
        )
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "earlier details ".repeat(9000),
            selection: { model: { providerID, modelID: replacement.id } },
          },
        })
        const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.forkChild)
        yield* Deferred.await(summarizing)
        const parent = active.parent(sessionID)
        expect(parent?.model).toEqual(replacement)
        yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "switch during summary",
            selection: { inheritActive: true, model: { providerID, modelID: base.id }, variant: high },
          },
        })
        yield* Deferred.succeed(summarized, undefined)
        yield* Deferred.await(entered)
        expect(active.parent(sessionID)?.token).toBe(parent?.token)
        expect(
          (yield* sessions.prompt({
            sessionID,
            resume: false,
            prompt: { text: "plain after compaction", selection: { inheritActive: true } },
          })).prompt.model,
        ).toEqual(selected)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(resumed)
        expect(active.parent(sessionID)?.token).toBe(parent?.token)
        expect(active.get(sessionID)).toEqual(selected)
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(running)
        expect(requests).toHaveLength(overflow ? 4 : 3)
        expect(String(requests.at(-1)?.model.id)).toBe(base.id)
        expect(requests.at(-1)?.model.route.defaults?.http?.body).toMatchObject({ reasoning_effort: "high" })
        expect(active.get(sessionID)).toBeUndefined()
      }),
    )
  }

  it.effect("inherits the live parent override while a real tool settles after the provider stream ends", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const registry = yield* ToolRegistry.Service
      const active = yield* SessionActiveSelection.Service
      const started = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* registry.register({
        waiting: Tool.make({
          description: "Wait for the test to release tool settlement",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})),
        }),
      })
      responses.push(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "waiting", name: "waiting", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        ]).pipe(Stream.ensuring(Deferred.succeed(ended, undefined))),
      )
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: { text: "wait", selection: { model: { providerID, modelID: replacement.id } } },
      })
      const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Deferred.await(ended)
      yield* Effect.yieldNow
      expect(active.get(sessionID)).toEqual(replacement)
      expect(
        (yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: { text: "plain steer during settlement", selection: { inheritActive: true } },
        })).prompt.model,
      ).toEqual(replacement)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(requests).toHaveLength(2)
      expect(String(requests[1]?.model.id)).toBe(replacement.id)
      expect(active.get(sessionID)).toBeUndefined()
    }),
  )

  it.effect("publishes rapid steer selections at admission and drops inheritance before terminal persistence", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const events = yield* EventV2.Service
      const locations = yield* LocationServiceMap.Service
      const location = (yield* sessions.get(sessionID)).location
      const high = ModelV2.VariantID.make("high")
      const sol = { ...base, variant: high }
      yield* db.update(SessionTable).set({ model: sol }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      const variants = Catalog.Service.use((catalog) =>
        catalog.transform((draft) => {
          for (const id of [base.id, replacement.id])
            draft.model.update(providerID, id, (model) => {
              model.variants = [{ id: high, headers: {}, body: { reasoning_effort: "high" } }]
            })
        }),
      )
      yield* variants
      yield* variants.pipe(Effect.provide(locations.get(location)))
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const continuing = yield* Deferred.make<void>()
      const lastFinish = yield* Deferred.make<void>()
      const terminal = yield* Deferred.make<void>()
      const persist = yield* Deferred.make<void>()
      responses.push(
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
          Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(LLMEvent.stepFinish({ index: 0, reason: "stop" })))),
        ),
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(continuing, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
          Stream.fromEffect(
            Deferred.await(lastFinish).pipe(Effect.as(LLMEvent.stepFinish({ index: 0, reason: "stop" }))),
          ),
        ),
      )
      const stop = yield* events.listen((event) =>
        event.type === SessionEvent.Step.Ended.type && requests.length === 2
          ? Deferred.succeed(terminal, undefined).pipe(Effect.andThen(Deferred.await(persist)))
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => stop)
      const plain = { text: "next", selection: { inheritActive: true } }
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          ...plain,
          selection: {
            inheritActive: true,
            model: { providerID, modelID: replacement.id },
            variant: ModelV2.VariantID.make("default"),
          },
        },
      })
      const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect((yield* sessions.prompt({ sessionID, resume: false, prompt: plain })).prompt.model).toEqual(replacement)
      expect((yield* sessions.prompt({ sessionID, resume: false, prompt: plain })).prompt.model).toEqual(replacement)
      const selected = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          ...plain,
          selection: { inheritActive: true, variant: high },
        },
      })
      expect(selected.prompt.model).toEqual({ ...replacement, variant: high })
      expect((yield* sessions.prompt({ sessionID, resume: false, prompt: plain })).prompt.model).toEqual(
        selected.prompt.model,
      )
      const switched = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          ...plain,
          selection: { inheritActive: true, model: { providerID, modelID: base.id } },
        },
      })
      expect(switched.prompt.model).toEqual(sol)
      expect((yield* sessions.prompt({ sessionID, resume: false, prompt: plain })).prompt.model).toEqual(sol)
      expect(requests).toHaveLength(1)
      const queued = yield* sessions.prompt({ sessionID, resume: false, delivery: "queue", prompt: plain })
      expect(queued.prompt.model).toEqual(sol)
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          ...plain,
          selection: { inheritActive: true, model: { providerID, modelID: replacement.id }, variant: high },
        },
      })
      // Let the accepted steers promote. Only a queue remains pending when this next provider turn ends.
      yield* Deferred.succeed(finish, undefined)
      yield* Deferred.await(continuing)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      catalogGate = { entered, release }
      const delayed = yield* sessions.prompt({ sessionID, resume: false, prompt: plain }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Deferred.succeed(lastFinish, undefined)
      yield* Deferred.await(terminal)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(delayed)).prompt.model).toEqual(sol)
      const idle = yield* sessions.prompt({ sessionID, resume: false, prompt: plain })
      expect(idle.prompt.model).toEqual(sol)
      // Exact retry must not resolve against the now-idle persistent Sol/high pair.
      expect(
        (yield* sessions.prompt({
          sessionID,
          id: selected.id,
          resume: false,
          prompt: {
            ...plain,
            selection: { inheritActive: true, variant: high },
          },
        })).prompt.model,
      ).toEqual(selected.prompt.model)
      yield* Deferred.succeed(persist, undefined)
      yield* Fiber.join(running)
      expect((yield* sessions.get(sessionID)).model).toEqual(sol)
    }),
  )

  it.effect("rejects explicit unavailable models and variants before either queue or steer admission", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const db = (yield* Database.Service).db
      for (const delivery of ["steer", "queue"] as const) {
        for (const selection of [
          { model: { providerID, modelID: ModelV2.ID.make("missing") } },
          { model: { providerID, modelID: base.id }, variant: ModelV2.VariantID.make("missing") },
        ]) {
          const id = SessionMessage.ID.create()
          const rejected = yield* sessions
            .prompt({ sessionID, id, delivery, resume: false, prompt: { text: "invalid", selection } })
            .pipe(Effect.flip)
          expect(rejected._tag).toBe("Session.InvalidModelError")
          expect(yield* SessionInput.find(db, id)).toBeUndefined()
        }
      }
      expect(
        (yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "valid",
            selection: { variant: ModelV2.VariantID.make("default") },
          },
        })).delivery,
      ).toBe("steer")
    }),
  )

  it.effect("captures catalog variant defaults once rather than resolving them again at execution or retry", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const locations = yield* LocationServiceMap.Service
      const location = (yield* sessions.get(sessionID)).location
      const high = ModelV2.VariantID.make("high")
      const low = ModelV2.VariantID.make("low")
      const configure = (variant: ModelV2.VariantID | undefined) => {
        const update = Catalog.Service.use((catalog) =>
          catalog.transform((draft) => {
            draft.model.update(providerID, base.id, (model) => {
              model.request.variant = variant
              model.variants = [high, low].map((id) => ({ id, headers: {}, body: { reasoning_effort: id } }))
            })
          }),
        )
        return update.pipe(Effect.andThen(update.pipe(Effect.provide(locations.get(location)))))
      }
      for (const variant of [high, undefined]) {
        yield* configure(variant)
        const prompt = { text: "captured default", selection: { variant: ModelV2.VariantID.make("default") } }
        const admitted = yield* sessions.prompt({ sessionID, resume: false, prompt })
        expect(admitted.prompt.model?.variant).toBe(variant ?? ModelV2.VariantID.make("default"))
        yield* configure(low)
        expect((yield* sessions.prompt({ sessionID, id: admitted.id, resume: false, prompt })).prompt.model).toEqual(
          admitted.prompt.model,
        )
        yield* runner.run({ sessionID, force: false })
        expect(requests.at(-1)?.model.route.defaults.http?.body?.reasoning_effort).toBe(variant)
      }
    }),
  )

  it.live("retains only supported inherited variants across model changes and lets explicit variants win", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const active = yield* SessionActiveSelection.Service
      const locations = yield* LocationServiceMap.Service
      const location = (yield* sessions.get(sessionID)).location
      const high = ModelV2.VariantID.make("high")
      active.set(sessionID, { ...replacement, variant: high })
      const prompt = {
        text: "override",
        model: base,
        selection: { inheritActive: true, model: { providerID, modelID: base.id } },
      }
      const unsupported = yield* sessions.prompt({ sessionID, resume: false, prompt })
      expect(unsupported.prompt.model?.variant).toBe(ModelV2.VariantID.make("default"))
      yield* Catalog.Service.use((catalog) =>
        catalog.transform((draft) => {
          draft.provider.update(providerID, () => {})
          draft.model.update(providerID, base.id, (model) => {
            model.variants = [{ id: high, headers: {}, body: {} }]
          })
          draft.model.update(providerID, replacement.id, (model) => {
            model.variants = [{ id: high, headers: {}, body: {} }]
          })
        }),
      ).pipe(Effect.provide(locations.get(location)))
      active.set(sessionID, { ...replacement, variant: high })
      const supported = yield* sessions.prompt({ sessionID, resume: false, prompt })
      expect(supported.prompt.model).toEqual({ ...base, variant: high })
      const reset = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: { ...prompt, selection: { ...prompt.selection, variant: ModelV2.VariantID.make("default") } },
      })
      expect(reset.prompt.model?.variant).toBe(ModelV2.VariantID.make("default"))
      active.set(sessionID, { ...replacement, variant: high })
      const variantOnly = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: { text: "variant only", model: base, selection: { inheritActive: true, variant: high } },
      })
      expect(variantOnly.prompt.model).toEqual({ ...replacement, variant: high })
    }),
  )

  it.effect("captures active inheritance once, preserves exact retries, and snapshots queues separately", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const active = yield* SessionActiveSelection.Service
      const database = yield* Database.Service
      active.set(sessionID, replacement)
      const input = {
        id: SessionMessage.ID.make("msg_inherited"),
        sessionID,
        resume: false,
        prompt: { text: "steer", model: base, selection: { inheritActive: true } },
      }
      const admitted = yield* sessions.prompt(input)
      expect(admitted.prompt.model).toEqual(replacement)
      active.set(sessionID, base)
      expect(yield* sessions.prompt(input)).toEqual(admitted)
      expect(yield* SessionInput.find(database.db, admitted.id)).toEqual(admitted)
      expect(
        (yield* sessions.prompt({ ...input, prompt: { ...input.prompt, model: replacement } }).pipe(Effect.flip))._tag,
      ).toBe("Session.PromptConflictError")
      active.set(sessionID, replacement)
      const queued = yield* sessions.prompt({ ...input, id: SessionMessage.ID.make("msg_queued"), delivery: "queue" })
      expect(queued.prompt.model).toEqual(base)
      active.clear(sessionID)
      const idle = yield* sessions.prompt({ ...input, id: SessionMessage.ID.make("msg_idle") })
      expect(idle.prompt.model).toEqual(base)
    }),
  )

  it.effect("uses an override for one user turn without changing Session defaults, even after compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const events = yield* EventV2.Service
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          text: "override",
          model: base,
          selection: { model: { providerID, modelID: replacement.id } },
        },
      })
      yield* runner.run({ sessionID, force: true })
      expect(requests[0]?.model).toMatchObject({ id: "replacement" })
      expect((yield* sessions.get(sessionID)).model).toEqual(base)
      expect((yield* SessionActiveSelection.Service).get(sessionID)).toBeUndefined()
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        reason: "manual",
        text: "summary",
        recent: "recent",
      })
      yield* runner.run({ sessionID, force: true })
      expect(requests[1]?.model).toMatchObject({ id: "replacement" })
      yield* sessions.prompt({ sessionID, resume: false, prompt: { text: "normal", model: base } })
      yield* runner.run({ sessionID, force: true })
      expect(requests[2]?.model).toMatchObject({ id: "base" })
    }),
  )

  it.effect("waits for skill permission, durably loads instructions once, and never sends the marker as media", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const events = yield* EventV2.Service
      const permission = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type && Schema.is(PermissionV2.Request)(event.data)
          ? Deferred.succeed(asked, event.data).pipe(Effect.asVoid)
          : Effect.void,
      )
      const admitted = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          text: "hello $review",
          files: [{ uri: "skill:review", name: "review" }, { uri: "skill:review" }],
          selection: { model: { providerID, modelID: replacement.id }, variant: ModelV2.VariantID.make("default") },
        },
      })
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      const request = yield* Deferred.await(asked)
      expect(request).toMatchObject({ action: "skill", resources: ["review"], save: ["review"], sessionID })
      expect(requests).toEqual([])
      expect(
        (yield* sessions.prompt({
          sessionID,
          resume: false,
          prompt: {
            text: "while permission waits",
            selection: { inheritActive: true },
          },
        })).prompt.model,
      ).toEqual(replacement)
      yield* permission.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(run)
      const text = JSON.stringify(requests[0]?.messages)
      expect(text).toContain("Review implementation carefully.")
      expect(text).toContain("Base directory for this skill: /skills")
      expect(text).not.toContain('"url":"skill:review"')
      expect(text).not.toContain('"type":"media"')
      expect((yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")).toHaveLength(
        1,
      )
      expect((yield* sessions.message({ sessionID, messageID: admitted.id }))?.type).toBe("user")
      yield* runner.run({ sessionID, force: true })
      expect(yield* permission.list()).toEqual([])
      expect(requests).toHaveLength(3)
    }),
  )

  it.effect("does not reveal skill content for denied or unknown explicit skills", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions = [{ action: "skill", resource: "*", effect: "deny" }]
        }),
      )
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          text: "review",
          files: [{ uri: "skill:review" }, { uri: "skill:missing" }],
        },
      })
      yield* runner.run({ sessionID, force: true })
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("Review implementation carefully.")
      expect(JSON.stringify(requests[0]?.messages)).toContain("Unable to load skill review")
      expect(JSON.stringify(requests[0]?.messages)).toContain("Unable to load skill missing")
    }),
  )

  it.effect("records an interactive skill rejection before stopping and never asks for that marker again", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const permission = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const asks: PermissionV2.Request[] = []
      yield* events.listen((event) => {
        if (event.type !== PermissionV2.Event.Asked.type || !Schema.is(PermissionV2.Request)(event.data))
          return Effect.void
        asks.push(event.data)
        return Deferred.succeed(asked, event.data).pipe(Effect.asVoid)
      })
      const admitted = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: { text: "review", files: [{ uri: "skill:review" }] },
      })
      const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.exit, Effect.forkChild)
      const request = yield* Deferred.await(asked)
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      expect((yield* Fiber.join(running))._tag).toBe("Failure")
      expect((yield* SessionActiveSelection.Service).get(sessionID)).toBeUndefined()
      expect(requests).toHaveLength(0)
      const markers = (yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")
      expect(markers).toMatchObject([
        { id: `${admitted.id}_skill_review`, text: "Skill review permission declined by user" },
      ])
      yield* sessions.prompt({ sessionID, resume: false, prompt: { text: "ordinary followup" } })
      yield* runner.run({ sessionID, force: false })
      yield* runner.run({ sessionID, force: true })
      expect(asks).toHaveLength(1)
      expect(requests).toHaveLength(2)
      expect(yield* permission.list()).toEqual([])
      expect((yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")).toEqual(
        markers,
      )
    }),
  )

  it.effect("records an interrupted skill invocation and never asks for that historical marker again", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const permission = yield* PermissionV2.Service
      const active = yield* SessionActiveSelection.Service
      const events = yield* EventV2.Service
      const asked = yield* Deferred.make<void>()
      const asks: PermissionV2.Request[] = []
      yield* events.listen((event) => {
        if (event.type !== PermissionV2.Event.Asked.type || !Schema.is(PermissionV2.Request)(event.data))
          return Effect.void
        asks.push(event.data)
        return Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
      })
      const admitted = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: { text: "review", files: [{ uri: "skill:review" }] },
      })
      const running = yield* runner.run({ sessionID, force: false }).pipe(Effect.forkChild)
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(running)
      const interrupted = yield* Fiber.await(running)
      expect(interrupted._tag).toBe("Failure")
      if (interrupted._tag === "Failure") expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
      expect(active.get(sessionID)).toBeUndefined()
      expect(yield* permission.list()).toEqual([])
      expect(requests).toHaveLength(0)
      const markers = (yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")
      expect(markers).toMatchObject([
        { id: `${admitted.id}_skill_review`, text: "Skill review invocation interrupted" },
      ])
      yield* sessions.prompt({ sessionID, resume: false, prompt: { text: "unrelated followup" } })
      yield* runner.run({ sessionID, force: false })
      yield* runner.run({ sessionID, force: true })
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("Review implementation carefully.")
      expect(asks).toHaveLength(1)
      expect(yield* permission.list()).toEqual([])
      expect(active.get(sessionID)).toBeUndefined()
      expect((yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")).toEqual(
        markers,
      )
    }),
  )

  it.effect("decodes Unicode skill URIs and durably reports malformed URIs without retry poison", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const agents = yield* AgentV2.Service
      const skills = yield* SkillV2.Service
      const name = "r\u00e9vision"
      yield* agents.transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions = [{ action: "skill", resource: "*", effect: "allow" }]
        }),
      )
      yield* skills.transform((draft) =>
        draft.source({
          type: "embedded",
          skill: { name, content: "Unicode skill instructions.", location: AbsolutePath.make("/skills/unicode.md") },
        }),
      )
      const admitted = yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: {
          text: "load skills",
          files: [{ uri: `skill:${encodeURIComponent(name)}` }, { uri: `skill:${name}` }, { uri: "skill:%ZZ" }],
        },
      })
      yield* runner.run({ sessionID, force: false })
      expect(JSON.stringify(requests[0]?.messages)).toContain("Unicode skill instructions.")
      expect(JSON.stringify(requests[0]?.messages)).toContain("malformed skill URI skill:%ZZ")
      const markers = (yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")
      expect(markers).toHaveLength(2)
      expect(markers.map((message) => message.id)).toContain(
        SessionMessage.ID.make(`${admitted.id}_skill_${encodeURIComponent(name)}`),
      )
      yield* runner.run({ sessionID, force: true })
      expect((yield* sessions.messages({ sessionID })).filter((message) => message.type === "synthetic")).toEqual(
        markers,
      )
    }),
  )

  it.live("expands real commands with defaults and lets explicit controls win", () =>
    Effect.gen(function* () {
      yield* setup
      const locations = yield* LocationServiceMap.Service
      const sessions = yield* SessionV2.Service
      const location = (yield* sessions.get(sessionID)).location
      yield* CommandV2.Service.use((commands) =>
        commands.transform((draft) =>
          draft.update("review", (command) => {
            command.template = "Review $1 then $2"
            command.model = replacement
            command.agent = "build"
            command.subtask = false
          }),
        ),
      ).pipe(Effect.provide(locations.get(location)))
      yield* Catalog.Service.use((catalog) =>
        catalog.transform((draft) => {
          draft.provider.update(providerID, () => {})
          draft.model.update(providerID, base.id, () => {})
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const admitted = yield* sessions.command({
        sessionID,
        command: "review",
        arguments: '"first file" second third',
        resume: false,
      })
      expect(admitted.prompt.text).toBe("Review first file then second third")
      expect(admitted.prompt.model).toEqual(replacement)
      const explicit = yield* sessions.command({
        sessionID,
        command: "review",
        arguments: "one two",
        resume: false,
        selection: { model: { providerID, modelID: base.id }, variant: ModelV2.VariantID.make("default") },
      })
      expect(explicit.prompt.model).toEqual({ ...base, variant: ModelV2.VariantID.make("default") })
      yield* AgentV2.Service.use((agents) =>
        agents.transform((draft) =>
          draft.update(AgentV2.ID.make("build"), (agent) => {
            agent.model = replacement
          }),
        ),
      ).pipe(Effect.provide(locations.get(location)))
      yield* CommandV2.Service.use((commands) =>
        commands.transform((draft) => {
          draft.update("sparse", (command) => {
            command.template = "$1/$3"
            command.agent = "build"
            command.subtask = false
          })
          draft.update("passes", (command) => {
            command.template = "$1"
            command.subtask = false
          })
          draft.update("mixed", (command) => {
            command.template = "$1 + $ARGUMENTS"
            command.subtask = false
          })
          draft.update("append", (command) => {
            command.template = "Review"
            command.subtask = false
          })
          draft.update("shell", (command) => {
            command.template = "Inspect !`pwd`"
            command.subtask = false
          })
          draft.update("broken-shell", (command) => {
            command.template = "Inspect !`pwd"
            command.subtask = false
          })
          draft.update("subtask", (command) => {
            command.template = "Do work"
            command.subtask = true
          })
        }),
      ).pipe(Effect.provide(locations.get(location)))
      const sparse = yield* sessions.command({ sessionID, command: "sparse", arguments: "one two", resume: false })
      expect(sparse.prompt.text).toBe("one/")
      expect(sparse.prompt.model).toEqual(replacement)
      expect(
        (yield* sessions.command({
          sessionID,
          command: "sparse",
          resume: false,
          selection: { model: { providerID, modelID: base.id } },
        })).prompt.model,
      ).toEqual(base)
      expect(
        (yield* sessions.command({ sessionID, command: "passes", arguments: "$ARGUMENTS", resume: false })).prompt.text,
      ).toBe("$ARGUMENTS")
      expect(
        (yield* sessions.command({ sessionID, command: "passes", arguments: "$ARGUMENTS extra", resume: false })).prompt
          .text,
      ).toBe("$ARGUMENTS extra")
      expect(
        (yield* sessions.command({ sessionID, command: "mixed", arguments: "'$ARGUMENTS $2' extra", resume: false }))
          .prompt.text,
      ).toBe("$ARGUMENTS $2 extra + '$ARGUMENTS $2' extra")
      expect(
        (yield* sessions.command({ sessionID, command: "append", arguments: "'$ARGUMENTS $2'", resume: false })).prompt
          .text,
      ).toBe("Review\n\n'$ARGUMENTS $2'")
      // The caller's agent model is not a configured command default.
      expect(
        (yield* sessions.command({ sessionID, command: "passes", agent: AgentV2.defaultID, resume: false })).prompt
          .model,
      ).toEqual(base)
      yield* AgentV2.Service.use((agents) =>
        agents.transform((draft) =>
          draft.update(AgentV2.defaultID, (agent) => {
            agent.model = base
          }),
        ),
      ).pipe(Effect.provide(locations.get(location)))
      const active = yield* SessionActiveSelection.Service
      active.set(sessionID, replacement)
      expect(
        (yield* sessions.command({
          sessionID,
          command: "passes",
          agent: AgentV2.defaultID,
          selection: { inheritActive: true },
          resume: false,
        })).prompt.model,
      ).toEqual(replacement)
      active.clear(sessionID)
      for (const command of ["shell", "broken-shell", "subtask"]) {
        const id = SessionMessage.ID.create()
        const error = yield* sessions.command({ sessionID, id, command, resume: false }).pipe(Effect.flip)
        expect(error._tag).toBe("Session.OperationUnavailableError")
        expect(yield* SessionInput.find((yield* Database.Service).db, id)).toBeUndefined()
      }
      expect((yield* sessions.command({ sessionID, command: "missing", resume: false }).pipe(Effect.flip))._tag).toBe(
        "Session.CommandNotFoundError",
      )
    }),
  )
})
