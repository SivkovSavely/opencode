import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { layer } from "../src/database/sqlite.bun"
import { SessionHandoffEnrollment } from "../src/session/handoff-enrollment"
import { SessionHandoffNotification } from "../src/session/handoff-notification"
import { SessionHandoffControl } from "../src/session/handoff-control"
import { SessionHandoffStore } from "../src/session/handoff-store"
import { tmpdir } from "./fixture/tmpdir"

const owner = { ownerLineage: "lineage", ownerInstance: "instance", fence: 1 }
const baseline = { providerID: "synthetic", modelID: "sol", variant: "max" }
const target = { providerID: "synthetic", modelID: "terra", variant: "xhigh" }
const key = { sessionID: "session", queueID: "queue", userMessageID: "user" }

async function run(
  body: (db: SessionHandoffStore.Connection["db"], directory: string) => Effect.Effect<void, unknown>,
  enrolled = true,
) {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', ${tmp.path}, 1, 1, '[]')`,
      )
      yield* db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'project', 'test', ${tmp.path}, 'test', '1', 1, 1)`,
      )
      yield* db.run(
        sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated) VALUES ('session', 'session', ${tmp.path}, 'lineage', 'instance', 1, 'active', 1, 1, 1)`,
      )
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "root")
      yield* db.run(
        sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('user', 'session', 1, 1, ${JSON.stringify({ role: "user", agent: "build", model: baseline, system: "root system", tools: { bash: false }, time: { created: 1 } })})`,
      )
      const payload = { kind: "prompt", parts: [] }
      yield* db.run(
        sql`INSERT INTO session_queue (id, session_id, delivery, state, position, payload, submission, message_id, time_created) VALUES ('queue', 'session', 'queue', 'delivered', 1, ${JSON.stringify(payload)}, ${JSON.stringify({ delivery: "queue", payload })}, 'user', 1)`,
      )
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "root", "queue", "user")
      const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", tmp.path, owner)
      if (!candidate) throw new Error("Missing eligible queue prompt")
      if (enrolled)
        yield* SessionHandoffEnrollment.enroll({ db }, "session", tmp.path, owner, {
          ...candidate,
          requestID: "enroll",
        })
      yield* body(db, tmp.path)
    }).pipe(Effect.provide(layer({ filename: `${tmp.path}/control.db` })), Effect.scoped),
  )
}

test("control admission is pending, exact-idempotent and commits its marker before model work", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      expect(view?.identity).toMatchObject({ ...owner, queueID: "queue", userMessageID: "user", revision: 0 })
      if (!view?.identity) throw new Error("Missing enrolled identity")
      const request = { requestID: "control", expected: view.identity, target }
      const user = yield* db.get(sql`SELECT * FROM message WHERE id = 'user'`)
      const session = yield* db.get(sql`SELECT * FROM session WHERE id = 'session'`)
      const receipt = yield* SessionHandoffControl.admit({ db }, "session", directory, request)
      expect(receipt).toMatchObject({ state: "pending", dispatch: "none", boundary: null })
      expect(yield* SessionHandoffControl.reconcileObsolete({ db }, "session", directory, request)).toEqual(receipt)
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toEqual(receipt)
      expect(yield* SessionHandoffStore.lookup({ db }, key)).toMatchObject({ boundaries: [] })
      expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")).toMatchObject({
        selection: target,
        epochSequence: 1,
        controlRequestID: "control",
      })
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "control")).toMatchObject({
        state: "applied",
        dispatch: "none",
        boundary: { sequence: 1, firstOrdinaryAssistantMessageID: null },
      })
      expect(yield* db.get(sql`SELECT * FROM message WHERE id = 'user'`)).toEqual(user)
      expect(yield* db.get(sql`SELECT * FROM session WHERE id = 'session'`)).toEqual(session)
      expect(
        yield* Effect.flip(SessionHandoffControl.admit({ db }, "session", directory, { ...request, target: baseline })),
      ).toMatchObject({ code: "request_id_conflict" })
    }),
  ))

test("obsolete reconciliation never admits a live request or fabricates a retired identity", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const request = { requestID: "not-admitted", expected: view.identity, target }
      expect(yield* SessionHandoffControl.reconcileObsolete({ db }, "session", directory, request)).toBeUndefined()
      expect(yield* SessionHandoffStore.receipt({ db }, "session", request.requestID)).toBeUndefined()
      yield* SessionHandoffEnrollment.close({ db }, "session", "terminal")
      for (const [expected, code] of [
        [{ ...view.identity, contextDigest: "forged" }, "stale_context"],
        [{ ...view.identity, ownerInstance: "forged" }, "stale_context"],
        [{ ...view.identity, fence: view.identity.fence + 1 }, "stale_fence"],
        [{ ...view.identity, queueID: "other-queue" }, "not_enrolled"],
        [{ ...view.identity, userMessageID: "other-user" }, "not_enrolled"],
      ] as const) {
        expect(
          yield* Effect.flip(
            SessionHandoffControl.reconcileObsolete({ db }, "session", directory, { ...request, expected }),
          ),
        ).toMatchObject({ code })
        expect(yield* SessionHandoffStore.receipt({ db }, "session", request.requestID)).toBeUndefined()
      }
      expect(
        yield* Effect.flip(SessionHandoffControl.reconcileObsolete({ db }, "session", directory + "/wrong", request)),
      ).toMatchObject({ code: "wrong_directory" })
      expect(
        yield* Effect.flip(SessionHandoffControl.reconcileObsolete({ db }, "other-session", directory, request)),
      ).toMatchObject({ code: "not_enrolled" })
      const receipt = yield* SessionHandoffControl.reconcileObsolete({ db }, "session", directory, request)
      expect(receipt).toMatchObject({ state: "expired", reason: "terminal_action", dispatch: "none" })
      expect(
        yield* Effect.flip(
          SessionHandoffControl.reconcileObsolete({ db }, "session", directory, { ...request, target: baseline }),
        ),
      ).toMatchObject({ code: "request_id_conflict" })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
    }),
  ))

test("terminal-first expires pending and authentic unadmitted requests, never fabricated identities", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const request = { requestID: "lost", expected: view.identity, target }
      const observed = yield* SessionHandoffNotification.boundary({ db }, "session")
      expect(yield* SessionHandoffNotification.terminalize({ db }, "session", observed)).toBe(true)
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.identity.revision).toBe(1)
      const terminal = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!terminal?.identity) throw new Error("Missing retained terminal identity")
      expect(
        yield* SessionHandoffControl.admit({ db }, "session", directory, {
          ...request,
          requestID: "terminal-view",
          expected: terminal.identity,
        }),
      ).toMatchObject({ state: "expired", reason: "terminal_action" })
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "lost")).toBeUndefined()
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toMatchObject({
        state: "expired",
        reason: "terminal_action",
        dispatch: "none",
      })
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toMatchObject({
        state: "expired",
      })
      expect(
        yield* Effect.flip(
          SessionHandoffControl.admit({ db }, "session", directory, {
            ...request,
            requestID: "fake",
            expected: { ...view.identity, contextDigest: "invented" },
          }),
        ),
      ).toMatchObject({ code: "stale_context" })
      expect(
        yield* Effect.flip(
          SessionHandoffControl.admit({ db }, "session", directory + "/wrong", { ...request, requestID: "wrong" }),
        ),
      ).toMatchObject({ code: "wrong_directory" })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
    }),
  ))

test("competing input expires a genuinely pending control before its side effects", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const request = { requestID: "pending", expected: view.identity, target }
      yield* SessionHandoffControl.admit({ db }, "session", directory, request)
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "new-input")
      yield* SessionHandoffEnrollment.preparing({ db }, "session", "new-input")
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "pending")).toMatchObject({
        state: "expired",
        reason: "invalidated",
        dispatch: "none",
      })
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toMatchObject({
        state: "expired",
      })
      expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")).toBeUndefined()
    }),
  ))

test("ordinary failed local tools continue but provider-owned and interrupted tool errors cannot apply a control", async () => {
  for (const evidence of [
    { metadata: {}, state: { metadata: {} }, continuation: true },
    { metadata: { providerExecuted: true }, state: { metadata: {} }, continuation: false },
    { metadata: {}, state: { metadata: { interrupted: true } }, continuation: false },
    { metadata: {}, state: { metadata: { interrupted: true, crashInterrupted: true } }, continuation: false },
  ]) {
    await run((db, directory) =>
      Effect.gen(function* () {
        const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
        if (!view?.identity) throw new Error("Missing identity")
        yield* SessionHandoffControl.admit({ db }, "session", directory, {
          requestID: "failed-tool",
          expected: view.identity,
          target,
        })
        yield* db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('assistant','session',2,2,${JSON.stringify({ role: "assistant", parentID: "user", providerID: baseline.providerID, modelID: baseline.modelID, variant: baseline.variant, finish: "stop", time: { created: 2, completed: 3 } })})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('tool','assistant','session',2,2,${JSON.stringify({ type: "tool", tool: "read", metadata: evidence.metadata, state: { status: "error", error: "File not found", metadata: evidence.state.metadata } })})`,
        )
        const next = yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
        if (evidence.continuation) expect(next).toMatchObject({ selection: target, epochSequence: 1 })
        if (!evidence.continuation) expect(next).toBeUndefined()
        expect(yield* SessionHandoffStore.receipt({ db }, "session", "failed-tool")).toMatchObject(
          evidence.continuation
            ? { state: "applied", boundary: { sequence: 1 }, dispatch: "none" }
            : { state: "expired", reason: "terminal_action", boundary: null, dispatch: "none" },
        )
      }),
    )
  }
})

