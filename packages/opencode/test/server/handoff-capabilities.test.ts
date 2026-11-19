import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("advertises the complete legacy queue prompt handoff recovery v4 capability", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const response = yield* HttpClientRequest.get("/experimental/capabilities").pipe(
      HttpClientRequest.setUrlParam("directory", directory),
      HttpClient.execute,
    )
    expect(response.status).toBe(200)
    const body = yield* response.json
    expect(body).toMatchObject({
      legacyQueuePromptHandoffRecovery: {
        version: "legacy-queue-prompt-handoff-recovery/4",
        enrollment: true,
        modelControl: true,
        guardedRecovery: true,
        applicationMarker: true,
        assistantProvenance: true,
        interruptedResources: true,
        startupHold: "enrolled_only",
        ownerDeathRequired: true,
        taskDescendantRecovery: true,
        historicalExecution: true,
      },
    })
  }),
)
