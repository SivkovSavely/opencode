import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
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

it.instance("serializes a compressed durable message event as logical sync data", () =>
  Effect.gen(function* () {
    expect(process.env.OPENCODE_DB).toBe(":memory:")
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const session = yield* sessions.create({})
    const message = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      summary: {
        diffs: [
          {
            file: "large.txt",
            patch: "-before\n+after\n".repeat(10000),
            additions: 10000,
            deletions: 10000,
          },
        ],
      },
    } as SessionV1.User
    const received = yield* Deferred.make<EventV2.SerializedEvent>()
    const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
      if (
        event.payload.type !== "sync" ||
        event.payload.syncEvent?.type !== EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)
      )
        return
      if (event.payload.syncEvent.aggregateID !== session.id) return
      Deferred.doneUnsafe(received, Effect.succeed(JSON.parse(JSON.stringify(event.payload.syncEvent))))
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

    yield* sessions.updateMessage(message)
    const sync = yield* Deferred.await(received).pipe(Effect.timeout("2 seconds"))
    expect(sync.data).toEqual({ sessionID: session.id, info: message })
    expect(yield* database.db.get(sql`SELECT typeof(data) AS storage FROM event WHERE id = ${sync.id}`)).toEqual({
      storage: "blob",
    })
    expect((yield* sessions.messages({ sessionID: session.id }))[0]?.info).toEqual(message)
  }),
)
