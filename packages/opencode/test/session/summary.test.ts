import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionSummary.node,
      Snapshot.node,
      Config.node,
      EventV2Bridge.node,
      SessionProjector.node,
      Database.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

it.instance(
  "recreates summary service and serializes real snapshot changes",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const snapshot = yield* Snapshot.Service
      const events = yield* EventV2Bridge.Service
      const instance = yield* TestInstance
      const session = yield* sessions.create({})
      const messageID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const file = path.join(instance.directory, "change.txt")
      const message = {
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test", variant: "variant" },
        system: "original system",
        format: new SessionV1.OutputFormatText({ type: "text" }),
        tools: { bash: false },
        summary: { title: "title", body: "body", diffs: [] },
      } as unknown as SessionV1.User
      yield* sessions.updateMessage(message)
      yield* sessions.updateMessage({
        id: assistantID,
        sessionID: session.id,
        parentID: messageID,
        role: "assistant",
        time: { created: Date.now() },
        agent: "build",
        mode: "build",
        path: { cwd: instance.directory, root: instance.directory },
        modelID: "test",
        providerID: "test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* Effect.promise(() => Bun.write(file, "before\n"))
      const before = yield* snapshot.track()
      yield* Effect.promise(() => Bun.write(file, "first\n"))
      const first = yield* snapshot.track()
      yield* Effect.promise(() => Bun.write(file, "second\n"))
      const second = yield* snapshot.track()
      if (!before || !first || !second) throw new Error("expected git snapshots")
      const finishID = PartID.ascending()
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: session.id,
        type: "step-start",
        snapshot: before,
      })
      const finish = {
        id: finishID,
        messageID: assistantID,
        sessionID: session.id,
        type: "step-finish" as const,
        reason: "stop",
        snapshot: first,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* sessions.updatePart(finish)
      const updates: SessionV1.User[] = []
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      let diffEvents = 0
      const unsub = yield* events.listen((event) => {
        if (event.type === SessionV1.Event.MessageUpdated.type) {
          const info = (event.data as typeof SessionV1.Event.MessageUpdated.data.Type).info
          if (info.id === messageID && info.role === "user") updates.push(info as SessionV1.User)
        }
        if (event.type === Session.Event.Diff.type && ++diffEvents === 2)
          Deferred.doneUnsafe(secondStarted, Effect.void)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const input = { sessionID: session.id, messageID }
      yield* summary.summarize(input)
      expect(updates).toHaveLength(1)
      expect(updates[0]?.summary?.diffs).toEqual([
        expect.objectContaining({ file: "change.txt", patch: expect.stringContaining("+first") }),
      ])

      // Build a new service against the same persisted session, with a gated real snapshot call.
      let gated = false
      const fresh = Layer.fresh(
        SessionSummary.node.implementation as Layer.Layer<
          SessionSummary.Service,
          never,
          Session.Service | Snapshot.Service | EventV2Bridge.Service | Config.Service
        >,
      )
      const context = yield* Layer.build(fresh).pipe(
        Effect.provideService(
          Snapshot.Service,
          Snapshot.Service.of({
            ...snapshot,
            diffFull: (from, to, context) =>
              Effect.gen(function* () {
                if (!gated) {
                  gated = true
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }
                return yield* snapshot.diffFull(from, to, context)
              }),
          }),
        ),
      )
      const recreated = Context.get(context, SessionSummary.Service)
      updates.length = 0
      diffEvents = 0
      const old = yield* recreated.summarize(input).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* sessions.updateMessage({
        ...message,
        system: "updated system",
        summary: { title: "title", body: "body", diffs: yield* summary.diff(input) },
      })
      updates.length = 0
      yield* sessions.updatePart({ ...finish, snapshot: second })
      const newer = yield* recreated.summarize(input).pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(old)
      yield* Fiber.join(newer)
      expect(updates).toHaveLength(1)
      expect(updates[0]?.summary?.diffs).toEqual([
        expect.objectContaining({ file: "change.txt", patch: expect.stringContaining("+second") }),
      ])
      expect(updates[0]).toEqual({
        ...message,
        system: "updated system",
        summary: { title: "title", body: "body", diffs: updates[0]?.summary?.diffs ?? [] },
      })
      yield* recreated.summarize(input)
      expect(updates).toHaveLength(1)
    }),
  { git: true },
)

it.instance("publishes only changed user summaries, including concurrent attempts", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const session = yield* sessions.create({})
    const messageID = MessageID.ascending()
    const message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      system: "preserve me",
    } as SessionV1.User
    yield* sessions.updateMessage(message)
    const updates: SessionV1.User[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === SessionV1.Event.MessageUpdated.type) {
        const info = (event.data as typeof SessionV1.Event.MessageUpdated.data.Type).info
        if (info.id === messageID && info.role === "user") updates.push(info as SessionV1.User)
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)

    const input = { sessionID: session.id, messageID }
    yield* Effect.all([summary.summarize(input), summary.summarize(input)], { concurrency: "unbounded" })
    yield* summary.summarize(input)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.summary).toEqual({ diffs: [] })
    expect(updates[0]?.system).toBe("preserve me")

    yield* sessions.updateMessage({
      ...message,
      summary: {
        title: "title",
        body: "body",
        diffs: [{ file: "a", before: "", after: "x", additions: 1, deletions: 0 }],
      },
    })
    updates.length = 0
    yield* summary.summarize(input)
    yield* summary.summarize(input)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.summary).toEqual({ title: "title", body: "body", diffs: [] })
    expect((yield* sessions.messages({ sessionID: session.id }))[0]?.info).toEqual(updates[0])
  }),
)

