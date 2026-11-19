import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionHandoffEnrollment } from "@opencode-ai/core/session/handoff-enrollment"
import { SessionHandoffControl } from "@opencode-ai/core/session/handoff-control"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { mkdir, symlink } from "node:fs/promises"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

describe("session handoff request schemas", () => {
  test("rejects unknown nested fields and invalid identifiers", () => {
    const decode = Schema.decodeUnknownSync(SessionHandoffV1.ControlRequest)
    const request = {
      requestID: "request",
      expected: {
        queueID: "queue",
        userMessageID: "message",
        ownerLineage: "lineage",
        ownerInstance: "instance",
        fence: 1,
        revision: 0,
        contextDigest: "digest",
      },
      target: { providerID: "provider", modelID: "model", variant: "variant" },
    }
    expect(decode(request)).toEqual(request)
    expect(() => decode({ ...request, target: { ...request.target, extra: true } })).toThrow()
    expect(() => decode({ ...request, requestID: "" })).toThrow()
    expect(() => decode({ ...request, target: { ...request.target, variant: "" } })).toThrow()
    expect(() => decode({ ...request, expected: { ...request.expected, contextDigest: "" } })).toThrow()
    expect(() => decode({ ...request, expected: { ...request.expected, fence: -1 } })).toThrow()
  })
})

const it = testEffect(Layer.mergeAll(httpApiLayer, LayerNode.compile(Database.node)))

const authenticated = testEffect(
  httpApiLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          OPENCODE_SERVER_PASSWORD: "handoff-secret",
          OPENCODE_SERVER_USERNAME: "handoff-user",
        }),
      ),
    ),
  ),
)

