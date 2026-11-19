import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffEnrollment } from "../src/session/handoff-enrollment"
import { SessionHandoffNotification } from "../src/session/handoff-notification"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { tmpdir } from "./fixture/tmpdir"

const selection = { providerID: "synthetic", modelID: "sol", variant: "max" }
const link = {
  parentSessionID: "parent",
  parentMessageID: "assistant",
  parentCallID: "call",
  childSessionID: "child",
  childUserMessageID: "child-user",
  childResultMessageID: "child-result",
  childExecution: { id: "child", ownerLineage: "lineage", ownerInstance: "instance", fence: 1 },
}
const owner = { ownerLineage: "lineage", ownerInstance: "instance", fence: 1 }

async function run(
  body: (db: SessionHandoffStore.Connection["db"], directory: string) => Effect.Effect<void, unknown>,
) {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${tmp.path}, 1, 1, '[]')`,
      )
      const task = {
        parentSessionId: "parent",
        parentMessageID: "assistant",
        parentCallID: "call",
        messageID: "child-user",
        model: selection,
        variant: "max",
        background: true,
      }
      for (const id of ["parent", "child"]) {
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, metadata) VALUES (${id}, 'project', ${id === "child" ? "parent" : null}, ${id}, ${tmp.path}, 'test', '1', 1, 1, ${JSON.stringify(id === "child" ? { task } : {})})`,
        )
        yield* db.run(
          sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated, parent_session_id, parent_message_id, parent_call_id, parent_mode) VALUES (${id}, ${id}, ${tmp.path}, 'lineage', 'instance', 1, ${id === "child" ? "completed" : "active"}, ${id === "child" ? 0 : 1}, 1, 1, ${id === "child" ? "parent" : null}, ${id === "child" ? "assistant" : null}, ${id === "child" ? "call" : null}, ${id === "child" ? "background" : null})`,
        )
      }
      yield* SessionHandoffEnrollment.reserve({ db }, "parent", "root")
      const user = {
        role: "user",
        agent: "build",
        model: selection,
        system: "root system",
        tools: { bash: false },
        format: { type: "json_schema", schema: { type: "object" } },
        time: { created: 1 },
      }
      for (const [id, sessionID, data] of [
        ["root-user", "parent", user],
        ["child-user", "child", { role: "user", agent: "general", model: selection, time: { created: 2 } }],
        [
          "child-result",
          "child",
          { role: "assistant", parentID: "child-user", time: { created: 2, completed: 3 }, finish: "stop" },
        ],
      ] as const)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${id}, ${sessionID}, 1, 1, ${JSON.stringify(data)})`,
        )
      const payload = { kind: "prompt", parts: [] }
      yield* db.run(
        sql`INSERT INTO session_queue (id, session_id, delivery, state, position, payload, submission, message_id, time_created) VALUES ('queue', 'parent', 'queue', 'delivered', 1, ${JSON.stringify(payload)}, ${JSON.stringify({ delivery: "queue", payload })}, 'root-user', 1)`,
      )
      yield* SessionHandoffEnrollment.delivered({ db }, "parent", "root", "queue", "root-user")
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'parent', 2, 2, ${JSON.stringify({ role: "assistant", parentID: "root-user", providerID: "synthetic", modelID: "sol", variant: "max", time: { created: 2 } })})`,
      )
      yield* db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('task', 'assistant', 'parent', 2, 2, ${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "completed", metadata: { ...task, sessionId: "child" } } })})`,
      )
      yield* body(db, tmp.path)
    }).pipe(Effect.provide(layer({ filename: `${tmp.path}/notification.db` })), Effect.scoped),
  )
}

const admit = Effect.fnUntraced(function* (db: SessionHandoffStore.Connection["db"], input = link) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* tx.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_task_notification_child', 'parent', 3, 3, ${JSON.stringify({ role: "user", agent: "notification-agent", model: { providerID: "other", modelID: "other" }, time: { created: 3 } })})`,
        )
        return yield* SessionHandoffNotification.admit({ db: tx }, "parent", "msg_task_notification_child", input)
      }),
    { behavior: "immediate" },
  )
})

test("verified notification preserves an active queue action and enrollment snapshot", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const before = yield* SessionHandoffEnrollment.candidate({ db }, "parent", directory, owner)
      const child = yield* db.get(sql`SELECT * FROM session WHERE id = 'child'`)
      const part = yield* db.get(sql`SELECT * FROM part WHERE id = 'task'`)
      expect(yield* admit(db)).toMatchObject({
        classification: "in_action",
        reservation: "root",
        userMessageID: "root-user",
      })
      expect(yield* SessionHandoffNotification.context({ db }, "parent", "msg_task_notification_child")).toMatchObject({
        userMessageID: "root-user",
        selection,
      })
      const after = yield* SessionHandoffEnrollment.candidate({ db }, "parent", directory, owner)
      expect(after).not.toBeNull()
      expect(after?.historyDigest).not.toBe(before?.historyDigest)
      if (!before) throw new Error("Missing initial candidate")
      expect(
        yield* Effect.flip(
          SessionHandoffEnrollment.enroll({ db }, "parent", directory, owner, { ...before, requestID: "stale" }),
        ),
      ).toMatchObject({ code: "stale_context" })
      expect(yield* db.get(sql`SELECT * FROM session WHERE id = 'child'`)).toEqual(child)
      expect(yield* db.get(sql`SELECT * FROM part WHERE id = 'task'`)).toEqual(part)
    }),
  ))

