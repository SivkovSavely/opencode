import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Server } from "../../../src/server/server"

const directory = process.env.SCHEDULE_DIRECTORY!
const stateFile = `${directory}/restart-state.json`
const text = "Scheduled restart message\nPreserve exactly: <schedule> & whitespace."
type State = {
  schedule: SessionScheduleV1.Info
  history: SessionScheduleV1.History
  queued: { payload: string; submission: string }
}

async function poll<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await setTimeout(25)
  }
  throw new Error("Timed out waiting for scheduled restart state")
}

assert.equal(Database.path(), process.env.OPENCODE_DB)
assert.notEqual(Database.path(), ":memory:")
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const sdk = createOpencodeClient({ baseUrl: listener.url.toString(), directory, throwOnError: true })
async function request<T>(path: string, body?: unknown) {
  const url = new URL(path, listener.url)
  url.searchParams.set("directory", directory)
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  )
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as T
}

async function setSelection(
  sessionID: string,
  agent: string,
  model: { providerID: string; id: string; variant: string },
) {
  const { Database } = await import("bun:sqlite")
  using db = new Database(process.env.OPENCODE_DB!)
  assert.equal(
    db.query("UPDATE session SET agent = ?, model = ? WHERE id = ?").run(agent, JSON.stringify(model), sessionID)
      .changes,
    1,
  )
}

async function queueRecord(id: string) {
  const { Database } = await import("bun:sqlite")
  using db = new Database(process.env.OPENCODE_DB!)
  const row = db
    .query<
      { payload: string; submission: string },
      [string]
    >("SELECT payload, submission FROM session_queue WHERE id = ?")
    .get(id)
  assert(row)
  return row
}

