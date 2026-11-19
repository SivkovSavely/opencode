import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit, References } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import handoffMigration from "../src/database/migration/20261115200737_session_handoff_store"
import handoffRetention from "../src/database/migration/20261115200739_session_handoff_retention"
import handoffReceiptMigration from "../src/database/migration/20261115203645_session_handoff_receipt"
import handoffReceiptRetention from "../src/database/migration/20261115203647_session_handoff_receipt_retention"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { tmpdir } from "./fixture/tmpdir"

const key = { sessionID: "session-A", queueID: "queue-A", userMessageID: "user-A" }
const baseline = { providerID: "synthetic", modelID: "sol", variant: "max" }
const target = { providerID: "synthetic", modelID: "terra", variant: "xhigh" }
const action = { ...key, directory: "/isolated/project", baselineSelection: baseline, createdAt: 1 }
const request = {
  ...key,
  requestID: "globally-unique",
  kind: "model_control" as const,
  directory: action.directory,
  payload: { expected: { fence: 1, revision: 0 }, target },
}
const boundary = {
  sequence: 1,
  requestID: request.requestID,
  kind: "model_control" as const,
  priorSelection: baseline,
  selection: target,
  afterAssistantMessageID: null,
  appliedAt: 2,
}
const ordinary = {
  kind: "ordinary" as const,
  messageID: "assistant-A",
  parentUserMessageID: "user-A",
  authorizationUserMessageID: "user-A",
  epochSequence: 1,
  controlRequestID: request.requestID,
  selection: target,
  selectionEvidence: "normalized_dispatch" as const,
  dispatch: "prepared" as const,
}

// Every phase acquires a new SQLite connection, including the restart reads.
function run<A, E>(
  filename: string,
  body: (db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>) => Effect.Effect<A, E, SqlClient>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return yield* body(db)
    }).pipe(Effect.provide(layer({ filename })), Effect.scoped),
  )
}

test("explicit action persistence does not infer actions or claim an execution", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      expect(yield* SessionHandoffStore.lookup({ db }, key)).toBeUndefined()
      yield* SessionHandoffStore.persistAction({ db }, action)
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.action).toEqual(action)
      expect(yield* db.all(sql`SELECT * FROM runtime_execution`)).toEqual([])
      expect(yield* SessionHandoffStore.lookup({ db }, { ...key, userMessageID: "other" })).toBeUndefined()
      expect(yield* SessionHandoffStore.lookup({ db }, { ...key, sessionID: "other" })).toBeUndefined()
    }),
  )
})

test("global request IDs compare complete canonical identity before returning retained receipts", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  await run(filename, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      expect(yield* SessionHandoffStore.recordRequest({ db }, request, { state: "pending", createdAt: 2 })).toEqual({
        state: "pending",
        createdAt: 2,
      })
      expect(
        yield* SessionHandoffStore.recordRequest(
          { db },
          {
            ...request,
            payload: {
              target: { variant: "xhigh", modelID: "terra", providerID: "synthetic" },
              expected: { revision: 0, fence: 1 },
            },
          },
          { state: "different candidate receipt" },
        ),
      ).toEqual({ state: "pending", createdAt: 2 })
      for (const changed of [
        { ...request, kind: "recovery" as const },
        { ...request, sessionID: "elsewhere" },
        { ...request, queueID: "elsewhere" },
        { ...request, userMessageID: "elsewhere" },
        { ...request, directory: "/elsewhere" },
        { ...request, payload: { ...request.payload, extra: null } },
        { ...request, payload: { ...request.payload, target: baseline } },
      ]) {
        const error = yield* Effect.flip(SessionHandoffStore.recordRequest({ db }, changed, {}))
        expect(error).toMatchObject({ code: "request_id_conflict" })
      }
      expect(yield* SessionHandoffStore.receipt({ db }, "elsewhere", request.requestID)).toBeUndefined()
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      expect(yield* SessionHandoffStore.recordRequest({ db }, request, {})).toEqual({ state: "pending", createdAt: 2 })
      expect(yield* SessionHandoffStore.receipt({ db }, key.sessionID, request.requestID)).toEqual({
        state: "pending",
        createdAt: 2,
      })
    }),
  )
})