authenticated.live("preserves existing authentication on every handoff route", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    for (const [method, route] of [
      ["GET", "execution"],
      ["GET", "handoff/request"],
      ["POST", "enrollment"],
      ["POST", "model-control"],
      ["POST", "recovery"],
    ] as const) {
      const response = yield* requestInDirectory(`/session/ses_test/${route}`, directory, { method })
      expect(response.status).toBe(401)
    }
    const response = yield* requestInDirectory("/session/ses_test/enrollment", directory, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("handoff-user:handoff-secret").toString("base64")}` },
    })
    expect(response.status).toBe(400)
    expect(yield* response.json).toEqual({ code: "invalid_request", message: expect.any(String) })
  }),
)

if (process.env.OPENCODE_HANDOFF_MANAGED_TEST === "1") {
  it.live("managed-only retrieves admitted opaque request IDs without changing path or scope", () =>
    Effect.gen(function* () {
      const directory = process.env.OPENCODE_MANAGED_WORKSPACE
      if (!directory) return yield* Effect.die("Managed test directory is required")
      for (const requestID of ["r%q", "receipt-\u96ea", "../opaque", "r?query#fragment"]) {
        const fixture = yield* retainedEnrollmentIn(directory, requestID)
        const path = `/session/${fixture.sessionID}`
        const admitted = yield* requestInDirectory(`${path}/enrollment`, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fixture.request),
        })
        expect({ status: admitted.status, body: yield* admitted.json }).toEqual({ status: 200, body: fixture.receipt })
        const receiptPath = `${path}/handoff/${encodeURIComponent(requestID)}`
        const receipt = yield* requestInDirectory(receiptPath, directory)
        expect(receipt.status).toBe(200)
        expect(yield* receipt.json).toEqual(fixture.receipt)
        const elsewhere = yield* requestInDirectory(
          `/session/ses_other/handoff/${encodeURIComponent(requestID)}`,
          directory,
        )
        expect(elsewhere.status).toBe(404)
        const foreign = yield* tmpdirScoped()
        const denied = yield* requestInDirectory(receiptPath, foreign)
        expect(denied.status).toBe(403)
        expect(yield* denied.text).toBe("Forbidden")
        const extra = yield* requestInDirectory(`${receiptPath}/extra`, directory)
        expect(extra.status).toBe(403)
      }
      for (const suffix of ["", "r%q", "r%2"]) {
        const rejected = yield* requestInDirectory(`/session/ses_test/handoff/${suffix}`, directory)
        expect(rejected.status).toBe(403)
        expect(yield* rejected.text).toBe("Forbidden")
      }
    }),
  )
  it.live("managed-only handoff allowlist and directory boundaries", () =>
    Effect.gen(function* () {
      const directory = process.env.OPENCODE_MANAGED_WORKSPACE
      if (!directory) return yield* Effect.die("Managed test directory is required")
      for (const [method, route, status] of [
        ["GET", "execution?queueID=queue", 400],
        ["GET", "handoff/request", 404],
        ["POST", "enrollment", 400],
        ["POST", "model-control", 400],
        ["POST", "recovery", 400],
      ] as const) {
        const response = yield* requestInDirectory(`/session/ses_test/${route}`, directory, { method })
        expect(response.status).toBe(status)
      }
      const foreign = yield* tmpdirScoped()
      const denied = yield* requestInDirectory("/session/ses_test/execution", foreign)
      expect(denied.status).toBe(403)
      expect(yield* denied.text).toBe("Forbidden")
      for (const [method, route] of [
        ["DELETE", "execution"],
        ["GET", "model-control"],
        ["POST", "handoff/request"],
      ] as const) {
        const response = yield* requestInDirectory(`/session/ses_test/${route}`, directory, { method })
        expect(response.status).toBe(403)
        expect(yield* response.text).toBe("Forbidden")
      }
    }),
  )
} else {
  test("isolates managed handoff route policy at import time", async () => {
    await using directory = await tmpdir({ git: true })
    const child = Bun.spawn(["bun", "test", "test/server/session-handoff.test.ts", "-t", "managed-only"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: directory.path,
        OPENCODE_TEST_HOME: directory.path,
        OPENCODE_DB: `${directory.path}/managed.db`,
        XDG_CONFIG_HOME: `${directory.path}/config`,
        XDG_DATA_HOME: `${directory.path}/data`,
        XDG_STATE_HOME: `${directory.path}/state`,
        XDG_CACHE_HOME: `${directory.path}/cache`,
        OPENCODE_MANAGED_PROFILE: "1",
        OPENCODE_MANAGED_WORKSPACE: directory.path,
        OPENCODE_HANDOFF_MANAGED_TEST: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
  }, 30_000)
}

it.live("rejects incomplete historical action selectors", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const response = yield* HttpClientRequest.get("/session/ses_test/execution").pipe(
      HttpClientRequest.setUrlParam("directory", directory),
      HttpClientRequest.setUrlParam("queueID", "queue"),
      HttpClient.execute,
    )
    expect(response.status).toBe(400)
    expect(yield* response.json).toMatchObject({ code: "incomplete_action_selector" })
  }),
)

it.live("rejects empty historical identifiers with the handoff validation envelope", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const response = yield* requestInDirectory("/session/ses_test/execution?queueID=&userMessageID=user", directory)
    expect(response.status).toBe(400)
    expect(yield* response.json).toEqual({ code: "invalid_request", message: expect.any(String) })
  }),
)

it.live("rejects unknown mutation fields at every nested level with the contract error envelope", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const expected = {
      queueID: "q",
      userMessageID: "u",
      ownerLineage: "l",
      ownerInstance: "i",
      fence: 0,
      revision: 0,
      contextDigest: "d",
    }
    const target = { providerID: "test", modelID: "test-model", variant: "max" }
    const link = {
      parentSessionID: "s",
      parentAssistantMessageID: "a",
      parentCallID: "c",
      childSessionID: "child",
      childUserMessageID: "cu",
      mode: "foreground",
    }
    const recovery = {
      requestID: "r",
      expected,
      target,
      expectedRecoveryRevision: 0,
      expectedDescendantDigest: "d",
      children: [{ link, inputDigest: "d", ownerLineage: "l", ownerInstance: "i", fence: 0, recoveryRevision: 0 }],
    }
    for (const [route, payload] of [
      [
        "enrollment",
        {
          requestID: "r",
          queueID: "q",
          userMessageID: "u",
          ownerLineage: "l",
          ownerInstance: "i",
          fence: 0,
          historyDigest: "d",
          extra: true,
        },
      ],
      ["model-control", { requestID: "r", expected: { ...expected, extra: true }, target }],
      ["model-control", { requestID: "r", expected, target: { ...target, extra: true } }],
      ["recovery", { ...recovery, children: [{ ...recovery.children[0], link: { ...link, extra: true } }] }],
      ["recovery", { ...recovery, children: [{ ...recovery.children[0], extra: true }] }],
    ] as const) {
      const response = yield* requestInDirectory(`/session/ses_test/${route}`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ code: "invalid_request", message: expect.any(String) })
    }
  }),
)

it.live("returns the handoff not-found envelope for unknown sessions", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    for (const route of ["execution", "handoff/missing"]) {
      const response = yield* requestInDirectory(`/session/ses_missing/${route}`, directory)
      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({ code: "not_found", message: expect.any(String) })
    }
  }),
)

// Seed a committed enrollment with no live runner to exercise durable retry and historical reads over HTTP.
const retainedEnrollment = Effect.gen(function* () {
  const directory = yield* tmpdirScoped({ git: true })
  return yield* retainedEnrollmentIn(directory)
})

function retainedEnrollmentIn(directory: string, requestID: string = randomUUID()) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const created = yield* requestInDirectory("/session", encodeURIComponent(directory), { method: "POST" })
    expect(created.status).toBe(200)
    const session = yield* created.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))),
    )
    const owner = { ownerLineage: "retained-lineage", ownerInstance: "retained-instance", fence: 1 }
    const userMessageID = `msg_${randomUUID()}`
    const queueID = randomUUID()
    yield* database.db.run(
      sql`INSERT INTO runtime_execution (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, time_created, time_updated) VALUES (${session.id}, ${session.id}, ${directory}, ${owner.ownerLineage}, ${owner.ownerInstance}, 1, 'active', 1, 1, 1)`,
    )
    yield* SessionHandoffEnrollment.reserve(database, session.id, "root")
    const model = { providerID: "test", modelID: "test-model", variant: "max" }
    yield* database.db.run(
      sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${userMessageID}, ${session.id}, 1, 1, ${JSON.stringify({ role: "user", agent: "build", model, variant: "max", time: { created: 1 } })})`,
    )
    const payload = { kind: "prompt", parts: [] }
    yield* database.db.run(
      sql`INSERT INTO session_queue (id, session_id, delivery, state, position, payload, submission, message_id, time_created) VALUES (${queueID}, ${session.id}, 'queue', 'delivered', 1, ${JSON.stringify(payload)}, ${JSON.stringify({ delivery: "queue", payload })}, ${userMessageID}, 1)`,
    )
    yield* SessionHandoffEnrollment.delivered(database, session.id, "root", queueID, userMessageID)
    const candidate = yield* SessionHandoffEnrollment.candidate(database, session.id, directory, owner)
    if (!candidate) return yield* Effect.die("Expected enrollment candidate")
    const request = { ...candidate, requestID }
    const receipt = yield* SessionHandoffEnrollment.enroll(database, session.id, directory, owner, request).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SessionHandoffV1.EnrollmentReceipt)),
    )
    return { directory, sessionID: session.id, request, receipt }
  })
}

