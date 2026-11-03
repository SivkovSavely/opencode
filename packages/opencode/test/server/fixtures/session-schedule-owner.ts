import assert from "node:assert/strict"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { Server } from "../../../src/server/server"

const directory = process.env.SCHEDULE_DIRECTORY
assert(directory)
const role = process.argv[2]
const listener = role === "owner" ? await Server.listen({ hostname: "127.0.0.1", port: 0 }) : undefined
try {
  if (!listener) {
    const response = await Server.Default().app.fetch(new Request("http://localhost/global/health"))
    assert.equal(response.status, 200)
  }
  await Bun.write(`${directory}/${role}-ready.json`, JSON.stringify({ url: listener?.url.toString() }))
  await Bun.stdin.text()
} finally {
  if (listener) await listener.stop(true)
  else await HttpApiApp.webHandler().dispose()
  await AppRuntime.dispose()
}