test("terminal and error evidence wins over a pending selection at the turn boundary", async () => {
  for (const data of [
    { finish: "stop", time: { created: 2, completed: 3 } },
    { error: { name: "APIError" }, time: { created: 2, completed: 3 } },
    { structured: { done: true }, finish: "tool-calls", time: { created: 2, completed: 3 } },
  ])
    await run((db, directory) =>
      Effect.gen(function* () {
        const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
        if (!view?.identity) throw new Error("Missing identity")
        yield* SessionHandoffControl.admit({ db }, "session", directory, {
          requestID: "pending",
          expected: view.identity,
          target,
        })
        yield* db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('finished','session',2,3,${JSON.stringify({ role: "assistant", parentID: "user", providerID: "synthetic", modelID: "sol", variant: "max", ...data })})`,
        )
        expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")).toBeUndefined()
        expect(yield* SessionHandoffStore.receipt({ db }, "session", "pending")).toMatchObject({
          state: "expired",
          reason: "terminal_action",
        })
        expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
      }),
    )
})

test("recovery retires all issued identities and pending work, then exact obsolete intent is durable across reopen", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const lost = { requestID: "lost-before-fence", expected: view.identity, target }
      yield* SessionHandoffControl.admit({ db }, "session", directory, { ...lost, requestID: "pending-before-fence" })
      const pending = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!pending?.identity) throw new Error("Missing updated identity")
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const connection = { db: tx }
            yield* SessionHandoffStore.recordRequest(
              connection,
              {
                ...key,
                directory,
                requestID: "recover",
                kind: "recovery",
                payload: { requestID: "recover", expected: pending.identity, target },
              },
              { state: "pending" },
            )
            yield* tx.run(
              sql`UPDATE runtime_execution SET owner_instance = 'replacement', fence = 2 WHERE session_id = 'session'`,
            )
            yield* SessionHandoffControl.claimRecovery(
              connection,
              key,
              pending.identity,
              { ...owner, ownerInstance: "replacement", fence: 2 },
              target,
              "recover",
            )
          }),
        { behavior: "immediate" },
      )
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "pending-before-fence")).toMatchObject({
        state: "expired",
      })
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "lost-before-fence")).toBeUndefined()
      const obsolete = yield* SessionHandoffControl.reconcileObsolete({ db }, "session", directory, lost)
      if (!obsolete) throw new Error("Missing obsolete receipt")
      expect(obsolete).toMatchObject({ state: "expired", reason: "stale_fence", dispatch: "none" })
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, lost)).toEqual(obsolete)
      expect(
        yield* Effect.gen(function* () {
          const reopened = yield* EffectDrizzleSqlite.makeWithDefaults()
          return yield* SessionHandoffStore.receipt({ db: reopened }, "session", "lost-before-fence")
        }).pipe(Effect.provide(layer({ filename: `${directory}/control.db` })), Effect.scoped),
      ).toEqual(obsolete)
      expect(yield* SessionHandoffControl.execution({ db }, "session", directory)).toMatchObject({
        identity: { ownerInstance: "replacement", fence: 2 },
        recoveryRevision: 1,
        effectiveSelection: target,
        pendingRequestID: null,
      })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toHaveLength(1)
    }),
  ))

test("normalized dispatch is recorded only at the validated seam, never by applying a marker", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "control",
        expected: view.identity,
        target,
      })
      yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.assistants).toEqual([])
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('controlled','session',2,2,${JSON.stringify({ role: "assistant", parentID: "user", providerID: target.providerID, modelID: target.modelID, variant: target.variant, time: { created: 2 } })})`,
      )
      yield* SessionHandoffControl.preparedAssistant({ db }, key, "controlled", "user")
      yield* SessionHandoffControl.normalizedDispatch({ db }, key, "controlled", "user")
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.assistants).toMatchObject([
        {
          messageID: "controlled",
          authorizationUserMessageID: "user",
          parentUserMessageID: "user",
          epochSequence: 1,
          selectionEvidence: "normalized_dispatch",
          dispatch: "started_or_unknown",
        },
      ])
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "control")).toMatchObject({
        state: "applied",
        dispatch: "started_or_unknown",
        boundary: { firstOrdinaryAssistantMessageID: "controlled" },
      })
    }),
  ))