it.live("round-trips retained enrollment retries and receipts without creating new requests", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const path = `/session/${fixture.sessionID}`
    const read = yield* requestInDirectory(`${path}/handoff/${fixture.request.requestID}`, fixture.directory)
    expect({ status: read.status, body: yield* read.json }).toEqual({ status: 200, body: fixture.receipt })
    const retry = yield* requestInDirectory(`${path}/enrollment`, fixture.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(Object.entries(fixture.request).reverse())),
    })
    expect(retry.status).toBe(200)
    expect(yield* retry.json).toEqual(fixture.receipt)
    const conflict = yield* requestInDirectory(`${path}/enrollment`, fixture.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fixture.request, historyDigest: "different" }),
    })
    expect(conflict.status).toBe(409)
    expect(yield* conflict.json).toEqual({ code: "request_id_conflict", message: expect.any(String) })
    const database = yield* Database.Service
    const before = yield* database.db.all(
      sql`SELECT * FROM session_handoff_request WHERE session_id = ${fixture.sessionID}`,
    )
    const missing = yield* requestInDirectory(`${path}/handoff/unseen`, fixture.directory)
    expect(missing.status).toBe(404)
    expect(yield* missing.json).toEqual({ code: "not_found", message: expect.any(String) })
    expect(
      yield* database.db.all(sql`SELECT * FROM session_handoff_request WHERE session_id = ${fixture.sessionID}`),
    ).toEqual(before)
  }),
)

it.live("retrieves exactly the selected enrolled history and never falls back for a mismatched pair", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const path = `/session/${fixture.sessionID}/execution`
    const response = yield* requestInDirectory(
      `${path}?queueID=${fixture.request.queueID}&userMessageID=${fixture.request.userMessageID}`,
      fixture.directory,
    )
    expect(response.status).toBe(200)
    const view = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionHandoffV1.ExecutionView)))
    expect(view.viewKind).toBe("historical")
    expect(view.identity).toEqual(fixture.receipt.identity)
    const missing = yield* requestInDirectory(
      `${path}?queueID=${fixture.request.queueID}&userMessageID=wrong`,
      fixture.directory,
    )
    expect(missing.status).toBe(404)
    expect(yield* missing.json).toEqual({ code: "not_found", message: expect.any(String) })
  }),
)