it.instance("preserves persisted JSON schema output format when publishing a summary", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const session = yield* sessions.create({})
    const message = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test", variant: "custom" },
      system: "keep this",
      tools: { bash: false },
      format: new SessionV1.OutputFormatJsonSchema({
        type: "json_schema",
        schema: { type: "object", properties: { value: { type: "string" } } },
        retryCount: 5,
      }),
      summary: { title: "title", body: "body", diffs: [] },
    } as unknown as SessionV1.User
    yield* sessions.updateMessage(message)
    const updates: SessionV1.User[] = []
    const unsub = yield* events.listen((event) => {
      if (event.type === SessionV1.Event.MessageUpdated.type) {
        const info = (event.data as typeof SessionV1.Event.MessageUpdated.data.Type).info
        if (info.id === message.id && info.role === "user") updates.push(info as SessionV1.User)
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    const input = { sessionID: session.id, messageID: message.id }
    // Seed a real change while retaining the format and the remaining message metadata.
    yield* sessions.updateMessage({
      ...message,
      summary: { ...message.summary!, diffs: [{ file: "a", additions: 1, deletions: 0 }] },
    })
    updates.length = 0
    yield* summary.summarize(input)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual(message)
    expect(updates[0]?.format).toBeInstanceOf(SessionV1.OutputFormatJsonSchema)
    yield* summary.summarize(input)
    expect(updates).toHaveLength(1)

    const withoutRetry = {
      ...message,
      id: MessageID.ascending(),
      format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "object" } }),
      summary: { title: "title", body: "body", diffs: [{ file: "a", additions: 1, deletions: 0 }] },
    }
    yield* sessions.updateMessage(withoutRetry)
    yield* summary.summarize({ sessionID: session.id, messageID: withoutRetry.id })
    const persisted = (yield* sessions.messages({ sessionID: session.id })).find(
      (item) => item.info.id === withoutRetry.id,
    )
    expect(persisted?.info).toEqual({
      ...withoutRetry,
      format: { type: "json_schema", schema: { type: "object" } },
      summary: { title: "title", body: "body", diffs: [] },
    })
  }),
)
