import { expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ServerScheduler } from "@/server/scheduler"
import { Session } from "@/session/session"
import { SessionSchedule } from "@/session/schedule"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionSchedule.node, Session.node, SessionProjector.node, Database.node, EventV2Bridge.node]),
  ),
)

it.instance("keeps concurrent definition order after rowid renumbering", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const schedules = yield* SessionSchedule.Service
    const session = yield* sessions.create({})
    yield* Effect.addFinalizer(() =>
      database.db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie),
    )
    const input = {
      message: "scheduled",
      spec: { mode: "interval" as const, amount: 1, unit: "minutes" as const, immediate: true },
      sessionState: "always" as const,
      deferUntilIdle: false,
      missed: "all" as const,
    }
    const created = yield* Effect.all(
      Array.from({ length: 3 }, () => schedules.create(session.id, input)),
      {
        concurrency: "unbounded",
      },
    )
    const rows = yield* database.db.all<{ id: string }>(sql`SELECT id FROM session_schedule ORDER BY rowid`)
    const order = rows.map((row) => row.id).filter((id) => created.some((item) => item.id === id))
    const now = Date.now()
    for (const [index, id] of order.entries()) {
      yield* database.db.run(
        sql`UPDATE session_schedule SET rowid = ${1000000 - index}, time_created = ${now}, next = ${now} WHERE id = ${id}`,
      )
    }
    expect((yield* schedules.list(session.id)).map((item) => item.id)).toEqual(order)
    const dispatched: string[] = []
    const scheduler = ServerScheduler.engine({
      database,
      startup: 0,
      dispatch: (schedule) =>
        Effect.sync(() => {
          dispatched.push(schedule.id)
          return "idle" as const
        }),
    })
    for (const _ of order) yield* scheduler.step(now)
    expect(dispatched).toEqual(order)
  }),
)