test("append-only receipt CAS survives restart and exact admission retries return the current receipt", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  for (const state of ["applied", "expired", "no_effect"]) {
    const identity = { ...request, requestID: `receipt-${state}` }
    const pending = { state: "pending", createdAt: 2 }
    const final = { state, createdAt: 2, updatedAt: 3 }
    await run(filename, (db) =>
      Effect.gen(function* () {
        yield* SessionHandoffStore.persistAction({ db }, action)
        yield* SessionHandoffStore.recordRequest({ db }, identity, pending)
        expect(yield* SessionHandoffStore.appendReceipt({ db }, identity, pending, final)).toEqual(final)
        expect(yield* SessionHandoffStore.appendReceipt({ db }, identity, pending, final)).toEqual(final)
        expect(
          yield* Effect.flip(SessionHandoffStore.appendReceipt({ db }, identity, pending, { state: "lost" })),
        ).toMatchObject({ code: "immutable_conflict" })
        expect(
          yield* Effect.flip(SessionHandoffStore.appendReceipt({ db }, { ...identity, kind: "recovery" }, final, {})),
        ).toMatchObject({ code: "request_id_conflict" })
        expect(
          yield* db.all(sql`SELECT data FROM session_handoff_request WHERE request_id = ${identity.requestID}`),
        ).toEqual([{ data: '{"createdAt":2,"state":"pending"}' }])
        expect(
          yield* db.all(sql`SELECT revision FROM session_handoff_receipt WHERE request_id = ${identity.requestID}`),
        ).toEqual([{ revision: 1 }])
        for (const statement of [
          sql`UPDATE session_handoff_receipt SET data = '{}' WHERE request_id = ${identity.requestID}`,
          sql`DELETE FROM session_handoff_receipt WHERE request_id = ${identity.requestID}`,
          sql`INSERT OR REPLACE INTO session_handoff_receipt SELECT * FROM session_handoff_receipt WHERE request_id = ${identity.requestID}`,
          sql`INSERT INTO session_handoff_receipt VALUES (${identity.requestID}, 3, '{}')`,
        ])
          expect(Exit.isFailure(yield* Effect.exit(db.run(statement)))).toBe(true)
      }),
    )
    await run(filename, (db) =>
      Effect.gen(function* () {
        expect(yield* SessionHandoffStore.receipt({ db }, identity.sessionID, identity.requestID)).toEqual(final)
        expect(yield* SessionHandoffStore.recordRequest({ db }, identity, pending)).toEqual(final)
      }),
    )
    const process = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        "test/fixture/handoff-store-read.ts",
        filename,
        key.sessionID,
        key.queueID,
        key.userMessageID,
        identity.requestID,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await process.exited).toBe(0)
    expect(await new Response(process.stderr).text()).toBe("")
    expect(await new Response(process.stdout).json()).toEqual(final)
  }
})

test("competing receipt CAS operations on independent connections preserve a single durable winner", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  const pending = { state: "pending" }
  await run(filename, (db) => SessionHandoffStore.persistAction({ db }, action))
  for (const conflict of [false, true]) {
    const identity = { ...request, requestID: `receipt-race-${conflict}` }
    await run(filename, (db) => SessionHandoffStore.recordRequest({ db }, identity, pending))
    const ready = Promise.withResolvers<void>()
    const entered: number[] = []
    const results = await Promise.all(
      [0, 1].map((index) =>
        run(filename, (db) =>
          Effect.gen(function* () {
            entered.push(index)
            if (entered.length === 2) ready.resolve()
            yield* Effect.promise(() => ready.promise)
            return yield* Effect.result(
              SessionHandoffStore.appendReceipt({ db }, identity, pending, {
                state: conflict && index === 1 ? "expired" : "applied",
              }),
            )
          }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 32)),
        ),
      ),
    )
    const successes = results.filter((x) => x._tag === "Success").map((x) => x.success)
    const failures = results.filter((x) => x._tag === "Failure").map((x) => x.failure)
    expect(failures).toEqual(conflict ? [expect.objectContaining({ code: "immutable_conflict" })] : [])
    expect(successes).toHaveLength(conflict ? 1 : 2)
    await run(filename, (db) =>
      Effect.gen(function* () {
        expect(yield* SessionHandoffStore.recordRequest({ db }, identity, pending)).toEqual(successes[0])
        expect(
          yield* db.all(sql`SELECT revision FROM session_handoff_receipt WHERE request_id = ${identity.requestID}`),
        ).toEqual([{ revision: 1 }])
      }),
    )
  }
})