it.live("returns durable model control retries before revalidating target configuration", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const database = yield* Database.Service
    const enrollment = yield* Schema.decodeUnknownEffect(SessionHandoffV1.EnrollmentReceipt)(fixture.receipt)
    if (!enrollment.identity) return yield* Effect.die("Expected enrolled identity")
    const request = {
      requestID: randomUUID(),
      expected: enrollment.identity,
      target: { providerID: "synthetic", modelID: "terra", variant: "xhigh" },
    }
    const receipt = yield* SessionHandoffControl.admit(database, fixture.sessionID, fixture.directory, request)
    const response = yield* requestInDirectory(`/session/${fixture.sessionID}/model-control`, fixture.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual(receipt)
    const conflict = yield* requestInDirectory(`/session/${fixture.sessionID}/model-control`, fixture.directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, target: { ...request.target, variant: "other" } }),
    })
    expect(conflict.status).toBe(409)
    expect(yield* conflict.json).toEqual({ code: "request_id_conflict", message: expect.any(String) })
  }),
)

it.live("maps unsupported model selection to the exact 422 error envelope", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const enrollment = yield* Schema.decodeUnknownEffect(SessionHandoffV1.EnrollmentReceipt)(fixture.receipt)
    for (const route of ["model-control", "recovery"]) {
      const response = yield* requestInDirectory(`/session/${fixture.sessionID}/${route}`, fixture.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestID: randomUUID(),
          expected: enrollment.identity,
          target: { providerID: "unconfigured-synthetic", modelID: "missing", variant: "xhigh" },
          ...(route === "recovery"
            ? { expectedRecoveryRevision: 0, expectedDescendantDigest: "digest", children: [] }
            : {}),
        }),
      })
      expect(response.status).toBe(422)
      expect(yield* response.json).toEqual({ code: "unsupported_model", message: expect.any(String) })
    }
  }),
)

it.live("rejects a foreign canonical session directory without exposing its receipt", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const foreign = yield* tmpdirScoped({ git: true })
    const response = yield* requestInDirectory(
      `/session/${fixture.sessionID}/handoff/${fixture.request.requestID}`,
      foreign,
    )
    expect(response.status).toBe(409)
    expect(yield* response.json).toEqual({ code: "wrong_directory", message: expect.any(String) })
  }),
)

it.live("round-trips a query directory containing literal percent escapes without decoding twice", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const directory = `${fixture.directory}/literal%2F`
    yield* Effect.promise(() => symlink(fixture.directory, directory))
    const response = yield* requestInDirectory(
      `/session/${fixture.sessionID}/handoff/${fixture.request.requestID}?directory=${encodeURIComponent(directory)}`,
      "%malformed",
    )
    expect({ status: response.status, body: yield* response.json }).toEqual({ status: 200, body: fixture.receipt })
  }),
)

it.live("preserves the actual stored canonical directory containing literal percent escapes", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const directory = `${root}/literal%2F`
    yield* Effect.promise(() => mkdir(directory))
    const fixture = yield* retainedEnrollmentIn(directory)
    expect(fixture.receipt.directory).toBe(directory)
    const path = `/session/${fixture.sessionID}/handoff/${fixture.request.requestID}`
    const query = yield* requestInDirectory(`${path}?directory=${encodeURIComponent(directory)}`, "%malformed")
    expect({ status: query.status, body: yield* query.json }).toEqual({ status: 200, body: fixture.receipt })
    const header = yield* requestInDirectory(path, encodeURIComponent(directory))
    expect({ status: header.status, body: yield* header.json }).toEqual({ status: 200, body: fixture.receipt })
    const implicit = yield* HttpClientRequest.get(path).pipe(HttpClient.execute)
    expect({ status: implicit.status, body: yield* implicit.json }).toEqual({ status: 200, body: fixture.receipt })
    const foreign = yield* requestInDirectory(
      `${path}?directory=${encodeURIComponent(root)}`,
      encodeURIComponent(directory),
    )
    expect(foreign.status).toBe(409)
    expect(yield* foreign.json).toEqual({ code: "wrong_directory", message: expect.any(String) })
  }),
)

it.live("decodes an encoded directory header exactly once and rejects malformed escapes", () =>
  Effect.gen(function* () {
    const fixture = yield* retainedEnrollment
    const directory = `${fixture.directory}/literal%2F`
    yield* Effect.promise(() => symlink(fixture.directory, directory))
    const path = `/session/${fixture.sessionID}/handoff/${fixture.request.requestID}`
    const response = yield* requestInDirectory(path, encodeURIComponent(directory))
    expect({ status: response.status, body: yield* response.json }).toEqual({ status: 200, body: fixture.receipt })
    const malformed = yield* requestInDirectory(path, "%malformed")
    expect({ status: malformed.status, body: yield* malformed.json }).toEqual({
      status: 409,
      body: { code: "wrong_directory", message: expect.any(String) },
    })
  }),
)