test("automatic compaction inputs have explicit same-action membership without changing persisted input policy", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "control",
        expected: view.identity,
        target,
      })
      yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
      const input = { role: "user", agent: "build", model: baseline, time: { created: 2 } }
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('compact','session',2,2,${JSON.stringify(input)})`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('compact-part','compact','session',2,2,'{"type":"compaction","auto":true}')`,
      )
      const original = yield* db.get(sql`SELECT * FROM message WHERE id = 'compact'`)
      yield* SessionHandoffControl.compaction({ db }, "session", "user", "compact", "request")
      expect(yield* SessionHandoffNotification.context({ db }, "session", "compact")).toMatchObject({
        ...key,
        selection: target,
        epochSequence: 1,
      })
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('continue','session',3,3,${JSON.stringify(input)})`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('continue-part','continue','session',3,3,'{"type":"text","synthetic":true,"text":"Continue","metadata":{"compaction_continue":true}}')`,
      )
      yield* SessionHandoffControl.compaction({ db }, "session", "compact", "continue", "continuation")
      expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "continue")).toMatchObject({
        ...key,
        selection: target,
        epochSequence: 1,
      })
      expect(yield* db.get(sql`SELECT * FROM message WHERE id = 'compact'`)).toEqual(original)
    }),
  ))