test("receipt revisions roll back with enclosing boundary transactions and preserve earlier revisions", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  const pending = { state: "pending", dispatch: "none" }
  const prepared = { state: "applied", dispatch: "prepared" }
  const completed = { state: "applied", dispatch: "completed" }
  await run(filename, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.recordRequest({ db }, request, pending)
      const rollback = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* SessionHandoffStore.appendBoundary({ db: tx }, key, boundary)
              yield* SessionHandoffStore.appendReceipt({ db: tx }, request, pending, prepared)
              return yield* Effect.fail("rollback")
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.flip)
      expect(rollback).toBe("rollback")
      expect(yield* SessionHandoffStore.receipt({ db }, request.sessionID, request.requestID)).toEqual(pending)
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_receipt`)).toEqual([])
      yield* SessionHandoffStore.appendReceipt({ db }, request, pending, prepared)
      yield* SessionHandoffStore.appendReceipt({ db }, request, prepared, completed)
      expect(yield* db.all(sql`SELECT revision, data FROM session_handoff_receipt ORDER BY revision`)).toEqual([
        { revision: 1, data: '{"dispatch":"prepared","state":"applied"}' },
        { revision: 2, data: '{"dispatch":"completed","state":"applied"}' },
      ])
      expect(
        yield* Effect.flip(SessionHandoffStore.appendReceipt({ db }, { ...request, requestID: "missing" }, {}, {})),
      ).toMatchObject({ code: "not_found" })
    }),
  )
  await run(filename, (db) =>
    SessionHandoffStore.receipt({ db }, key.sessionID, request.requestID).pipe(
      Effect.tap((value) => Effect.sync(() => expect(value).toEqual(completed))),
    ),
  )
})

test("independent SQLite connections converge on exact request retries and reject global conflicts", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  await run(filename, (db) => SessionHandoffStore.persistAction({ db }, action))
  for (const conflict of [false, true]) {
    const ready = Promise.withResolvers<void>()
    const entered: number[] = []
    const identity = { ...request, requestID: `race-${conflict}` }
    const results = await Promise.all(
      [0, 1].map((index) =>
        run(filename, (db) =>
          Effect.gen(function* () {
            entered.push(index)
            if (entered.length === 2) ready.resolve()
            yield* Effect.promise(() => ready.promise)
            return yield* Effect.result(
              SessionHandoffStore.recordRequest(
                { db },
                conflict && index === 1
                  ? { ...identity, payload: { ...identity.payload, target: baseline } }
                  : identity,
                { state: "pending", winner: index },
              ),
            )
          }).pipe(Effect.provideService(References.MaxOpsBeforeYield, 32)),
        ),
      ),
    )
    const successes = results.filter((x) => x._tag === "Success").map((x) => x.success)
    const failures = results.filter((x) => x._tag === "Failure").map((x) => x.failure)
    expect(failures).toEqual(conflict ? [expect.objectContaining({ code: "request_id_conflict" })] : [])
    expect(successes).toHaveLength(conflict ? 1 : 2)
    if (!conflict) expect(successes[0]).toEqual(successes[1])
    await run(filename, (db) =>
      Effect.gen(function* () {
        expect(
          yield* db.all(sql`SELECT request_id FROM session_handoff_request WHERE request_id = ${identity.requestID}`),
        ).toHaveLength(1)
      }),
    )
  }
})

test("immutable marker survives without an assistant; exact A history survives R, B and restart", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/store.db`
  await run(filename, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.appendAssistant({ db }, key, {
        ...ordinary,
        messageID: "baseline",
        epochSequence: 0,
        controlRequestID: null,
        selection: baseline,
        selectionEvidence: "persisted_message",
      })
      yield* SessionHandoffStore.recordRequest({ db }, request, { state: "pending" })
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([
        { ...boundary, firstOrdinaryAssistantMessageID: null },
      ])
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      expect(
        (yield* SessionHandoffStore.lookup({ db }, key))?.boundaries[0]?.firstOrdinaryAssistantMessageID,
      ).toBeNull()
      yield* SessionHandoffStore.appendAssistant({ db }, key, {
        kind: "summary",
        messageID: "summary",
        parentUserMessageID: "compaction-user",
        epochSequence: 1,
        configuredCompactionSelection: null,
        dispatchSelection: target,
        selectionEvidence: "normalized_dispatch",
        dispatch: "prepared",
      })
      yield* SessionHandoffStore.appendAssistant({ db }, key, ordinary)
      yield* SessionHandoffStore.appendAssistant({ db }, key, { ...ordinary, messageID: "second" })
      yield* SessionHandoffStore.persistAction({ db }, { ...action, queueID: "report", userMessageID: "report-user" })
      yield* SessionHandoffStore.persistAction({ db }, { ...action, queueID: "fresh", userMessageID: "fresh-user" })
    }),
  )
  await run(filename, (db) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffStore.lookup({ db }, key)
      expect(view?.action.baselineSelection).toEqual(baseline)
      expect(view?.boundaries).toEqual([{ ...boundary, firstOrdinaryAssistantMessageID: "assistant-A" }])
      expect(view?.assistants.map((x) => x.messageID)).toEqual(["baseline", "assistant-A", "second"])
      expect(view?.summaries.map((x) => x.messageID)).toEqual(["summary"])
      expect(
        (yield* SessionHandoffStore.lookup({ db }, { ...key, queueID: "report", userMessageID: "report-user" }))
          ?.boundaries,
      ).toEqual([])
      expect(yield* SessionHandoffStore.lookup({ db }, { ...key, queueID: "fresh" })).toBeUndefined()
      expect(yield* db.get(sql`SELECT data FROM session_handoff_boundary WHERE sequence = 1`)).toEqual({
        data: JSON.stringify(boundary),
      })
    }),
  )
  const reader = Bun.spawn(
    ["bun", "test/fixture/handoff-store-read.ts", filename, key.sessionID, key.queueID, key.userMessageID],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output: unknown = await new Response(reader.stdout).json()
  const diagnostics = await new Response(reader.stderr).text()
  expect(await reader.exited).toBe(0)
  expect(diagnostics).toBe("")
  expect(output).toMatchObject({
    action,
    boundaries: [{ ...boundary, firstOrdinaryAssistantMessageID: "assistant-A" }],
    assistants: [{ messageID: "baseline" }, { messageID: "assistant-A" }, { messageID: "second" }],
    summaries: [{ messageID: "summary" }],
  })
})

