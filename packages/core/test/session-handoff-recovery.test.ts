import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
import { EffectLogger } from "drizzle-orm/effect-core"
import { Effect, Schema } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffRecovery } from "../src/session/handoff-recovery"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { tmpdir } from "./fixture/tmpdir"

function run<A, E>(
  filename: string,
  body: (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => Effect.Effect<A, E>,
  logger?: Parameters<typeof EffectLogger.fromDrizzle>[0],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* logger
        ? EffectDrizzleSqlite.make().pipe(
            Effect.provide(EffectCache.Default),
            Effect.provide(EffectLogger.layerFromDrizzle(logger)),
          )
        : EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      return yield* body(db)
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
  )
}

test("held uses indexed Task lookups without loading historical transcripts on repeated misses", async () => {
  await using tmp = await tmpdir()
  const queries = new Map<string, unknown[]>()
  await run(
    `${tmp.path}/membership.db`,
    (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
          VALUES ('unrelated','project','unrelated',${tmp.path},'unrelated','1',1,1)`)
        yield* db.run(sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
          INSERT INTO message (id,session_id,time_created,time_updated,data)
          SELECT 'history-' || i, CASE WHEN i <= 2000 THEN 'root' ELSE 'unrelated' END, i, i,
            json_object('role','assistant','parentID','user','summary',hex(zeroblob(512))) FROM n`)
        yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
          SELECT id,id,session_id,time_created,time_updated,json_object('type','tool','tool','bash',
            'state',json_object('status','completed','output',char(27) || '[32m' || hex(zeroblob(2048)),
            'metadata',json_object('exit',0)))
          FROM message WHERE id LIKE 'history-%'`)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold WHERE session_id = 'child'`)
        yield* db.run(
          sql`INSERT INTO session_handoff_root VALUES ('root','later','terminal','later-queue','later-user',NULL,'later-enrollment')`,
        )
        queries.clear()
        for (let i = 0; i < 12; i++) {
          expect(yield* SessionHandoffRecovery.held({ db }, "unrelated")).toBe(false)
          expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
        }
        const plans: string[] = []
        const recursivePlans: string[] = []
        for (const [query, params] of [...queries]) {
          const recursive = /\bWITH RECURSIVE\b/.test(query)
          if (!recursive && !/\bFROM part\b/.test(query)) continue
          const statement = sql.join(
            query
              .split("?")
              .flatMap((chunk, i) => (i === 0 ? [sql.raw(chunk)] : [sql`${params[i - 1]}`, sql.raw(chunk)])),
          )
          if (!recursive)
            expect(
              yield* db.get(sql`SELECT count(*) AS count FROM (${statement}) WHERE message_id LIKE 'history-%'`),
            ).toEqual({ count: 0 })
          const target = recursive ? recursivePlans : plans
          target.push(
            ...(yield* db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${statement}`)).map((row) => row.detail),
          )
        }
        expect(plans.some((detail) => /SEARCH .*part_session_idx/.test(detail))).toBe(true)
        expect(plans.some((detail) => /\bSCAN (?:part|p)\b/.test(detail))).toBe(false)
        expect(
          recursivePlans.some((detail) => /SEARCH p USING INDEX part_session_idx \(session_id=\?\)/.test(detail)),
        ).toBe(true)
        expect(recursivePlans.some((detail) => /\bSCAN (?:part|p)\b/.test(detail))).toBe(false)
        expect([...queries.keys()].some((query) => /FROM message WHERE session_id IN/.test(query))).toBe(false)
      }),
    { logQuery: (query, params) => queries.set(query, params) },
  )
})

test("startup holds the enrolled root and ambiguous projected, runtime and metadata descendants without changing owners", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${tmp.path}, 1, 1, '[]')`,
      )
      for (const id of ["root", "projected", "runtime", "metadata", "unrelated"]) {
        yield* db.run(
          sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (${id}, 'project', ${id === "projected" ? "root" : null}, ${id}, ${tmp.path}, 'test', '1', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, parent_session_id, time_created, time_updated) VALUES (${id}, ${id}, ${tmp.path}, 'lineage', 'prior', 3, 'active', 1, ${id === "runtime" ? "root" : null}, 1, 1)`,
        )
      }
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES ('root', 'reservation', 'active', 'queue', 'user', 'enrollment')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'root', 1, 1, '{"role":"assistant"}')`,
      )
      yield* db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('task', 'assistant', 'root', 1, 1, '{"type":"tool","tool":"task","callID":"call","state":{"status":"running","metadata":{"sessionId":"metadata"}}}')`,
      )
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "current")
      for (const id of ["root", "projected", "runtime", "metadata"])
        expect(yield* SessionHandoffRecovery.held({ db }, id)).toBe(true)
      expect(yield* SessionHandoffRecovery.held({ db }, "unrelated")).toBe(false)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
      const view = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("unknown" as const))
      expect(view.descendants.map((child) => child.childSessionID).sort()).toEqual(["metadata", "projected", "runtime"])
      expect(view.descendants.every((child) => child.proof !== "verified")).toBe(true)
      yield* db.run(
        sql`UPDATE session SET permission = '[{"permission":"bash","pattern":"*","action":"deny"}]' WHERE id = 'projected'`,
      )
      expect(
        (yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("unknown" as const)))
          .descendantDigest,
      ).not.toBe(view.descendantDigest)
    }),
  )
})

const seedLinked = Effect.fnUntraced(function* (
  db: SessionHandoffRecovery.Connection["db"],
  directory: string,
  variant = "max",
) {
  const model = { providerID: "synthetic", modelID: "reviewer", variant }
  const task = {
    parentSessionId: "root",
    parentMessageID: "assistant",
    parentCallID: "call",
    messageID: "child-user",
    model,
    variant,
  }
  yield* db.run(
    sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${directory}, 1, 1, '[]')`,
  )
  for (const id of ["root", "child"]) {
    yield* db.run(
      sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, agent, metadata, permission, time_created, time_updated) VALUES (${id}, 'project', ${id === "child" ? "root" : null}, ${id}, ${directory}, 'test', '1', 'reviewer', ${JSON.stringify(id === "child" ? { task } : {})}, '[]', 1, 1)`,
    )
    yield* db.run(
      sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, parent_session_id, parent_message_id, parent_call_id, parent_mode, time_created, time_updated) VALUES (${id}, ${id}, ${directory}, 'lineage', ${`${id}-prior`}, 3, 'active', 1, ${id === "child" ? "root" : null}, ${id === "child" ? "assistant" : null}, ${id === "child" ? "call" : null}, ${id === "child" ? "foreground" : null}, 1, 1)`,
    )
  }
  yield* db.run(
    sql`INSERT INTO session_handoff_root (session_id, reservation, state, queue_id, user_message_id, enrolled_request_id) VALUES ('root', 'reservation', 'active', 'queue', 'user', 'enrollment')`,
  )
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'root', 1, 1, '{"role":"assistant","parentID":"user"}')`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('task', 'assistant', 'root', 1, 1, ${JSON.stringify({ type: "tool", tool: "task", callID: "call", state: { status: "running", input: { prompt: "review", subagent_type: "reviewer" }, metadata: { ...task, sessionId: "child" }, time: { start: 1 } } })})`,
  )
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-user', 'child', 2, 2, ${JSON.stringify({ role: "user", agent: "reviewer", model, variant, time: { created: 2 } })})`,
  )
  yield* db.run(
    sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('child-text', 'child-user', 'child', 2, 2, '{"type":"text","text":"review"}')`,
  )
  const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
  yield* SessionHandoffStore.persistAction(
    { db },
    {
      ...key,
      directory,
      baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
      createdAt: 1,
    },
  )
  yield* SessionHandoffStore.appendAssistant({ db }, key, {
    kind: "ordinary",
    messageID: "assistant",
    parentUserMessageID: "user",
    authorizationUserMessageID: "user",
    epochSequence: 0,
    controlRequestID: null,
    selection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
    selectionEvidence: "persisted_message",
    dispatch: "unknown",
  })
  yield* SessionHandoffRecovery.installStartupHolds({ db }, "current")
})

const seedReused = Effect.fnUntraced(function* (db: SessionHandoffRecovery.Connection["db"], directory: string) {
  yield* seedLinked(db, directory, "")
  yield* db.run(
    sql`UPDATE part SET data=json_set(data,'$.state.status','error','$.state.error','initial SchemaError') WHERE id='task'`,
  )
  yield* db.run(sql`INSERT INTO message VALUES ('child-result-0','child',3,3,
    '{"role":"assistant","parentID":"child-user","error":{"name":"SchemaError"},"time":{"completed":3}}')`)
  for (let i = 1; i < 10; i++) {
    const metadata = {
      parentSessionId: "root",
      parentMessageID: `assistant-${i}`,
      parentCallID: `call-${i}`,
      messageID: `child-user-${i}`,
      model: { providerID: "synthetic", modelID: "reviewer", variant: "" },
      variant: "",
      sessionId: "child",
    }
    yield* db.run(sql`INSERT INTO message VALUES
      (${`assistant-${i}`},'root',${i * 3 + 1},${i * 3 + 1},'{"role":"assistant","parentID":"user"}'),
      (${`child-user-${i}`},'child',${i * 3 + 2},${i * 3 + 2},${JSON.stringify({ role: "user", agent: "reviewer", model: metadata.model })}),
      (${`child-result-${i}`},'child',${i * 3 + 3},${i * 3 + 3},${JSON.stringify({ role: "assistant", parentID: metadata.messageID, finish: "stop", time: { completed: i * 3 + 3 } })})`)
    yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
      (${`task-${i}`},${metadata.parentMessageID},'root',${i * 3 + 1},${i * 3 + 1},${JSON.stringify({ type: "tool", tool: "task", callID: metadata.parentCallID, state: { status: "completed", input: { prompt: `review ${i}`, subagent_type: "reviewer", task_id: "child" }, metadata, output: `returned ${i}` } })}),
      (${`child-text-${i}`},${metadata.messageID},'child',${i * 3 + 2},${i * 3 + 2},${JSON.stringify({ type: "text", text: `review ${i}` })})`)
    yield* SessionHandoffStore.appendAssistant(
      { db },
      { sessionID: "root", queueID: "queue", userMessageID: "user" },
      {
        kind: "ordinary",
        messageID: metadata.parentMessageID,
        parentUserMessageID: "user",
        authorizationUserMessageID: "user",
        epochSequence: 0,
        controlRequestID: null,
        selection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
        selectionEvidence: "persisted_message",
        dispatch: "unknown",
      },
    )
  }
  yield* db.run(
    sql`UPDATE runtime_execution SET state='recovery_needed',parent_message_id='assistant-9',parent_call_id='call-9' WHERE session_id='child'`,
  )
})