test("compaction authorization ignores only derived summary diffs, never changed input selection", () =>
  run((db) =>
    Effect.gen(function* () {
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('compact','session',2,2,${JSON.stringify({ role: "user", agent: "build", model: baseline, time: { created: 2 } })})`,
      )
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('compact-part','compact','session',2,2,'{"type":"compaction","auto":true}')`,
      )
      yield* SessionHandoffControl.compaction({ db }, "session", "user", "compact", "request")
      yield* db.run(
        sql`UPDATE message SET data = json_set(data, '$.summary', json('{"diffs":[]}')) WHERE id = 'compact'`,
      )
      expect(yield* SessionHandoffNotification.context({ db }, "session", "compact")).toMatchObject({
        ...key,
        selection: baseline,
      })
      yield* db.run(sql`UPDATE message SET data = json_set(data, '$.model.modelID', 'changed') WHERE id = 'compact'`)
      expect(yield* Effect.flip(SessionHandoffNotification.context({ db }, "session", "compact"))).toMatchObject({
        code: "ambiguous_lineage",
      })
    }),
  ))

test("enrollment retains prior automatic summary and continuation membership rather than guessing from parent IDs", () =>
  run(
    (db, directory) =>
      Effect.gen(function* () {
        const input = { role: "user", agent: "build", model: baseline, time: { created: 2 } }
        yield* db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('compact','session',2,2,${JSON.stringify(input)})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('compact-part','compact','session',2,2,'{"type":"compaction","auto":true}')`,
        )
        yield* SessionHandoffControl.compaction({ db }, "session", "user", "compact", "request")
        yield* db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('summary','session',3,3,${JSON.stringify({ role: "assistant", parentID: "compact", summary: true, providerID: "synthetic", modelID: "summary-model", variant: "low", finish: "stop", time: { created: 2, completed: 3 } })})`,
        )
        const summarySelection = { providerID: "synthetic", modelID: "summary-model", variant: "low" }
        yield* SessionHandoffControl.summary(
          { db },
          "session",
          "summary",
          "compact",
          summarySelection,
          summarySelection,
          false,
        )
        yield* db.run(
          sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('continue','session',4,4,${JSON.stringify(input)})`,
        )
        yield* db.run(
          sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('continue-part','continue','session',4,4,'{"type":"text","synthetic":true,"text":"Continue","metadata":{"compaction_continue":true}}')`,
        )
        yield* SessionHandoffControl.compaction({ db }, "session", "compact", "continue", "continuation")
        const candidate = yield* SessionHandoffEnrollment.candidate({ db }, "session", directory, owner)
        expect(candidate).not.toBeNull()
        if (!candidate) throw new Error("Missing post-compaction candidate")
        yield* SessionHandoffEnrollment.enroll({ db }, "session", directory, owner, {
          ...candidate,
          requestID: "after-compact",
        })
        const history = yield* SessionHandoffStore.lookup({ db }, key)
        expect(history?.summaries).toMatchObject([
          {
            messageID: "summary",
            parentUserMessageID: "compact",
            epochSequence: 0,
            configuredCompactionSelection: summarySelection,
            dispatchSelection: summarySelection,
            selectionEvidence: "persisted_message",
          },
        ])
        expect(history?.assistants).toEqual([])
        expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "continue")).toMatchObject({
          selection: baseline,
          enrolled: true,
        })
      }),
    false,
  ))