test("storage rejects rewriting, deletion, forged epochs and cross-action evidence atomically", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      expect(
        yield* Effect.flip(SessionHandoffStore.persistAction({ db }, { ...action, baselineSelection: target })),
      ).toMatchObject({ code: "immutable_conflict" })
      yield* SessionHandoffStore.recordRequest({ db }, request, {})
      expect(
        yield* Effect.flip(SessionHandoffStore.appendBoundary({ db }, key, { ...boundary, sequence: 2 })),
      ).toMatchObject({ code: "invalid_provenance" })
      expect(yield* Effect.flip(SessionHandoffStore.appendAssistant({ db }, key, ordinary))).toMatchObject({
        code: "invalid_provenance",
      })
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      yield* SessionHandoffStore.appendAssistant({ db }, key, ordinary)
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      yield* SessionHandoffStore.appendAssistant({ db }, key, ordinary)
      expect(
        yield* Effect.flip(SessionHandoffStore.appendBoundary({ db }, key, { ...boundary, appliedAt: 9 })),
      ).toMatchObject({ code: "immutable_conflict" })
      expect(
        yield* Effect.flip(SessionHandoffStore.appendAssistant({ db }, key, { ...ordinary, selection: baseline })),
      ).toMatchObject({ code: "immutable_conflict" })
      expect(
        yield* Effect.flip(
          SessionHandoffStore.appendAssistant({ db }, key, {
            ...ordinary,
            messageID: "forged",
            authorizationUserMessageID: "other",
          }),
        ),
      ).toMatchObject({ code: "invalid_provenance" })
      yield* SessionHandoffStore.persistAction({ db }, { ...action, queueID: "other", userMessageID: "other" })
      expect(
        yield* Effect.flip(
          SessionHandoffStore.appendBoundary({ db }, { ...key, queueID: "other", userMessageID: "other" }, boundary),
        ),
      ).toMatchObject({ code: "invalid_provenance" })
      for (const table of [
        "session_handoff_action",
        "session_handoff_request",
        "session_handoff_boundary",
        "session_handoff_assistant",
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(db.run(sql.raw(`UPDATE ${table} SET data = '{}'`))))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(db.run(sql.raw(`DELETE FROM ${table}`))))).toBe(true)
      }
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.assistants).toHaveLength(1)
    }),
  )
})

test("missing retained epoch proof fails closed instead of returning a baseline history", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.recordRequest({ db }, request, {})
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      yield* SessionHandoffStore.appendAssistant({ db }, key, ordinary)
      // Simulate damaged storage, not a supported removal operation.
      yield* db.run("DROP TRIGGER session_handoff_boundary_retain_delete")
      yield* db.run("DELETE FROM session_handoff_boundary")
      expect(yield* Effect.flip(SessionHandoffStore.lookup({ db }, key))).toMatchObject({ code: "history_unavailable" })
    }),
  )
})

