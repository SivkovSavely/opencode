import { EventV2 } from "@opencode-ai/core/event"
import { EventDiagnostics, type SubscriberHandle } from "@opencode-ai/core/event-diagnostics"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

function eventData(data: unknown, subscriberID: SubscriberHandle | undefined): Sse.Event {
  const encoded = Schema.encodeUnknownSync(OpenCodeEvent)(data)
  const serialized = JSON.stringify(encoded)
  if (EventDiagnostics.enabled) {
    EventDiagnostics.serialized(subscriberID, encoded.type, serialized.length, Buffer.byteLength(serialized))
  }
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: serialized,
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        let subscriberID: SubscriberHandle | undefined
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity, (id) => {
              subscriberID = id
            })
            return Stream.make(connected).pipe(Stream.concat(live))
          }),
        ).pipe(
          Stream.map((event) => eventData(event, subscriberID)),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