for (const [name, mutation, proof] of [
  [
    "missing current membership",
    sql`DELETE FROM session_handoff_assistant WHERE message_id='assistant-9'`,
    "ambiguous_lineage",
  ],
  [
    "missing earlier membership",
    sql`DELETE FROM session_handoff_assistant WHERE message_id='assistant-1'`,
    "ambiguous_lineage",
  ],
  [
    "conflicting authorization",
    sql`UPDATE session_handoff_assistant SET data=json_set(data,'$.authorizationUserMessageID','other-user') WHERE message_id='assistant-9'`,
    "ambiguous_lineage",
  ],
  [
    "outside runtime tuple",
    sql`UPDATE runtime_execution SET parent_call_id='outside-call' WHERE session_id='child'`,
    "ambiguous_lineage",
  ],
] as const)
  test(`exact action reused-child proof rejects ${name}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/action-proof.db`, (db) =>
      Effect.gen(function* () {
        yield* seedReused(db, tmp.path)
        const dead = () => Effect.succeed("dead" as const)
        const key = { queueID: "queue", userMessageID: "user" }
        const original = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, key)
        // Disposable corruption fixture: production evidence remains immutable.
        yield* db.run(sql`DROP TRIGGER session_handoff_assistant_retain_delete`)
        yield* db.run(sql`DROP TRIGGER session_handoff_assistant_retain_update`)
        yield* db.run(mutation)
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, key)
        expect(snapshot.descendants[0]?.proof).toBe(proof)
        expect(snapshot.descendantDigest).not.toBe(original.descendantDigest)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: snapshot.descendantDigest,
              children: [],
              owner: { lineage: "lineage", instance: "current" },
            },
            dead,
            () => Effect.die("unproven membership cannot claim"),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "ambiguous_lineage" })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
      }),
    )
  })

test("exact action proof corroborates a stale returned runtime tuple without timestamp authority", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/stale-returned.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      yield* db.run(
        sql`UPDATE runtime_execution SET parent_message_id='assistant',parent_call_id='call' WHERE session_id='child'`,
      )
      yield* db.run(sql`UPDATE message SET time_created=100000 WHERE id IN ('child-user','assistant')`)
      const dead = () => Effect.succeed("dead" as const)
      const before = yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id='child'`)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        link: { parentCallID: "call-9", childUserMessageID: "child-user-9" },
        resultAssistantMessageID: "child-result-9",
        resultState: "completed",
      })
      const claim = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        () => Effect.void,
      )
      expect(claim.records.map((record) => record.sessionID)).toEqual(["root"])
      expect(yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id='child'`)).toEqual(before)
    }),
  )
})

for (const [name, mutation] of [
  ["missing latest result", sql`DELETE FROM message WHERE id='child-result-9'`],
  ["pending earlier invocation", sql`UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='task'`],
  [
    "recovery-normalized earlier error",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.handoffRecovery',json('true')) WHERE id='task'`,
  ],
] as const)
  test(`stale runtime corroboration rejects ${name}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/stale-ambiguous.db`, (db) =>
      Effect.gen(function* () {
        yield* seedReused(db, tmp.path)
        yield* db.run(
          sql`UPDATE runtime_execution SET parent_message_id='assistant',parent_call_id='call' WHERE session_id='child'`,
        )
        yield* db.run(mutation)
        const snapshot = yield* SessionHandoffRecovery.inspect(
          { db },
          "root",
          () => Effect.succeed("dead" as const),
          undefined,
          { queueID: "queue", userMessageID: "user" },
        )
        expect(snapshot.descendants[0]?.proof).toBe("ambiguous_lineage")
      }),
    )
  })

for (const mode of ["historical", "historical-pending", "missing", "conflict", "foreign-latest", "unknown-effect"] as const)
  test(`cross-action child invocation membership: ${mode}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/cross-action.db`, (db) =>
      Effect.gen(function* () {
        yield* seedReused(db, tmp.path)
        yield* db.run(sql`INSERT INTO message VALUES
          ('older-user','root',0,0,'{"role":"user","agent":"reviewer"}'),
          ('user','root',100,100,'{"role":"user","agent":"reviewer"}')`)
        // Reclassify the seeded origin as an originally unenrolled invocation.
        yield* db.run(sql`DROP TRIGGER session_handoff_assistant_retain_delete`)
        yield* db.run(
          sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES ('older-queue','root','queue','delivered',0,'{"kind":"prompt"}','{}','older-user',0)`,
        )
        if (mode === "historical" || mode === "historical-pending") {
          yield* db.run(sql`UPDATE message SET data=json_set(data,'$.parentID','older-user')
            WHERE session_id='root' AND (id='assistant' OR id LIKE 'assistant-%')`)
          yield* db.run(sql`DELETE FROM session_handoff_assistant WHERE session_id='root'
            AND (message_id='assistant' OR message_id LIKE 'assistant-%')`)
          yield* db.run(sql`UPDATE message SET data=json_set(data,'$.agent','alternate') WHERE id='child-user-1'`)
          yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.input.subagent_type','alternate') WHERE id='task-1'`)
          yield* db.run(
            sql`UPDATE runtime_execution SET parent_message_id='assistant-9',parent_call_id='call-9' WHERE session_id='child'`,
          )
          if (mode === "historical-pending") {
            yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='task-9'`)
            yield* db.run(sql`DELETE FROM message WHERE id='child-result-9'`)
            yield* db.run(sql`UPDATE runtime_execution SET state='recovery_needed' WHERE session_id='child'`)
          }
        } else {
          const assistant = mode === "foreign-latest" ? "assistant-9" : "assistant"
          yield* db.run(sql`UPDATE message SET data=json_set(data,'$.parentID','older-user') WHERE id=${assistant}`)
          if (mode !== "conflict") yield* db.run(sql`DELETE FROM session_handoff_assistant WHERE message_id=${assistant}`)
        }
        if (mode === "missing") yield* db.run(sql`DELETE FROM session_queue WHERE id='older-queue'`)
        if (mode === "unknown-effect")
          yield* db.run(
            sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('older-effect','child-result-0','child',0,0,'{"type":"tool","tool":"bash","callID":"older-effect","state":{"status":"error","error":"unknown","metadata":{"interrupted":true}}}')`,
          )
        const dead = () => Effect.succeed("dead" as const)
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
          queueID: "queue",
          userMessageID: "user",
        })
        const valid = mode === "historical" || mode === "unknown-effect"
        expect(snapshot.descendants[0]?.proof).toBe(valid ? "verified" : "ambiguous_lineage")
        if (mode === "historical") expect(snapshot.descendants[0]?.state).toBe("terminal")
        if (valid)
          expect(snapshot.descendants[0]?.link).toMatchObject({
            parentCallID: "call-9",
            childUserMessageID: "child-user-9",
          })
        if (mode === "unknown-effect")
          expect(snapshot.descendants[0]?.interruptedResources).toMatchObject([
            { partID: "older-effect", liveness: "unknown", effect: "uncertain" },
          ])
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        const pendingTask =
          mode === "historical-pending" ? yield* db.get(sql`SELECT data FROM part WHERE id='task-9'`) : undefined
        const claimed = yield* SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: [],
            owner: { lineage: "lineage", instance: "current" },
          },
          dead,
          () => Effect.void,
        ).pipe(Effect.result)
        if (mode === "historical") {
          expect(claimed._tag).toBe("Success")
          yield* db.run(
            sql`UPDATE part SET data=json_set(data,'$.state.error','changed historical error') WHERE id='task'`,
          )
          expect(
            (yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
              queueID: "queue",
              userMessageID: "user",
            })).descendantDigest,
          ).not.toBe(snapshot.descendantDigest)
          return
        }
        expect(claimed).toMatchObject({
          _tag: "Failure",
          failure: { code: mode === "unknown-effect" ? "unresolved_resource" : "ambiguous_lineage" },
        })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        if (mode === "historical-pending")
          expect(yield* db.get(sql`SELECT data FROM part WHERE id='task-9'`)).toEqual(pendingTask)
      }),
    )
  })