test("an enclosing lifecycle transaction can roll back action, receipt and marker together", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* SessionHandoffStore.persistAction({ db: tx }, action)
            yield* SessionHandoffStore.recordRequest({ db: tx }, request, {})
            yield* SessionHandoffStore.appendBoundary({ db: tx }, key, boundary)
            return yield* Effect.fail("lifecycle guard rejected")
          }),
        ),
      )
      expect(yield* SessionHandoffStore.lookup({ db }, key)).toBeUndefined()
      expect(yield* SessionHandoffStore.receipt({ db }, key.sessionID, request.requestID)).toBeUndefined()
      expect(yield* db.all(sql`SELECT * FROM session_handoff_boundary`)).toEqual([])
    }),
  )
})

test("incremental migration preserves existing data and never enrolls historical sessions", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("CREATE TABLE session (id text PRIMARY KEY)")
      yield* db.run("INSERT INTO session VALUES ('historical-unenrolled')")
      yield* DatabaseMigration.applyOnly(db, [handoffMigration, handoffRetention])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toEqual([])
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.recordRequest({ db }, request, { state: "pending" })
      yield* DatabaseMigration.applyOnly(db, [handoffReceiptMigration, handoffReceiptRetention])
      yield* DatabaseMigration.applyOnly(db, [
        handoffMigration,
        handoffRetention,
        handoffReceiptMigration,
        handoffReceiptRetention,
      ])
      expect(yield* db.all(sql`SELECT * FROM session`)).toEqual([{ id: "historical-unenrolled" }])
      expect(yield* db.all(sql`SELECT * FROM session_handoff_action`)).toHaveLength(1)
      expect(yield* SessionHandoffStore.receipt({ db }, key.sessionID, request.requestID)).toEqual({ state: "pending" })
      yield* SessionHandoffStore.appendReceipt({ db }, request, { state: "pending" }, { state: "expired" })
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM session_handoff_receipt`)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM session_handoff_action`)))).toBe(true)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  )
})

test("controlled provenance cannot claim unvalidated or unknown dispatch selection", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.recordRequest({ db }, request, {})
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      expect(
        yield* Effect.flip(
          SessionHandoffStore.appendAssistant({ db }, key, {
            ...ordinary,
            selectionEvidence: "persisted_message",
          }),
        ),
      ).toMatchObject({ code: "invalid_provenance" })
      expect(
        yield* Effect.flip(
          SessionHandoffStore.appendAssistant({ db }, key, {
            kind: "summary",
            messageID: "unproved-summary",
            parentUserMessageID: "compaction",
            epochSequence: 1,
            configuredCompactionSelection: null,
            dispatchSelection: null,
            selectionEvidence: "normalized_dispatch",
            dispatch: "prepared",
          }),
        ),
      ).toMatchObject({ code: "invalid_provenance" })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.assistants).toEqual([])
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.summaries).toEqual([])
    }),
  )
})

test("SQLite REPLACE cannot bypass immutable evidence or reorder assistant membership", async () => {
  await using tmp = await tmpdir()
  await run(`${tmp.path}/store.db`, (db) =>
    Effect.gen(function* () {
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.persistAction({ db }, action)
      yield* SessionHandoffStore.recordRequest({ db }, request, {})
      yield* SessionHandoffStore.appendBoundary({ db }, key, boundary)
      yield* SessionHandoffStore.appendAssistant({ db }, key, ordinary)
      for (const statement of [
        "INSERT OR REPLACE INTO session_handoff_action SELECT session_id, queue_id, user_message_id, '{}' FROM session_handoff_action",
        "INSERT OR REPLACE INTO session_handoff_request SELECT request_id, session_id, queue_id, user_message_id, identity, '{}' FROM session_handoff_request",
        "INSERT OR REPLACE INTO session_handoff_boundary SELECT session_id, queue_id, user_message_id, sequence, request_id, '{}' FROM session_handoff_boundary",
        "INSERT OR REPLACE INTO session_handoff_assistant (message_id, session_id, queue_id, user_message_id, data) SELECT message_id, session_id, queue_id, user_message_id, data FROM session_handoff_assistant",
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(db.run(statement)))).toBe(true)
      }
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries[0]?.firstOrdinaryAssistantMessageID).toBe(
        "assistant-A",
      )
    }),
  )
})