test("notification admission and terminalization serialize in both orders", async () => {
  for (const first of ["notification", "terminal"])
    await run((db) =>
      Effect.gen(function* () {
        const boundary = yield* SessionHandoffNotification.boundary({ db }, "parent")
        if (first === "notification") {
          yield* admit(db)
          expect(yield* SessionHandoffNotification.terminalize({ db }, "parent", boundary)).toBe(false)
          expect(yield* db.get(sql`SELECT state FROM session_handoff_root WHERE reservation = 'root'`)).toEqual({
            state: "active",
          })
        }
        if (first === "terminal") {
          expect(yield* SessionHandoffNotification.terminalize({ db }, "parent", boundary)).toBe(true)
          expect(yield* admit(db)).toMatchObject({ classification: "later", reservation: "root" })
        }
      }),
    )
})

test("a prior-action notification cannot inherit the next root context", () =>
  run((db) =>
    Effect.gen(function* () {
      yield* SessionHandoffEnrollment.close({ db }, "parent", "terminal")
      yield* SessionHandoffEnrollment.reserve({ db }, "parent", "next")
      yield* SessionHandoffEnrollment.delivered({ db }, "parent", "next", "queue", "root-user")
      expect(yield* admit(db)).toMatchObject({ classification: "later", reservation: "root" })
      expect(yield* db.get(sql`SELECT state FROM session_handoff_root WHERE reservation = 'next'`)).toEqual({
        state: "competing",
      })
    }),
  ))

test("reused child metadata, contradictory links, and historical call collisions fail closed without admission", async () => {
  for (const mutation of ["reused", "runtime", "collision", "partial-collision", "malformed-collision"])
    await run((db) =>
      Effect.gen(function* () {
        if (mutation === "reused")
          yield* db.run(
            sql`INSERT INTO message (id, session_id, time_created, time_updated, data) SELECT 'second-user', session_id, 4, 4, data FROM message WHERE id = 'child-user'`,
          )
        if (mutation === "runtime")
          yield* db.run(sql`UPDATE runtime_execution SET parent_call_id = 'different' WHERE session_id = 'child'`)
        if (mutation === "collision")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'duplicate-task', message_id, session_id, 4, 4, data FROM part WHERE id = 'task'`,
          )
        if (mutation === "partial-collision")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('partial', 'assistant', 'parent', 4, 4, ${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "error", metadata: { sessionId: "child" } } })})`,
          )
        if (mutation === "malformed-collision")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('malformed', 'assistant', 'parent', 4, 4, ${JSON.stringify({ type: "tool", tool: "task", callID: "call" })})`,
          )
        expect(yield* Effect.flip(admit(db))).toMatchObject({ code: "ambiguous_lineage" })
        expect(yield* db.get(sql`SELECT id FROM message WHERE id = 'msg_task_notification_child'`)).toBeUndefined()
        expect(yield* db.all(sql`SELECT * FROM session_handoff_notification`)).toEqual([])
      }),
    )
})

test("notification evidence is immutable and exact retry never reinterprets reused child metadata", () =>
  run((db) =>
    Effect.gen(function* () {
      const original = yield* admit(db)
      yield* db.run(sql`UPDATE session SET metadata = '{}' WHERE id = 'child'`)
      expect(
        yield* SessionHandoffNotification.admit({ db }, "parent", "msg_task_notification_child", {
          ...link,
          childExecution: { ...link.childExecution, fence: 2 },
        }),
      ).toEqual(original)
      expect(yield* SessionHandoffNotification.admit({ db }, "parent", "msg_task_notification_child", link)).toEqual(
        original,
      )
      expect(
        yield* Effect.flip(
          SessionHandoffNotification.admit({ db }, "parent", "msg_task_notification_child", {
            ...link,
            childUserMessageID: "other-generation",
          }),
        ),
      ).toMatchObject({ code: "notification_conflict" })
      expect(
        Exit.isFailure(
          yield* Effect.exit(db.run(sql`UPDATE session_handoff_notification SET classification = 'later'`)),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM session_handoff_notification`)))).toBe(true)
      expect(yield* db.all(sql`SELECT classification FROM session_handoff_notification`)).toEqual([
        { classification: "in_action" },
      ])
    }),
  ))