for (const mode of [
  "compaction",
  "notification",
  "foreign-compaction-queue",
  "foreign-compaction-user",
  "changed-compaction",
  "foreign-notification",
] as const)
  test(`retained invocation requires exact synthetic-input provenance: ${mode}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/synthetic-parent.db`, (db) =>
      Effect.gen(function* () {
        yield* seedReused(db, tmp.path)
        const input = JSON.stringify({ role: "user", agent: "reviewer", time: { created: 40 } })
        yield* db.run(sql`INSERT INTO message VALUES ('synthetic-parent','root',40,40,${input})`)
        yield* db.run(
          sql`UPDATE message SET data=json_set(data,'$.parentID','synthetic-parent') WHERE id='assistant-9'`,
        )
        // Seed the retained shape of an assistant originally parented to this synthetic input.
        yield* db.run(sql`DROP TRIGGER session_handoff_assistant_retain_update`)
        yield* db.run(
          sql`UPDATE session_handoff_assistant SET data=json_set(data,'$.parentUserMessageID','synthetic-parent') WHERE message_id='assistant-9'`,
        )
        if (mode.endsWith("notification")) {
          yield* db.run(
            sql`INSERT INTO session_handoff_notification (message_id,session_id,reservation,classification,user_message_id,data) VALUES ('synthetic-parent','root',${mode === "foreign-notification" ? "other-reservation" : "reservation"},'in_action','user','{}')`,
          )
        } else {
          yield* db.run(
            sql`INSERT INTO session_handoff_compaction (message_id,session_id,reservation,queue_id,user_message_id,parent_user_message_id,kind,epoch_sequence,data) VALUES ('synthetic-parent','root','reservation',${mode === "foreign-compaction-queue" ? "other-queue" : "queue"},${mode === "foreign-compaction-user" ? "other-user" : "user"},'user','continuation',0,${JSON.stringify({ messageData: input })})`,
          )
          if (mode === "changed-compaction")
            yield* db.run(sql`UPDATE message SET data=json_set(data,'$.agent','changed') WHERE id='synthetic-parent'`)
        }
        const snapshot = yield* SessionHandoffRecovery.inspect(
          { db },
          "root",
          () => Effect.succeed("dead" as const),
          undefined,
          { queueID: "queue", userMessageID: "user" },
        )
        expect(snapshot.descendants[0]?.proof).toBe(
          mode === "compaction" || mode === "notification" ? "verified" : "ambiguous_lineage",
        )
      }),
    )
  })

test("ten returned Task invocations select the current child result without claiming or rewriting earlier calls", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/reused.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      const dead = () => Effect.succeed("dead" as const)
      const before = yield* db.all(sql`SELECT * FROM part WHERE session_id='root' ORDER BY id`)
      const runtime = yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id='child'`)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants).toHaveLength(1)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        link: {
          parentSessionID: "root",
          parentAssistantMessageID: "assistant-9",
          parentCallID: "call-9",
          childSessionID: "child",
          childUserMessageID: "child-user-9",
          mode: "foreground",
        },
        selection: { providerID: "synthetic", modelID: "reviewer", variant: "default" },
        resultAssistantMessageID: "child-result-9",
        resultState: "completed",
        interruptedResources: [],
      })
      const claimed = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        () => Effect.void,
      )
      expect(claimed.records.map((record) => record.sessionID)).toEqual(["root"])
      expect(claimed.children).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM part WHERE session_id='root' ORDER BY id`)).toEqual(before)
      expect(yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id='child'`)).toEqual(runtime)
      yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.error','changed initial error') WHERE id='task'`)
      expect((yield* SessionHandoffRecovery.inspect({ db }, "root", dead)).descendantDigest).not.toBe(
        snapshot.descendantDigest,
      )
    }),
  )
})

