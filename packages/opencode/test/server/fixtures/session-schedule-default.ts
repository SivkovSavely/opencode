import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { Database } from "bun:sqlite"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { GlobalBus } from "../../../src/bus/global"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { Server } from "../../../src/server/server"
import { RuntimeLifecycle } from "../../../src/server/runtime-lifecycle"

const directory = process.env.SCHEDULE_DIRECTORY!
const app = Server.Default().app
const sdk = createOpencodeClient({
  baseUrl: "http://localhost",
  directory,
  throwOnError: true,
  fetch: Object.assign(
    (request: Request | URL | string, init?: RequestInit) =>
      Promise.resolve(app.fetch(request instanceof Request ? request : new Request(request, init))),
    { preconnect: fetch.preconnect },
  ),
})

async function request<T>(path: string, body?: unknown) {
  const url = new URL(path, "http://localhost")
  url.searchParams.set("directory", directory)
  const response = await app.fetch(
    new Request(
      url,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  )
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as T
}

try {
  // Concurrent first requests must share the same server startup and worker.
  await Promise.all(Array.from({ length: 3 }, () => request("/global/health")))
  assert.equal(Server.url, undefined)
  const runtime = RuntimeLifecycle.current()
  assert(runtime)
  assert.notEqual(runtime.identity.instance, "unavailable", "embedded execution must use durable runtime ownership")
  const session = (await sdk.session.create({ title: "embedded scheduled message" })).data!
  const root = `/session/${session.id}/schedule`
  const schedule = await request<SessionScheduleV1.Info>(root, {
    message: "default handler scheduled message",
    spec: { mode: "interval", amount: 1, unit: "minutes", immediate: true },
    sessionState: "always",
    deferUntilIdle: false,
    missed: "all",
    limit: 1,
  })

  // Observe durable delivery without making any more requests to the handler.
  using database = new Database(process.env.OPENCODE_DB!, { readonly: true })
  const occurrence = database.query<{ state: string }, [string]>(
    "SELECT state FROM session_schedule_occurrence WHERE schedule_id = ?",
  )
  const deadline = Date.now() + 20_000
  while (occurrence.get(schedule.id)?.state !== "delivered" && Date.now() < deadline) await setTimeout(25)
  assert.equal(occurrence.get(schedule.id)?.state, "delivered")
  const assistant = database.query<{ data: string }, [string]>(
    "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.time.completed') IS NOT NULL",
  )
  while (!assistant.get(session.id) && Date.now() < deadline) await setTimeout(25)
  assert(assistant.get(session.id), "scheduled provider turn must finish before disposing the handler")
  assert.deepEqual(
    database
      .query<
        { owner_lineage: string; owner_instance: string },
        [string]
      >("SELECT owner_lineage, owner_instance FROM runtime_execution WHERE session_id = ?")
      .get(session.id),
    { owner_lineage: runtime.identity.lineage, owner_instance: runtime.identity.instance },
    "the embedded scheduled run must acquire durable execution ownership",
  )
  const history = await request<SessionScheduleV1.History>(`${root}/${schedule.id}/history`)
  assert.equal(history.items.length, 1)
  const users = (await sdk.session.messages({ sessionID: session.id })).data!.filter(
    (item) => item.info.role === "user",
  )
  assert.equal(users.length, 1)
  assert(users[0].info.role === "user")
  assert.equal(users[0].info.id, history.items[0].messageID)
  assert.deepEqual(users[0].info.origin, {
    type: "scheduled",
    scheduleID: schedule.id,
    occurrenceID: history.items[0].id,
  })
  assert.deepEqual(
    users[0].parts.map((part) => (part.type === "text" ? part.text : undefined)),
    ["default handler scheduled message"],
  )
  const listeners = GlobalBus.listenerCount("event")
  await Promise.all(Array.from({ length: 3 }, () => request("/global/health")))
  assert.equal(GlobalBus.listenerCount("event"), listeners)
  await HttpApiApp.webHandler().dispose()
  assert(GlobalBus.listenerCount("event") < listeners, "disposing the handler must remove the scheduler subscription")
} finally {
  await HttpApiApp.webHandler().dispose()
  await AppRuntime.dispose()
}
console.log("default handler schedule verified")