test("notification context uses the stored effective root epoch rather than notification or child selection", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "parent", directory, owner)
      if (!candidate) throw new Error("Missing candidate")
      yield* SessionHandoffEnrollment.enroll({ db }, "parent", directory, owner, { ...candidate, requestID: "enroll" })
      const key = { sessionID: "parent", queueID: "queue", userMessageID: "root-user" }
      const target = { providerID: "synthetic", modelID: "luna", variant: "high" }
      yield* SessionHandoffStore.recordRequest(
        { db },
        { ...key, requestID: "control", directory, kind: "model_control", payload: { target } },
        { state: "pending" },
      )
      yield* SessionHandoffStore.appendBoundary({ db }, key, {
        sequence: 1,
        requestID: "control",
        kind: "model_control",
        priorSelection: selection,
        selection: target,
        afterAssistantMessageID: null,
        appliedAt: 3,
      })
      const before = yield* db.get(sql`SELECT data FROM message WHERE id = 'child-user'`)
      yield* admit(db)
      expect(yield* SessionHandoffNotification.context({ db }, "parent", "msg_task_notification_child")).toMatchObject({
        ...key,
        selection: target,
        epochSequence: 1,
        controlRequestID: "control",
      })
      expect(yield* db.get(sql`SELECT data FROM message WHERE id = 'child-user'`)).toEqual(before)
      expect(yield* SessionHandoffStore.receipt({ db }, "parent", "control")).toEqual({ state: "pending" })
    }),
  ))

test("derived summary diffs do not change root authorization but other summary fields remain guarded", () =>
  run((db) =>
    Effect.gen(function* () {
      yield* admit(db)
      yield* db.run(
        sql`UPDATE message SET data = json_set(data, '$.summary', json('{"diffs":[]}')) WHERE id = 'root-user'`,
      )
      expect(yield* SessionHandoffNotification.context({ db }, "parent", "msg_task_notification_child")).toMatchObject({
        userMessageID: "root-user",
      })
      yield* db.run(sql`UPDATE message SET data = json_set(data, '$.summary.system', 'changed') WHERE id = 'root-user'`)
      expect(
        yield* Effect.flip(SessionHandoffNotification.context({ db }, "parent", "msg_task_notification_child")),
      ).toMatchObject({ code: "ambiguous_lineage" })
    }),
  ))

test("notification authorization refuses changed original user context", () =>
  run((db) =>
    Effect.gen(function* () {
      yield* admit(db)
      yield* db.run(sql`UPDATE message SET data = json_set(data, '$.system', 'changed') WHERE id = 'root-user'`)
      expect(
        yield* Effect.flip(SessionHandoffNotification.context({ db }, "parent", "msg_task_notification_child")),
      ).toMatchObject({ code: "ambiguous_lineage" })
    }),
  ))

test("an enrolled notification cannot invent parent assistant membership from parentID alone", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "parent", directory, owner)
      if (!candidate) throw new Error("Missing root")
      yield* SessionHandoffEnrollment.enroll({ db }, "parent", directory, owner, { ...candidate, requestID: "enroll" })
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) SELECT 'unproven', session_id, 3, 3, data FROM message WHERE id = 'assistant'`,
      )
      yield* db.run(
        sql`UPDATE part SET message_id = 'unproven', data = json_set(data, '$.state.metadata.parentMessageID', 'unproven') WHERE id = 'task'`,
      )
      yield* db.run(
        sql`UPDATE session SET metadata = json_set(metadata, '$.task.parentMessageID', 'unproven') WHERE id = 'child'`,
      )
      yield* db.run(sql`UPDATE runtime_execution SET parent_message_id = 'unproven' WHERE session_id = 'child'`)
      expect(yield* Effect.flip(admit(db, { ...link, parentMessageID: "unproven" }))).toMatchObject({
        code: "ambiguous_lineage",
      })
    }),
  ))

test("recovery notification requires the exact locally owned delivering child fence", () =>
  run((db) =>
    Effect.gen(function* () {
      yield* db.run(
        sql`UPDATE runtime_execution SET state = 'active', desired_active = 1, parent_notification_state = 'delivering' WHERE session_id = 'child'`,
      )
      expect(
        yield* Effect.flip(SessionHandoffNotification.verify({ db }, "parent", "msg_task_notification_child", link)),
      ).toMatchObject({ code: "ambiguous_lineage" })
      expect(
        yield* SessionHandoffNotification.verify({ db }, "parent", "msg_task_notification_child", link, owner),
      ).toMatchObject({ link })
      expect(
        yield* Effect.flip(
          SessionHandoffNotification.verify({ db }, "parent", "msg_task_notification_child", link, {
            ...owner,
            fence: 2,
          }),
        ),
      ).toMatchObject({ code: "ambiguous_lineage" })
    }),
  ))