for (const [name, mutation, proof] of [
  [
    "current tuple",
    sql`UPDATE runtime_execution SET parent_call_id='wrong' WHERE session_id='child'`,
    "ambiguous_lineage",
  ],
  [
    "earlier frozen caller",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.parentCallID','wrong') WHERE id='task-1'`,
    "ambiguous_lineage",
  ],
  [
    "earlier prompt",
    sql`UPDATE part SET data=json_set(data,'$.state.input.prompt','changed') WHERE id='task-1'`,
    "ambiguous_input",
  ],
  [
    "current model",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.model.modelID','wrong') WHERE id='task-9'`,
    "ambiguous_input",
  ],
  [
    "current variant",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.variant','high') WHERE id='task-9'`,
    "ambiguous_input",
  ],
  [
    "wrong task_id",
    sql`UPDATE part SET data=json_set(data,'$.state.input.task_id','another-child') WHERE id='task-9'`,
    "ambiguous_input",
  ],
  [
    "embedded model variant",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.model.variant','high') WHERE id='task-9'`,
    "ambiguous_input",
  ],
  [
    "origin identity",
    sql`UPDATE session SET metadata=json_set(metadata,'$.task.parentCallID','wrong') WHERE id='child'`,
    "ambiguous_input",
  ],
  [
    "reused input",
    sql`UPDATE part SET data=json_set(data,'$.state.metadata.messageID','child-user-8') WHERE id='task-9'`,
    "ambiguous_lineage",
  ],
  [
    "unreturned earlier call",
    sql`UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='task-1'`,
    "ambiguous_lineage",
  ],
  [
    "duplicate call",
    sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) SELECT 'duplicate',message_id,session_id,time_created,time_updated,data FROM part WHERE id='task-9'`,
    "ambiguous_lineage",
  ],
  ["unlinked user", sql`INSERT INTO message VALUES ('unlinked','child',40,40,'{"role":"user"}')`, "ambiguous_lineage"],
  ["returned call without result", sql`DELETE FROM message WHERE id='child-result-9'`, "ambiguous_input"],
  [
    "queued child work",
    sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,time_created) VALUES ('queued','child','queue','pending',1,'{}','{}',40)`,
    "ambiguous_input",
  ],
] as const) {
  test(`reused child rejects ${name} without a partial claim`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/conflict.db`, (db) =>
      Effect.gen(function* () {
        yield* seedReused(db, tmp.path)
        const dead = () => Effect.succeed("dead" as const)
        const original = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
        yield* db.run(mutation)
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
        expect(snapshot.descendantDigest).not.toBe(original.descendantDigest)
        expect(snapshot.descendants[0]?.proof).toBe(proof)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: snapshot.descendantDigest,
              children: [],
              owner: { lineage: "lineage", instance: "current" },
            },
            dead,
            () => Effect.die("invalid invocation must not transition the root"),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: proof })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
      }),
    )
  })
}

test("a returned child error is terminal evidence, not a reason to replay its invocation", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/returned-error.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      yield* db.run(
        sql`UPDATE message SET data=json_set(data,'$.error',json('{"name":"SyntheticError"}')) WHERE id='child-result-9'`,
      )
      yield* db.run(
        sql`UPDATE part SET data=json_set(data,'$.state.status','error','$.state.error','latest child error') WHERE id='task-9'`,
      )
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        resultState: "error",
        resultAssistantMessageID: "child-result-9",
      })
      const before = yield* db.all(sql`SELECT * FROM part WHERE session_id='root' ORDER BY id`)
      const claim = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        () => Effect.void,
      )
      expect(claim.records.map((record) => record.sessionID)).toEqual(["root"])
      expect(yield* db.all(sql`SELECT * FROM part WHERE session_id='root' ORDER BY id`)).toEqual(before)
    }),
  )
})

test("a genuinely pending latest reused invocation is claimed once and retains all returned calls", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/pending.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      yield* db.run(sql`DELETE FROM message WHERE id='child-result-9'`)
      yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='task-9'`)
      const before = yield* db.all(sql`SELECT * FROM part WHERE session_id='root' AND id!='task-9' ORDER BY id`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        state: "held",
        resultState: "none",
        link: { childUserMessageID: "child-user-9" },
      })
      const claimed = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.map(expectation),
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        () => Effect.void,
      )
      expect(claimed.records.map((record) => record.sessionID)).toEqual(["root", "child"])
      expect(claimed.children).toHaveLength(1)
      expect(claimed.children[0]).toMatchObject({
        link: { parentCallID: "call-9", childUserMessageID: "child-user-9" },
        priorFence: 3,
        recoveryFence: 4,
      })
      expect(yield* db.all(sql`SELECT * FROM part WHERE session_id='root' AND id!='task-9' ORDER BY id`)).toEqual(
        before,
      )
      expect(
        yield* db.get(sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id='task-9'`),
      ).toEqual({ status: "error" })
    }),
  )
})

test("external closed-unit claims cannot resolve current or historical unknown shell effects", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/unknown-unit.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message VALUES ('prior-assistant','root',0,0,'{"role":"assistant","parentID":"prior-user"}')`,
      )
      for (const [id, assistant, status, unit] of [
        ["older-shell", "prior-assistant", "error", "synthetic-older.scope"],
        ["current-shell", "assistant-9", "running", "synthetic-current.scope"],
      ]) {
        yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
        (${id},${assistant},'root',1,1,${JSON.stringify({ type: "tool", tool: "bash", callID: id, state: { status, input: { command: `systemd-run --user --scope --unit=${unit} -- true` }, error: "outcome unknown", metadata: { interrupted: true, outputPath: "synthetic-output", unit, inactive: true, closed: true, result: 0, journalRecords: 3, commandDigest: "caller-asserted-hash" } } })})`)
      }
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, () => "dead")
      expect(
        snapshot.interruptedResources.map((resource) => [resource.partID, resource.liveness, resource.effect]),
      ).toEqual([
        ["current-shell", "unknown", "uncertain"],
        ["older-shell", "unknown", "uncertain"],
      ])
      const before = yield* db.all(sql`SELECT * FROM part WHERE id IN ('older-shell','current-shell') ORDER BY id`)
      expect(
        yield* SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: [],
            owner: { lineage: "lineage", instance: "current" },
          },
          dead,
          () => Effect.die("unverified units cannot authorize recovery"),
          () => "dead",
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "unresolved_resource" })
      expect(yield* db.all(sql`SELECT * FROM part WHERE id IN ('older-shell','current-shell') ORDER BY id`)).toEqual(
        before,
      )
    }),
  )
})

test("a per-resource approval unblocks only the exact unknown shell while preserving its running part", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/approved-unit.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      const command = "systemd-run --user --scope --unit=synthetic-current.scope -- true"
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
        ('current-shell','assistant-9','root',30,30,${JSON.stringify({
          type: "tool",
          tool: "bash",
          callID: "current-shell",
          state: {
            status: "running",
            input: { command },
            metadata: { interrupted: true, outputPath: "/private/tool-output" },
          },
        })})`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      const resource = snapshot.interruptedResources.find((item) => item.partID === "current-shell")
      expect(resource).toMatchObject({
        liveness: "unknown",
        effect: "uncertain",
        resourceRef: "/private/tool-output",
      })
      const before = yield* db.get(sql`SELECT data FROM part WHERE id='current-shell'`)
      const reconciliations = [
        {
          requestID: "approved-request",
          recoveryRevision: 0,
          descendantDigest: snapshot.descendantDigest,
          sessionID: "root",
          assistantMessageID: "assistant-9",
          partID: "current-shell",
          resourceRef: "/private/tool-output",
          callID: "current-shell",
          tool: "bash",
          commandSHA256: createHash("sha256").update(command).digest("hex"),
          unit: "synthetic-current.scope",
          invocationID: "invocation",
          host: "host",
          bootID: "boot",
          unitStarted: true,
          unitClosed: true,
          workConfinedToUnit: true,
          residualWrapperReadOnlyGit: true,
          historicalSourceUnproven: true,
          pidDeathUnproven: true,
          evidenceSHA256: ["a".repeat(64)],
        },
      ] as const
      const mismatchedReference = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
          requestID: "approved-request",
          recoveryRevision: 0,
          legacyResourceReconciliations: reconciliations.map((item) => ({
            ...item,
            resourceRef: "/private/another-output",
          })),
        },
        dead,
        () => Effect.die("a resource approval cannot change its output reference"),
      ).pipe(Effect.flip)
      expect(mismatchedReference).toMatchObject({ code: "unresolved_resource" })
      const missingReference = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
          requestID: "approved-request",
          recoveryRevision: 0,
          legacyResourceReconciliations: reconciliations.map((item) => ({ ...item, resourceRef: undefined })),
        },
        dead,
        () => Effect.die("a non-null resource reference cannot be omitted"),
      ).pipe(Effect.flip)
      expect(missingReference).toMatchObject({ code: "unresolved_resource" })
      const claimed = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: [],
          owner: { lineage: "lineage", instance: "current" },
          requestID: "approved-request",
          recoveryRevision: 0,
          legacyResourceReconciliations: reconciliations,
        },
        dead,
        () => Effect.void,
      )
      expect(claimed.records.map((record) => record.sessionID)).toEqual(["root"])
      expect(yield* db.get(sql`SELECT data FROM part WHERE id='current-shell'`)).toEqual(before)
      const retargeted = yield* SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: [],
            owner: { lineage: "lineage", instance: "current" },
            requestID: "different-request",
            recoveryRevision: 0,
            legacyResourceReconciliations: reconciliations,
          },
          dead,
          () => Effect.die("an approval cannot be retargeted"),
        ).pipe(Effect.result)
      expect(retargeted._tag).toBe("Failure")
    }),
  )
})

test("a returned invocation with an unknown child effect stays blocked instead of becoming replayable", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/returned-unknown.db`, (db) =>
    Effect.gen(function* () {
      yield* seedReused(db, tmp.path)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES
      ('child-shell','child-result-9','child',30,30,'{"type":"tool","tool":"bash","callID":"child-shell","state":{"status":"error","error":"interrupted","metadata":{"interrupted":true}}}')`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        resultState: "uncertain",
        interruptedResources: [{ partID: "child-shell", liveness: "unknown", effect: "uncertain" }],
      })
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      expect(
        yield* SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: [],
            owner: { lineage: "lineage", instance: "current" },
          },
          dead,
          () => Effect.die("unknown effect must block recovery"),
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "unresolved_resource" })
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("current recovery does not adopt a terminal ambiguous Task from the prior root input", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/prior-input.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
          ('prior-user','root',0,0,'{"role":"user"}'),
          ('user','root',1,1,'{"role":"user"}'),
          ('prior-assistant','root',0,0,'{"role":"assistant","parentID":"prior-user"}')`,
      )
      const task = {
        parentSessionId: "root",
        parentMessageID: "prior-assistant",
        parentCallID: "prior-call",
        messageID: "prior-child-user",
        model: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
        variant: "max",
      }
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,agent,metadata,permission,time_created,time_updated)
        VALUES ('prior-child','project','root','prior-child',${tmp.path},'prior','1','reviewer',${JSON.stringify({ task })},'[]',0,0)`)
      yield* db.run(sql`INSERT INTO runtime_execution
        (id,session_id,directory,owner_lineage,owner_instance,fence,state,desired_active,parent_session_id,parent_message_id,parent_call_id,parent_mode,time_created,time_updated)
        VALUES ('prior-child','prior-child',${tmp.path},'lineage','prior-child-owner',3,'completed',0,'root','prior-assistant','prior-call','foreground',0,0)`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-task','prior-assistant','root',0,0,${JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "prior-call",
          state: {
            status: "completed",
            input: { prompt: "prior work", subagent_type: "reviewer" },
            metadata: { ...task, sessionId: "prior-child" },
          },
        })})`)
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('prior-child-user','prior-child',0,0,${JSON.stringify({
          role: "user",
          agent: "reviewer",
          model: { providerID: "synthetic", modelID: "different-model", variant: "max" },
          variant: "max",
        })})`)
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('prior-child-result','prior-child',1,1,'{"role":"assistant","parentID":"prior-child-user","finish":"stop","time":{"completed":1}}')`)
      yield* SessionHandoffStore.persistAction(
        { db },
        {
          sessionID: "root",
          queueID: "queue",
          userMessageID: "user",
          directory: tmp.path,
          baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
          createdAt: 1,
        },
      )
      const dead: (id: string) => Effect.Effect<SessionHandoffRecovery.Liveness> = () => Effect.succeed("dead")
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(snapshot.descendants.map((child) => [child.childSessionID, child.proof, child.state])).toContainEqual([
        "prior-child",
        "ambiguous_lineage",
        "terminal",
      ])
      const recover = (view: typeof snapshot, probe: typeof dead = dead) =>
        SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: view.descendantDigest,
            children: view.descendants.filter((child) => child.state !== "terminal").map(expectation),
            owner: { lineage: "lineage", instance: "current" },
          },
          probe,
          () => Effect.void,
        )
      for (const state of ["live", "unknown"] as const) {
        const probe = (id: string): Effect.Effect<SessionHandoffRecovery.Liveness> =>
          Effect.succeed(id === "prior-child" ? state : "dead")
        const uncertain = yield* SessionHandoffRecovery.inspect({ db }, "root", probe, undefined, {
          queueID: "queue",
          userMessageID: "user",
        })
        expect(yield* recover(uncertain, probe).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      }
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('prior-child-assistant','prior-child',2,2,'{"role":"assistant","parentID":"prior-child-user"}')`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-running-bash','prior-child-assistant','prior-child',2,2,
          '{"type":"tool","tool":"bash","callID":"prior-bash","state":{"status":"running","metadata":{"shell":"bash","outputPath":"private"}}}')`)
      const withUnknownResource = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(yield* recover(withUnknownResource).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      yield* db.run(sql`DELETE FROM part WHERE id='prior-running-bash'`)
      yield* db.run(sql`DELETE FROM message WHERE id='prior-child-assistant'`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-root-bash','prior-assistant','root',0,0,
          '{"type":"tool","tool":"bash","callID":"prior-root-bash","state":{"status":"running","metadata":{"shell":"bash","outputPath":"private"}}}')`)
      const withPriorRootResource = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(withPriorRootResource.interruptedResources).toContainEqual(
        expect.objectContaining({ partID: "prior-root-bash", liveness: "unknown", effect: "uncertain" }),
      )
      expect(yield* recover(withPriorRootResource).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      yield* db.run(sql`DELETE FROM part WHERE id='prior-root-bash'`)
      yield* db.run(sql`UPDATE message SET data='{"role":"assistant","summary":true}' WHERE id='prior-assistant'`)
      const compacted = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(yield* recover(compacted).pipe(Effect.flip)).toMatchObject({
        _tag: "SessionHandoffRecoveryError",
        code: "ambiguous_lineage",
      })
      yield* db.run(
        sql`UPDATE message SET data='{"role":"assistant","parentID":"prior-user"}' WHERE id='prior-assistant'`,
      )
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-notification','assistant','root',2,2,
          '{"type":"tool","tool":"question","state":{"metadata":{"sessionId":"prior-child"}}}')`)
      const notificationLink = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(yield* recover(notificationLink).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      yield* db.run(sql`DELETE FROM part WHERE id='prior-notification'`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('conflicting-prior-link','assistant','root',2,2,${JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "conflicting-call",
          state: { status: "completed", metadata: { sessionId: "prior-child" } },
        })})`)
      const conflict = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(yield* recover(conflict).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      yield* db.run(sql`DELETE FROM part WHERE id='conflicting-prior-link'`)
      const current = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: "queue",
        userMessageID: "user",
      })
      expect(yield* recover(current).pipe(Effect.flip)).toMatchObject({ code: "ambiguous_lineage" })
      expect(
        yield* db.get(sql`SELECT fence,owner_instance FROM runtime_execution WHERE session_id='prior-child'`),
      ).toEqual({
        fence: 3,
        owner_instance: "prior-child-owner",
      })
    }),
  )
})