try {
  if (process.argv[2] === "accept") {
    const session = (await sdk.session.create({ title: "durable scheduled restart" })).data!
    await setSelection(session.id, "selected", { providerID: "test", id: "selected", variant: "xhigh" })
    const initial = (await sdk.session.queueList({ sessionID: session.id })).data!
    await sdk.session.queueUpdate({
      sessionID: session.id,
      revision: initial.revision,
      mutation: { action: "pause", paused: true },
    })
    const schedule = await request<SessionScheduleV1.Info>(`/session/${session.id}/schedule`, {
      message: text,
      spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
      sessionState: "always",
      deferUntilIdle: false,
      missed: "all",
      limit: 1,
    })
    const history = await poll(async () => {
      const value = await request<SessionScheduleV1.History>(`/session/${session.id}/schedule/${schedule.id}/history`)
      return value.items[0]?.state === "accepted" ? value : undefined
    })
    assert.equal(history.items.length, 1)
    assert.equal(history.items[0].id, `occ_${schedule.id}_${schedule.anchor}`)
    assert.equal(history.items[0].scheduled, schedule.anchor)
    const queue = (await sdk.session.queueList({ sessionID: session.id })).data!
    assert.equal(queue.paused, true)
    assert.equal(queue.items.length, 1)
    assert.equal(queue.items[0].id, history.items[0].id)
    assert.equal(queue.items[0].state, "pending")
    assert.deepEqual(queue.items[0].origin, {
      type: "scheduled",
      scheduleID: schedule.id,
      occurrenceID: history.items[0].id,
    })
    assert(queue.items[0].payload.kind === "prompt")
    assert.deepEqual(queue.items[0].payload.parts, [{ type: "text", text }])
    assert.equal(queue.items[0].payload.agent, "selected")
    assert.deepEqual(queue.items[0].payload.model, { providerID: "test", modelID: "selected" })
    assert.equal(queue.items[0].payload.variant, "xhigh")
    assert.deepEqual(queue.items[0].payload.selection, { variant: "xhigh" })
    // Preserve a pre-fix accepted payload, including its exact retry identity.
    const { Database } = await import("bun:sqlite")
    using db = new Database(process.env.OPENCODE_DB!)
    assert.equal(
      db
        .query(
          `UPDATE session_queue
      SET payload = json_remove(payload, '$.selection.variant'),
          submission = json_remove(submission, '$.payload.selection.variant')
      WHERE id = ?`,
        )
        .run(queue.items[0].id).changes,
      1,
    )
    await setSelection(session.id, "build", { providerID: "test", id: "test-model", variant: "default" })
    assert.deepEqual((await sdk.session.get({ sessionID: session.id })).data!.model, {
      providerID: "test",
      id: "test-model",
      variant: "default",
    })
    assert.equal((await request<SessionScheduleV1.Info>(`/session/${session.id}/schedule/${schedule.id}`)).completed, 0)
    await Bun.write(stateFile, JSON.stringify({ schedule, history, queued: await queueRecord(queue.items[0].id) }))
  } else {
    const saved = (await Bun.file(stateFile).json()) as State
    const sessionID = saved.schedule.sessionID
    const root = `/session/${sessionID}/schedule/${saved.schedule.id}`
    const before = await request<SessionScheduleV1.Info>(root)
    assert.equal(before.anchor, saved.schedule.anchor)
    assert.deepEqual(before.spec, saved.schedule.spec)
    const persisted = await request<SessionScheduleV1.History>(`${root}/history`)
    if (process.argv[2] !== "unavailable") assert.deepEqual(persisted, saved.history)
    assert.deepEqual(await queueRecord(saved.history.items[0].id), saved.queued)
    if (process.argv[2] === "unavailable") {
      const history = await poll(async () => {
        const value = await request<SessionScheduleV1.History>(`${root}/history`)
        return value.items[0]?.error?.includes('Variant not found: "xhigh" for test/selected') ? value : undefined
      })
      assert.equal(history.items[0].state, "accepted")
      assert.equal(history.items[0].id, saved.history.items[0].id)
      assert.equal(before.completed, 0)
      await sdk.session.queueFlush({ sessionID })
      const queue = await poll(async () => {
        const value = (await sdk.session.queueList({ sessionID })).data!
        return value.blocked ? value : undefined
      })
      assert.equal(queue.items.length, 1)
      assert.equal(queue.items[0].state, "pending")
      assert.deepEqual(queue.items[0].payload.selection, {})
      assert.deepEqual(await queueRecord(history.items[0].id), saved.queued)
      assert.equal((await sdk.session.messages({ sessionID })).data!.length, 0)
      await Bun.write(stateFile, JSON.stringify({ ...saved, history }))
    }
    if (process.argv[2] !== "unavailable") {
      if (process.argv[2] === "deliver") {
        assert.equal(before.completed, 0)
        assert.equal(before.next, saved.schedule.anchor + 60_000)
        const queue = (await sdk.session.queueList({ sessionID })).data!
        assert.equal(queue.items.length, 1)
        assert.equal(queue.items[0].id, persisted.items[0].id)
        await sdk.session.queueUpdate({
          sessionID,
          revision: queue.revision,
          mutation: { action: "pause", paused: false },
        })
      }
      const history = await poll(async () => {
        const value = await request<SessionScheduleV1.History>(`${root}/history`)
        return value.items[0]?.state === "delivered" ? value : undefined
      })
      assert.equal(history.items.length, 1)
      assert.equal(history.items[0].id, saved.history.items[0].id)
      assert.equal(history.items[0].error, undefined)
      const completed = await request<SessionScheduleV1.Info>(root)
      assert.equal(completed.status, "completed")
      assert.equal(completed.completed, 1)
      assert.equal(completed.next, undefined)
      await poll(async () => {
        const status = (await sdk.session.status()).data!
        return !status[sessionID] || status[sessionID].type === "idle" ? true : undefined
      })
      const users = (await sdk.session.messages({ sessionID })).data!.filter(
        (message) => message.info.role === "user" && message.info.origin?.type === "scheduled",
      )
      assert.equal(users.length, 1)
      assert(users[0].info.role === "user")
      assert.equal(users[0].info.agent, "selected")
      assert.deepEqual(users[0].info.model, { providerID: "test", modelID: "selected", variant: "xhigh" })
      const current = (await sdk.session.get({ sessionID })).data!
      assert.equal(current.agent, "build")
      assert.deepEqual(current.model, { providerID: "test", id: "test-model", variant: "default" })
      assert.equal(users[0].info.id, history.items[0].messageID)
      assert.deepEqual(users[0].info.origin, {
        type: "scheduled",
        scheduleID: saved.schedule.id,
        occurrenceID: history.items[0].id,
      })
      assert.deepEqual(
        users[0].parts.filter((part) => part.type === "text").map((part) => part.text),
        [text],
      )
      const queue = (await sdk.session.queueList({ sessionID })).data!
      assert.equal(queue.items.filter((item) => item.state === "pending" || item.state === "claimed").length, 0)
      assert.deepEqual(await queueRecord(history.items[0].id), saved.queued)
      await Bun.write(stateFile, JSON.stringify({ ...saved, history }))
    }
  }
} finally {
  await listener.stop(true)
  await AppRuntime.dispose()
}
console.log(`schedule restart ${process.argv[2]} verified`)