test("modified original parts cannot apply a control under a previously authentic context", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      yield* db.run(
        sql`INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES ('changed','user','session',2,2,'{"type":"text","text":"changed original input"}')`,
      )
      expect(
        yield* Effect.flip(
          SessionHandoffControl.admit({ db }, "session", directory, {
            requestID: "changed",
            expected: view.identity,
            target,
          }),
        ),
      ).toMatchObject({ code: "stale_context" })
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "changed")).toBeUndefined()
    }),
  ))

test("a rejected controlled dispatch retains ordinary membership without claiming normalized proof", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "control",
        expected: view.identity,
        target,
      })
      yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('rejected','session',2,2,${JSON.stringify({ role: "assistant", parentID: "user", providerID: target.providerID, modelID: target.modelID, variant: target.variant, time: { created: 2 } })})`,
      )
      yield* SessionHandoffControl.preparedAssistant({ db }, key, "rejected", "user")
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.boundaries).toMatchObject([
        { firstOrdinaryAssistantMessageID: "rejected" },
      ])
      yield* SessionHandoffControl.unsupportedDispatch({ db }, key)
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.assistants).toMatchObject([
        { messageID: "rejected", epochSequence: 1, selectionEvidence: "persisted_message", dispatch: "none" },
      ])
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "control")).toMatchObject({
        state: "expired",
        reason: "unsupported_dispatch",
        dispatch: "none",
        boundary: { firstOrdinaryAssistantMessageID: "rejected" },
      })
    }),
  ))

test("admission races terminalization on independent real database connections without late application", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const request = { requestID: "race", expected: view.identity, target }
      const observed = yield* SessionHandoffNotification.boundary({ db }, "session")
      yield* Effect.all(
        [
          SessionHandoffControl.admit({ db }, "session", directory, request),
          Effect.gen(function* () {
            const other = yield* EffectDrizzleSqlite.makeWithDefaults()
            expect(yield* SessionHandoffNotification.terminalize({ db: other }, "session", observed)).toBe(true)
          }).pipe(Effect.provide(layer({ filename: `${directory}/control.db` })), Effect.scoped),
        ],
        { concurrency: "unbounded" },
      )
      expect(yield* SessionHandoffStore.receipt({ db }, "session", "race")).toMatchObject({
        state: "expired",
        reason: "terminal_action",
        dispatch: "none",
      })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toMatchObject({
        state: "expired",
      })
    }),
  ))

test("a dispatch callback from a pre-recovery epoch cannot authorize the new fenced epoch", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const first = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!first?.identity) throw new Error("Missing identity")
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "control",
        expected: first.identity,
        target,
      })
      yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('old-attempt','session',2,2,${JSON.stringify({ role: "assistant", parentID: "user", providerID: target.providerID, modelID: target.modelID, variant: target.variant, time: { created: 2 } })})`,
      )
      yield* SessionHandoffControl.preparedAssistant({ db }, key, "old-attempt", "user")
      const before = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!before?.identity) throw new Error("Missing pre-recovery identity")
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const connection = { db: tx }
            yield* SessionHandoffStore.recordRequest(
              connection,
              {
                ...key,
                directory,
                requestID: "recover",
                kind: "recovery",
                payload: { expected: before.identity, target },
              },
              { state: "pending" },
            )
            yield* tx.run(
              sql`UPDATE runtime_execution SET owner_instance = 'replacement', fence = 2 WHERE session_id = 'session'`,
            )
            yield* SessionHandoffControl.claimRecovery(
              connection,
              key,
              before.identity,
              { ...owner, ownerInstance: "replacement", fence: 2 },
              target,
              "recover",
            )
          }),
        { behavior: "immediate" },
      )
      expect(
        yield* Effect.flip(SessionHandoffControl.normalizedDispatch({ db }, key, "old-attempt", "user")),
      ).toMatchObject({ code: "stale_context" })
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.assistants).toMatchObject([
        { messageID: "old-attempt", epochSequence: 1, selectionEvidence: "persisted_message", dispatch: "none" },
      ])
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toHaveLength(2)
    }),
  ))