test("a uniquely proven returned Task from a delivered prior root input remains historical terminal evidence", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/historical-terminal.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
        ('prior-user','root',0,0,'{"role":"user","agent":"reviewer"}'),
        ('prior-assistant','root',1,1,'{"role":"assistant","parentID":"prior-user"}'),
        ('user','root',10,10,'{"role":"user","agent":"reviewer"}')`)
      yield* db.run(sql`INSERT INTO session_queue
        (id,session_id,delivery,state,position,payload,submission,message_id,time_created)
        VALUES ('prior-queue','root','queue','delivered',0,'{"kind":"prompt"}','{}','prior-user',0)`)
      const task = {
        parentSessionId: "root",
        parentMessageID: "prior-assistant",
        parentCallID: "prior-call",
        messageID: "prior-child-user",
        model: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
        variant: "max",
      }
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,agent,metadata,permission,time_created,time_updated)
        VALUES ('prior-child','project','root','prior-child',${tmp.path},'prior','1','reviewer',${JSON.stringify({ task })},'[]',0,0)`)
      yield* db.run(sql`INSERT INTO runtime_execution
        (id,session_id,directory,owner_lineage,owner_instance,fence,state,desired_active,parent_session_id,parent_message_id,parent_call_id,parent_mode,time_created,time_updated)
        VALUES ('prior-child','prior-child',${tmp.path},'lineage','prior-child-owner',3,'completed',0,'root','prior-assistant','prior-call','foreground',0,0)`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-task','prior-assistant','root',1,1,${JSON.stringify({
          type: "tool",
          tool: "task",
          callID: "prior-call",
          state: {
            status: "completed",
            input: { prompt: "prior work", subagent_type: "reviewer", task_id: "prior-child" },
            metadata: { ...task, sessionId: "prior-child" },
          },
        })})`)
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
        ('prior-child-user','prior-child',0,0,${JSON.stringify({
          role: "user",
          agent: "reviewer",
          model: task.model,
          variant: "max",
        })}),
        ('prior-child-result','prior-child',1,1,'{"role":"assistant","parentID":"prior-child-user","finish":"stop","time":{"completed":1}}')`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('prior-child-text','prior-child-user','prior-child',0,0,'{"type":"text","text":"prior work"}')`)
      const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
      yield* SessionHandoffStore.persistAction(
        { db },
        {
          ...key,
          directory: tmp.path,
          baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
          createdAt: 1,
        },
      )
      const dead = () => Effect.succeed("dead" as const)
      yield* db.run(sql`DELETE FROM session_queue WHERE id='prior-queue'`)
      const missingDelivery = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: key.queueID,
        userMessageID: key.userMessageID,
      })
      expect(missingDelivery.descendants.find((child) => child.childSessionID === "prior-child")?.proof).toBe(
        "ambiguous_lineage",
      )
      yield* db.run(sql`INSERT INTO session_queue
        (id,session_id,delivery,state,position,payload,submission,message_id,time_created)
        VALUES ('prior-queue','root','queue','delivered',0,'{"kind":"prompt"}','{}','prior-user',0)`)
      yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.status','running') WHERE id='prior-task'`)
      yield* db.run(sql`UPDATE runtime_execution SET state='recovery_needed',desired_active=1 WHERE session_id='prior-child'`)
      yield* db.run(sql`DELETE FROM message WHERE id='prior-child-result'`)
      const pending = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: key.queueID,
        userMessageID: key.userMessageID,
      })
      expect(pending.descendants.find((child) => child.childSessionID === "prior-child")).toMatchObject({
        proof: "ambiguous_lineage",
        ownerLiveness: "dead",
      })
      const beforePendingClaim = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      expect(
        yield* SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: pending.descendantDigest,
            children: pending.descendants
              .filter((child) => child.proof === "verified" && child.state !== "terminal")
              .map(expectation),
            owner: { lineage: "lineage", instance: "current" },
          },
          dead,
          () => Effect.void,
        ).pipe(Effect.flip),
      ).toMatchObject({ code: "ambiguous_lineage" })
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(beforePendingClaim)
      yield* db.run(sql`UPDATE part SET data=json_set(data,'$.state.status','completed') WHERE id='prior-task'`)
      yield* db.run(sql`UPDATE runtime_execution SET state='completed',desired_active=0 WHERE session_id='prior-child'`)
      yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data)
        VALUES ('prior-child-result','prior-child',1,1,'{"role":"assistant","parentID":"prior-child-user","finish":"stop","time":{"completed":1}}')`)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead, undefined, {
        queueID: key.queueID,
        userMessageID: key.userMessageID,
      })
      const historical = snapshot.descendants.find((child) => child.childSessionID === "prior-child")
      expect(historical).toMatchObject({
        proof: "verified",
        state: "terminal",
        link: {
          parentAssistantMessageID: "prior-assistant",
          parentCallID: "prior-call",
          childUserMessageID: "prior-child-user",
        },
        resultAssistantMessageID: "prior-child-result",
        resultState: "completed",
      })
      const before = yield* db.get(sql`SELECT fence,owner_instance FROM runtime_execution WHERE session_id='prior-child'`)
      const claim = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.filter((child) => child.state !== "terminal").map(expectation),
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        () => Effect.void,
      )
      expect(claim.records.map((record) => record.sessionID)).not.toContain("prior-child")
      expect(yield* db.get(sql`SELECT fence,owner_instance FROM runtime_execution WHERE session_id='prior-child'`)).toEqual(
        before,
      )
    }),
  )
})

test("recovery inspection bounds candidate-part visits on a large closure", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/inspection-visits.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      const childCount = 64
      const partCount = 512
      yield* db.run(sql`WITH RECURSIVE n(i) AS (
        VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < ${childCount}
      ) INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated)
        SELECT 'bulk-child-' || i,'project','root','bulk-child-' || i,${tmp.path},'bulk','1',i,i FROM n`)
      yield* db.run(sql`WITH RECURSIVE n(i) AS (
        VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < ${partCount}
      ) INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        SELECT 'bulk-part-' || i,'assistant','root',${40}+i,${40}+i,
          '{"type":"tool","tool":"read","state":{"status":"completed"}}' FROM n`)
      const chainCount = 32
      for (let i = 1; i <= chainCount; i++) {
        const childSessionID = `chain-child-${i}`
        const parentSessionID = i === 1 ? "root" : `chain-child-${i - 1}`
        const parentAssistantMessageID = i === 1 ? "assistant" : `chain-assistant-${i - 1}`
        const parentCallID = `chain-call-${i}`
        const childUserMessageID = `chain-user-${i}`
        const childAssistantMessageID = `chain-assistant-${i}`
        yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated)
          VALUES (${childSessionID},'project',${parentSessionID},${childSessionID},${tmp.path},'chain','1',${i},${i})`)
        yield* db.run(sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES
          (${childUserMessageID},${childSessionID},${100 + i},${100 + i},'{"role":"user"}'),
          (${childAssistantMessageID},${childSessionID},${10_000 - i},${10_000 - i},${JSON.stringify({
            role: "assistant",
            parentID: childUserMessageID,
          })})`)
        yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
          VALUES (${`chain-task-${i}`},${parentAssistantMessageID},${parentSessionID},${500 + i},${500 + i},${JSON.stringify({
            type: "tool",
            tool: "task",
            callID: parentCallID,
            state: {
              status: "completed",
              metadata: {
                sessionId: childSessionID,
                messageID: childUserMessageID,
                parentSessionId: parentSessionID,
                parentMessageID: parentAssistantMessageID,
                parentCallID,
                background: false,
              },
            },
          })})`)
      }
      const metrics = {
        candidatePartVisits: 0,
        lineageMessageVisits: 0,
        messageDecodeVisits: 0,
        partDecodeVisits: 0,
      }
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("dead" as const), undefined, {
        queueID: "queue",
        userMessageID: "user",
      }, metrics)
      expect(snapshot.descendants.filter((child) => child.childSessionID.startsWith("bulk-child-")).length).toBe(childCount)
      expect(metrics.messageDecodeVisits).toBe(2 + chainCount * 2)
      expect(metrics.partDecodeVisits).toBe(partCount + chainCount + 2)
      expect(metrics.candidatePartVisits).toBeLessThanOrEqual(chainCount + 1)
      expect(metrics.lineageMessageVisits).toBeLessThanOrEqual(metrics.messageDecodeVisits * 2)
    }),
  )
})

