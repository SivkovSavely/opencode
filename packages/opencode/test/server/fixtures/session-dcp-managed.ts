import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("actual DCP handler is limited to the managed session and directory", () =>
  Effect.gen(function* () {
    const directory = process.env.OPENCODE_MANAGED_WORKSPACE
    if (!directory) throw new Error("Missing managed fixture directory")
    const created = yield* requestInDirectory("/session", directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Managed DCP" }),
    })
    expect(created.status).toBe(200)
    const session = (yield* created.json) as { id: string }
    const response = yield* requestInDirectory(`/session/${session.id}/dcp`, directory)
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ sessionID: session.id, state: "absent" })
    for (const suffix of [
      `?directory=${encodeURIComponent(process.env.TEST_OTHER ?? "/forbidden")}`,
      `?directory=${encodeURIComponent(directory)}&directory=${encodeURIComponent(process.env.TEST_OTHER ?? "/forbidden")}`,
      "?workspace=wrk_foreign",
    ]) {
      expect((yield* HttpClient.get(`/session/${session.id}/dcp${suffix}`)).status).toBe(403)
    }
    const workspaceHeader = yield* HttpClientRequest.get(`/session/${session.id}/dcp`).pipe(
      HttpClientRequest.setHeader("x-opencode-workspace", "wrk_foreign"),
      HttpClient.execute,
    )
    expect(workspaceHeader.status).toBe(403)
  }),
)