test("a startup hold rejects new preparation without invalidating the enrolled root", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      yield* db.run(
        sql`INSERT INTO session_handoff_recovery_hold (root_session_id,reservation,session_id) VALUES ('session','root','session')`,
      )
      expect(yield* Effect.flip(SessionHandoffEnrollment.reserve({ db }, "session", "held-input"))).toMatchObject({
        code: "invalidated",
      })
      expect(yield* db.get(sql`SELECT 1 FROM session_handoff_root WHERE reservation = 'held-input'`)).toBeUndefined()
      expect(yield* db.get(sql`SELECT state FROM session_handoff_root WHERE reservation = 'root'`)).toEqual({
        state: "active",
      })
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.state).toBe("held")
    }),
  ))

test("already-effective requests are durable no_effect and only one different pending control may exist", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      const request = { requestID: "same", expected: view.identity, target: baseline }
      const receipt = yield* SessionHandoffControl.admit({ db }, "session", directory, request)
      expect(receipt).toMatchObject({ state: "no_effect", boundary: null, dispatch: "none" })
      expect(yield* SessionHandoffControl.admit({ db }, "session", directory, request)).toEqual(receipt)
      expect((yield* SessionHandoffControl.execution({ db }, "session", directory))?.identity).toEqual(view.identity)
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "different",
        expected: view.identity,
        target,
      })
      expect(
        yield* Effect.flip(
          SessionHandoffControl.admit({ db }, "session", directory, {
            requestID: "second",
            expected: view.identity,
            target,
          }),
        ),
      ).toMatchObject({ code: "pending_conflict" })
      expect(
        yield* Effect.flip(
          SessionHandoffControl.admit({ db }, "session", directory, {
            requestID: "enroll",
            expected: view.identity,
            target,
          }),
        ),
      ).toMatchObject({ code: "request_id_conflict" })
      expect((yield* SessionHandoffStore.lookup({ db }, key))?.boundaries).toEqual([])
    }),
  ))

test("current discovery does not fall back to an old enrolled action after a new unenrolled root", () =>
  run((db, directory) =>
    Effect.gen(function* () {
      const view = yield* SessionHandoffControl.execution({ db }, "session", directory)
      if (!view?.identity) throw new Error("Missing identity")
      yield* SessionHandoffControl.admit({ db }, "session", directory, {
        requestID: "control",
        expected: view.identity,
        target,
      })
      yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "user")
      yield* SessionHandoffEnrollment.reserve({ db }, "session", "next-root")
      yield* db.run(
        sql`INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES ('next-user','session',4,4,${JSON.stringify({ role: "user", agent: "build", model: baseline, time: { created: 4 } })})`,
      )
      const payload = { kind: "prompt", parts: [] }
      yield* db.run(
        sql`INSERT INTO session_queue (id,session_id,delivery,state,position,payload,submission,message_id,time_created) VALUES ('next-queue','session','queue','delivered',2,${JSON.stringify(payload)},${JSON.stringify({ delivery: "queue", payload })},'next-user',4)`,
      )
      yield* SessionHandoffEnrollment.delivered({ db }, "session", "next-root", "next-queue", "next-user")
      expect(yield* SessionHandoffControl.execution({ db }, "session", directory)).toBeUndefined()
      const historical = yield* SessionHandoffControl.execution({ db }, "session", directory, key)
      expect(historical).toMatchObject({
        state: "invalidated",
        effectiveSelection: target,
        isCurrent: false,
        viewKind: "historical",
      })
      expect(historical?.boundaries).toHaveLength(1)
      expect(yield* SessionHandoffControl.beforeTurn({ db }, "session", directory, "next-user")).toMatchObject({
        enrolled: false,
        selection: baseline,
      })
    }),
  ))