test("held keeps a snapshot when a concurrent commit replaces a Task link with a direct hold", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/membership.db`
  let commit: (() => void) | undefined
  await run(
    filename,
    (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold WHERE session_id = 'child'`)
        yield* db.run(sql`UPDATE session SET parent_id = NULL, metadata = NULL WHERE id = 'child'`)
        yield* db.run(sql`UPDATE runtime_execution SET parent_session_id = NULL WHERE session_id = 'child'`)
        using writer = new Database(filename, { create: false })
        commit = writer.transaction(() => {
          writer.run("INSERT INTO session_handoff_recovery_hold VALUES ('root','reservation','child')")
          writer.run("DELETE FROM part WHERE id = 'task'")
        })
        // The child is held in both committed states, for different reasons.
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
        expect(commit).toBeUndefined()
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      }),
    {
      logQuery(query) {
        // Run the writer after the direct lookup misses but before reading the held roots.
        if (query !== "SELECT DISTINCT root_session_id, reservation FROM session_handoff_recovery_hold") return
        commit?.()
        commit = undefined
      },
    },
  )
})

test("held sees new descendants and current links and holds, without a startup rescan", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/membership.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
      yield* db.run(sql`INSERT INTO session_handoff_recovery_hold VALUES ('root','reservation','root')`)
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(true)
      for (const id of ["projected", "runtime", "metadata", "part-only", "bad-metadata"])
        yield* db.run(sql`INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated)
          VALUES (${id}, 'project', ${id}, ${tmp.path}, 'test', '1', 1, 1)`)
      expect(yield* SessionHandoffRecovery.held({ db }, "metadata")).toBe(false)
      yield* db.run(sql`UPDATE session SET parent_id = 'child' WHERE id = 'projected'`)
      yield* db.run(sql`UPDATE session SET metadata = '{"task":{"parentSessionId":"projected"}}' WHERE id = 'metadata'`)
      yield* db.run(sql`UPDATE session SET metadata = '{"task":{"parentSessionId":"root"}' WHERE id = 'bad-metadata'`)
      yield* db.run(sql`INSERT INTO runtime_execution
        (id,session_id,directory,owner_lineage,owner_instance,fence,state,desired_active,parent_session_id,time_created,time_updated)
        VALUES ('runtime','runtime',${tmp.path},'lineage','prior',2,'completed',0,'metadata',1,1)`)
      yield* db.run(sql`INSERT INTO message VALUES ('late-task','runtime',1,1,'{"role":"assistant"}')`)
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('late-task','late-task','runtime',1,1,${String.raw`{"type":"tool","tool":"task","state":{"metadata":{"\u0073essionId":"part-only"}}}`})`)
      for (const id of ["child", "projected", "runtime", "metadata", "part-only"])
        expect(yield* SessionHandoffRecovery.held({ db }, id)).toBe(true)
      expect(yield* SessionHandoffRecovery.held({ db }, "bad-metadata")).toBe(false)
      yield* db.run(
        sql`UPDATE part SET data = '{"type":"tool","tool":"task","state":{"metadata":"broken"}}' WHERE id = 'late-task'`,
      )
      expect(yield* SessionHandoffRecovery.held({ db }, "part-only")).toBe(false)
      yield* db.run(sql`UPDATE session SET parent_id = NULL WHERE id = 'projected'`)
      expect(yield* SessionHandoffRecovery.held({ db }, "runtime")).toBe(false)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(false)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
    }),
  )
})

test("held excludes only proven other-generation links and rechecks message and part changes", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/membership.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold WHERE session_id = 'child'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_root VALUES ('root','later','terminal','later-queue','later-user',NULL,'later-enrollment')`,
      )
      yield* db.run(
        sql`UPDATE message SET data = '{"role":"assistant","parentID":"later-user"}' WHERE id = 'assistant'`,
      )
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
      yield* db.run(sql`INSERT INTO message VALUES ('conflicting','root',3,3,'{"role":"assistant","parentID":"user"}')`)
      // A non-Task part is still contradictory evidence for exclusion, even
      // though it cannot establish reachability on its own.
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('conflicting','conflicting','root',3,3,${String.raw`{"type":"tool","tool":"other","state":{"metadata":{"session\u0049d":"elsewhere","session\u0049d":"child"}}}`})`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      yield* db.run(sql`UPDATE part SET data = json_set(data, '$.tool', 'task') WHERE id = 'conflicting'`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      yield* db.run(sql`DELETE FROM part WHERE id = 'conflicting'`)
      yield* db.run(sql`UPDATE runtime_execution SET parent_message_id = NULL WHERE session_id = 'child'`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      yield* db.run(sql`UPDATE runtime_execution SET parent_message_id = 'assistant' WHERE session_id = 'child'`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
      yield* db.run(
        sql`UPDATE message SET data = '{"role":"assistant","parentID":["later-user"]}' WHERE id = 'assistant'`,
      )
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      yield* db.run(
        sql`UPDATE message SET data = '{"role":"assistant","parentID":"later-user"}' WHERE id = 'assistant'`,
      )
      yield* db.run(sql`INSERT INTO session_handoff_recovery_hold VALUES ('root','later','root')`)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
    }),
  )
})

test("recovery scopes descendants through ambiguous duplicate Task metadata keys", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/membership.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated)
        VALUES ('[]','project',NULL,'ambiguous',${tmp.path},'test','1',1,1),
               ('leaf','project','[]','leaf',${tmp.path},'test','1',1,1)`)
      // SQLite reads the first key (an array extracted as SQL text), while
      // JSON.parse reads the last key. Both can reach the ambiguous session.
      yield* db.run(sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
        VALUES ('ambiguous','assistant','root',3,3,'{"type":"tool","tool":"task","state":{"metadata":{"sessionId":[],"sessionId":"[]"}}}')`)
      expect(yield* SessionHandoffRecovery.held({ db }, "leaf")).toBe(true)
      const evidence = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("unknown" as const))
      expect(evidence.descendants.map((child) => child.childSessionID)).toContain("leaf")
      expect(yield* SessionHandoffRecovery.installStartupHolds({ db }, "current")).toContain("leaf")
    }),
  )
})

test("verified model-only descendant retains schema-valid evidence without changing its input", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/empty-variant.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path, "")
      // V1 persists the sentinel inside model, not as a top-level user variant.
      yield* db.run(sql`UPDATE message SET data=json_remove(data,'$.variant') WHERE id='child-user'`)
      const original = yield* db.get(sql`SELECT * FROM message WHERE id='child-user'`)
      const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
      yield* SessionHandoffStore.persistAction(
        { db },
        {
          ...key,
          directory: tmp.path,
          baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
          createdAt: 1,
        },
      )
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      Schema.decodeUnknownSync(SessionHandoffRecovery.Evidence)(snapshot)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        selection: { providerID: "synthetic", modelID: "reviewer", variant: "default" },
      })
      yield* SessionHandoffRecovery.retain({ db }, key, snapshot)
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(snapshot)
      yield* SessionHandoffRecovery.captureCurrent({ db }, "child", dead)
      expect(yield* db.get(sql`SELECT * FROM message WHERE id='child-user'`)).toEqual(original)
    }),
  )
})

for (const [name, mutation] of [
  ["call variant", sql`UPDATE part SET data=json_set(data,'$.state.metadata.variant','default') WHERE id='task'`],
  ["session variant", sql`UPDATE session SET metadata=json_set(metadata,'$.task.variant','default') WHERE id='child'`],
  ["call model", sql`UPDATE part SET data=json_set(data,'$.state.metadata.model.modelID','other') WHERE id='task'`],
  [
    "session model",
    sql`UPDATE session SET metadata=json_set(metadata,'$.task.model.providerID','other') WHERE id='child'`,
  ],
  [
    "persisted variant",
    sql`UPDATE message SET data=json_set(data,'$.model.variant','high','$.variant','high') WHERE id='child-user'`,
  ],
  ["prompt text", sql`UPDATE part SET data=json_set(data,'$.text','changed') WHERE id='child-text'`],
] as const) {
  test(`model-only descendant rejects changed ${name}`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/mismatch.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path, "")
        const dead = () => Effect.succeed("dead" as const)
        const original = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
        yield* db.run(mutation)
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
        expect(snapshot.descendants[0]?.proof).toBe("ambiguous_input")
        expect(snapshot.descendantDigest).not.toBe(original.descendantDigest)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: snapshot.descendantDigest,
              children: snapshot.descendants.map(expectation),
              owner: { lineage: "lineage", instance: "current" },
            },
            dead,
            () => Effect.die("ambiguous input must not transition the root"),
          ).pipe(Effect.flip),
        ).toMatchObject({ code: "ambiguous_input" })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
      }),
    )
  })
}

function expectation(child: SessionHandoffRecovery.TaskDescendant): SessionHandoffRecovery.ChildExpectation {
  if (
    !child.link ||
    !child.inputDigest ||
    !child.ownerLineage ||
    !child.ownerInstance ||
    child.fence === null ||
    child.recoveryRevision === null
  )
    throw new Error("Missing verified child identity")
  return {
    link: child.link,
    inputDigest: child.inputDigest,
    ownerLineage: child.ownerLineage,
    ownerInstance: child.ownerInstance,
    fence: child.fence,
    recoveryRevision: child.recoveryRevision,
  }
}

for (const blocked of [
  "root-live",
  "root-unknown",
  "child-live",
  "child-unknown",
  "closure",
  "permissions",
  "history",
  "missing-child",
  "extra-child",
  "resource",
  "orphan-task",
  "rollback",
] as const) {
  test(`guarded claim rejects ${blocked} without partial runtime claims or root transition`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path, "")
        if (blocked === "orphan-task")
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('orphan', 'assistant', 'root', 3, 3, '{"type":"tool","tool":"task","callID":"orphan","state":{"status":"running"}}')`,
          )
        if (blocked === "resource") {
          yield* db.run(
            sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-assistant', 'child', 3, 3, '{"role":"assistant","parentID":"child-user","time":{"created":3}}')`,
          )
          yield* db.run(
            sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('process', 'child-assistant', 'child', 3, 3, '{"type":"tool","tool":"bash","callID":"process","state":{"status":"running","metadata":{"outputPath":"/tmp/output-is-not-death-proof"}}}')`,
          )
        }
        const liveness = (id: string) =>
          Effect.succeed(
            blocked === `${id}-live`
              ? ("live" as const)
              : blocked === `${id}-unknown`
                ? ("unknown" as const)
                : ("dead" as const),
          )
        const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", liveness)
        expect(snapshot.descendants[0]?.proof).toBe("verified")
        const children = snapshot.descendants.map(expectation)
        if (blocked === "closure")
          yield* db.run(
            sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('racing', 'project', 'root', 'racing', ${tmp.path}, 'test', '1', 3, 3)`,
          )
        if (blocked === "permissions")
          yield* db.run(
            sql`UPDATE session SET permission = '[{"permission":"bash","action":"deny","pattern":"*"}]' WHERE id = 'child'`,
          )
        if (blocked === "history")
          yield* db.run(sql`UPDATE part SET data = '{"type":"text","text":"changed"}' WHERE id = 'child-text'`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        const result = yield* Effect.flip(
          SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: snapshot.descendantDigest,
              children:
                blocked === "missing-child" ? [] : blocked === "extra-child" ? [...children, ...children] : children,
              owner: { lineage: "lineage", instance: "current" },
            },
            liveness,
            (tx) =>
              Effect.gen(function* () {
                yield* tx.db.run(sql`UPDATE session_handoff_root SET source = 'transitioned' WHERE session_id = 'root'`)
                if (blocked === "rollback")
                  return yield* new SessionHandoffRecovery.RecoveryError({ code: "stale_fence" })
              }),
          ),
        )
        expect(result).toMatchObject({
          code: blocked.endsWith("live")
            ? "owner_live"
            : blocked.endsWith("unknown")
              ? "owner_unknown"
              : blocked === "resource"
                ? "unresolved_resource"
                : blocked === "orphan-task"
                  ? "ambiguous_lineage"
                  : blocked === "rollback"
                    ? "stale_fence"
                    : "stale_context",
        })
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        expect(yield* db.get(sql`SELECT source FROM session_handoff_root WHERE session_id = 'root'`)).toEqual({
          source: null,
        })
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_child`)).toEqual([])
      }),
    )
  })
}

test("same-input provider-inflight child and root are fenced atomically; parent Task stays interrupted after real child result", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('older-assistant', 'child', 2, 2, '{"role":"assistant","parentID":"child-user","finish":"stop","time":{"created":2,"completed":2}}')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('child-assistant', 'child', 3, 3, '{"role":"assistant","parentID":"child-user","time":{"created":3}}')`,
      )
      const beforeInput = yield* db.get(sql`SELECT * FROM message WHERE id = 'child-user'`)
      const beforeParts = yield* db.all(sql`SELECT * FROM part WHERE session_id = 'child'`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(snapshot.descendants[0]).toMatchObject({
        proof: "verified",
        selection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
        interruptedResources: [],
        resultAssistantMessageID: null,
        resultState: "none",
      })
      const claimed = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.map(expectation),
          owner: { lineage: "lineage", instance: "current" },
        },
        dead,
        (tx) => tx.db.run(sql`UPDATE session_handoff_root SET source = 'transitioned' WHERE session_id = 'root'`),
      )
      expect(claimed.records.map((record) => [record.sessionID, record.fence, record.ownerInstance])).toEqual([
        ["root", 4, "current"],
        ["child", 4, "current"],
      ])
      expect(claimed.children).toMatchObject([
        { link: { childUserMessageID: "child-user" }, priorFence: 3, recoveryFence: 4, state: "claimed" },
      ])
      const interrupted = yield* db.get<{ data: string }>(sql`SELECT data FROM part WHERE id = 'task'`)
      expect(JSON.parse(interrupted?.data ?? "null")).toMatchObject({
        state: { status: "error", metadata: { interrupted: true, handoffRecovery: true } },
      })
      yield* db.run(
        sql`UPDATE message SET data = '{"role":"assistant","parentID":"child-user","finish":"stop","time":{"created":3,"completed":4}}' WHERE id = 'child-assistant'`,
      )
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      const result = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(result.descendants[0]).toMatchObject({
        proof: "verified",
        state: "terminal",
        resultAssistantMessageID: "child-assistant",
        resultState: "completed",
      })
      expect(yield* db.get(sql`SELECT data FROM part WHERE id = 'task'`)).toEqual(interrupted)
      expect(yield* db.get(sql`SELECT * FROM message WHERE id = 'child-user'`)).toEqual(beforeInput)
      expect(yield* db.all(sql`SELECT * FROM part WHERE session_id = 'child'`)).toEqual(beforeParts)
    }),
  )
})

test("independent SQLite connections racing one observed tree can commit only one whole-tree recovery", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/recovery.db`
  const dead = () => Effect.succeed("dead" as const)
  const snapshot = await run(filename, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      return yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
    }),
  )
  const attempts = await Promise.all(
    ["recovery-A", "recovery-B"].map((instance) =>
      run(filename, (db) =>
        SessionHandoffRecovery.claim(
          { db },
          {
            sessionID: "root",
            expectedDescendantDigest: snapshot.descendantDigest,
            children: snapshot.descendants.map(expectation),
            owner: { lineage: "lineage", instance },
          },
          dead,
          (tx) =>
            tx.db.run(
              sql`UPDATE session_handoff_root SET state = 'active', source = ${instance} WHERE session_id = 'root'`,
            ),
        ).pipe(Effect.result),
      ),
    ),
  )
  expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1)
  expect(attempts.filter((attempt) => attempt._tag === "Failure")).toMatchObject([
    { failure: { code: "stale_context" } },
  ])
  await run(filename, (db) =>
    Effect.gen(function* () {
      const rows = yield* db.all<{ owner_instance: string; fence: number }>(
        sql`SELECT owner_instance, fence FROM runtime_execution ORDER BY session_id`,
      )
      expect(rows).toHaveLength(2)
      expect(rows[0]?.fence).toBe(4)
      expect(rows[1]).toEqual(rows[0])
      expect(yield* db.get(sql`SELECT source FROM session_handoff_root WHERE session_id = 'root'`)).toEqual({
        source: rows[0]?.owner_instance,
      })
      expect(yield* db.all(sql`SELECT recovery_revision FROM session_handoff_recovery_child`)).toEqual([
        { recovery_revision: 1 },
      ])
    }),
  )
})

test("terminal reconciliation records evidence but cannot release unowned startup protection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const dead = () => Effect.succeed("dead" as const)
      const active = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(
        yield* Effect.flip(
          SessionHandoffRecovery.reconcileTerminal(
            { db },
            {
              sessionID: "root",
              queueID: "queue",
              userMessageID: "user",
              expectedDescendantDigest: active.descendantDigest,
            },
            dead,
            () => Effect.void,
          ),
        ),
      ).toMatchObject({ code: "unresolved_resource" })
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(true)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      const terminal = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.reconcileTerminal(
        { db },
        {
          sessionID: "root",
          queueID: "queue",
          userMessageID: "user",
          expectedDescendantDigest: terminal.descendantDigest,
        },
        dead,
        () => Effect.succeed("expired-receipt"),
      )
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(true)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("startup protects terminal enrolled background descendants without reconstructing their input", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE runtime_execution SET parent_mode = 'background' WHERE session_id = 'child'`)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted")
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("startup does not install admission holds on a proven-live enrolled owner or child", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      const protectedIDs = yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () =>
        Effect.succeed("live" as const),
      )
      expect(protectedIDs).toEqual(["child", "root"])
      expect(yield* SessionHandoffRecovery.held({ db }, "root")).toBe(false)
      expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(false)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("terminal-root guarded recovery claims only existing children and preserves the terminal root forever", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      const dead = () => Effect.succeed("dead" as const)
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      const root = yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id = 'root'`)
      const result = yield* SessionHandoffRecovery.claim(
        { db },
        {
          sessionID: "root",
          expectedDescendantDigest: snapshot.descendantDigest,
          children: snapshot.descendants.map(expectation),
          owner: { lineage: "lineage", instance: "restarted" },
        },
        dead,
        () => Effect.succeed("expired-root-receipt"),
      )
      expect(result.root).toBe("expired-root-receipt")
      expect(result.records.map((record) => record.sessionID)).toEqual(["child"])
      expect(result.children).toMatchObject([{ state: "claimed", priorFence: 3, recoveryFence: 4 }])
      expect(yield* db.get(sql`SELECT * FROM runtime_execution WHERE session_id = 'root'`)).toEqual(root)
      expect(
        yield* db.get(sql`SELECT json_extract(data,'$.state.status') AS status FROM part WHERE id = 'task'`),
      ).toEqual({ status: "error" })
    }),
  )
})

for (const state of ["competing", "invalidated"]) {
  test(`startup holds an enrolled ${state} generation with an active Task child`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        yield* db.run(sql`UPDATE session_handoff_root SET state = ${state}`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", () => Effect.succeed("dead" as const)),
        ).toEqual(["child", "root"])
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(true)
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () => Effect.succeed("live" as const)),
        ).toEqual(["child", "root"])
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      }),
    )
  })
}

for (const notification of [null, "pending", "delivering", "delivered"]) {
  test(`startup distinguishes terminal completed background children with ${notification} delivery state`, async () => {
    await using tmp = await tmpdir()
    await run(`${tmp.path}/recovery.db`, (db) =>
      Effect.gen(function* () {
        yield* seedLinked(db, tmp.path)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        yield* db.run(sql`UPDATE runtime_execution SET state = 'completed'`)
        yield* db.run(
          sql`UPDATE runtime_execution SET parent_mode = 'background', parent_notification_state = ${notification} WHERE session_id = 'child'`,
        )
        yield* db.run(sql`UPDATE part SET data = json_set(data,'$.state.status','completed') WHERE id = 'task'`)
        const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", () => Effect.succeed("dead" as const)),
        ).toEqual(notification === "delivered" ? [] : ["child", "root"])
        expect(yield* SessionHandoffRecovery.held({ db }, "child")).toBe(notification !== "delivered")
        expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
        yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
        expect(
          yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", () => Effect.succeed("live" as const)),
        ).toEqual(notification === "delivered" ? [] : ["child", "root"])
        expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      }),
    )
  })
}

test("startup scopes closed generation holds to its Task links and terminal reconciliation preserves all generation protection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'root'`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'competing'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES ('root','later','terminal','later-queue','later-user','later-enrollment')`,
      )
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('later-user','root',4,4,'{"role":"user"}')`,
      )
      const dead = () => Effect.succeed("dead" as const)
      yield* SessionHandoffRecovery.installStartupHolds({ db }, "restarted", dead)
      expect(
        yield* db.all(sql`SELECT DISTINCT reservation FROM session_handoff_recovery_hold ORDER BY reservation`),
      ).toEqual([{ reservation: "reservation" }])
      const unresolved = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      expect(
        yield* Effect.flip(
          SessionHandoffRecovery.claim(
            { db },
            {
              sessionID: "root",
              expectedDescendantDigest: unresolved.descendantDigest,
              children: unresolved.descendants.map(expectation),
              owner: { lineage: "lineage", instance: "restarted" },
            },
            dead,
            () => Effect.void,
          ),
        ),
      ).toMatchObject({ code: "stale_context" })
      yield* db.run(sql`UPDATE runtime_execution SET state = 'completed' WHERE session_id = 'child'`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'terminal' WHERE reservation = 'reservation'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_recovery_hold (root_session_id,reservation,session_id) VALUES ('root','later','root')`,
      )
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", dead)
      yield* SessionHandoffRecovery.reconcileTerminal(
        { db },
        {
          sessionID: "root",
          queueID: "queue",
          userMessageID: "user",
          expectedDescendantDigest: snapshot.descendantDigest,
        },
        dead,
        () => Effect.void,
      )
      expect(yield* db.all(sql`SELECT reservation,session_id FROM session_handoff_recovery_hold`)).toEqual([
        { reservation: "reservation", session_id: "child" },
        { reservation: "reservation", session_id: "root" },
        { reservation: "later", session_id: "root" },
      ])
    }),
  )
})

test("a live child from an older generation prevents disruptive holds on their shared root", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/recovery.db`, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path)
      yield* db.run(sql`DELETE FROM session_handoff_recovery_hold`)
      yield* db.run(sql`UPDATE session_handoff_root SET state = 'competing'`)
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id,enrolled_request_id) VALUES ('root','later','active','later-queue','later-user','later-enrollment')`,
      )
      const before = yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)
      expect(
        yield* SessionHandoffRecovery.installStartupHolds({ db }, "second", (id) =>
          Effect.succeed(id === "child" ? ("live" as const) : ("dead" as const)),
        ),
      ).toEqual(["child", "root"])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_recovery_hold`)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM runtime_execution ORDER BY session_id`)).toEqual(before)
    }),
  )
})

test("retained action closure survives reopened SQLite and later reused child metadata without live inference", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/history.db`
  const key = { sessionID: "root", queueID: "queue", userMessageID: "user" }
  const saved = await run(filename, (db) =>
    Effect.gen(function* () {
      yield* seedLinked(db, tmp.path, "")
      yield* SessionHandoffStore.persistAction(
        { db },
        {
          ...key,
          directory: tmp.path,
          baselineSelection: { providerID: "synthetic", modelID: "reviewer", variant: "max" },
          createdAt: 1,
        },
      )
      const snapshot = yield* SessionHandoffRecovery.inspect({ db }, "root", () => Effect.succeed("dead" as const))
      yield* SessionHandoffRecovery.captureCurrent({ db }, "child", () => Effect.succeed("dead" as const))
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(snapshot)
      yield* SessionHandoffRecovery.retain({ db }, key, snapshot)
      expect(yield* db.all(sql`SELECT revision FROM session_handoff_recovery_history`)).toEqual([{ revision: 0 }])
      return snapshot
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      yield* db.run(sql`UPDATE session SET metadata='{}',agent='different',permission='[]' WHERE id='child'`)
      yield* db.run(
        sql`UPDATE runtime_execution SET fence=fence+10,parent_call_id='later-call' WHERE session_id='child'`,
      )
      yield* db.run(sql`UPDATE part SET data='{"type":"text","text":"later content"}' WHERE id='child-text'`)
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(saved)
      expect(yield* SessionHandoffRecovery.retained({ db }, { ...key, userMessageID: "other" })).toBeUndefined()
      expect(yield* SessionHandoffRecovery.retained({ db }, { ...key, queueID: "other" })).toBeUndefined()
      yield* db.run(
        sql`INSERT INTO session_handoff_root (session_id,reservation,state,queue_id,user_message_id) VALUES ('root','next','active','future-queue','future-user')`,
      )
      yield* SessionHandoffRecovery.captureCurrent({ db }, "child", () => Effect.succeed("dead" as const))
      expect(yield* SessionHandoffRecovery.retained({ db }, key)).toEqual(saved)
      expect(yield* SessionHandoffRecovery.retain({ db }, key, saved).pipe(Effect.flip)).toMatchObject({
        code: "stale_context",
      })
      for (const query of [
        sql`DELETE FROM session_handoff_recovery_history`,
        sql`UPDATE session_handoff_recovery_history SET data='{}'`,
        sql`INSERT OR REPLACE INTO session_handoff_recovery_history SELECT * FROM session_handoff_recovery_history`,
      ])
        expect(yield* db.run(query).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )
})
