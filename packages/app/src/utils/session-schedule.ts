import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { Schema } from "effect"

// Use the configured SDK transport until the schedule endpoints are generated.
export function sessionSchedule(client: OpencodeClient, sessionID: string, directory: string) {
  const transport = client["client"]
  const root = `/session/${encodeURIComponent(sessionID)}/schedule`
  const query = { directory }
  const options = { throwOnError: true as const, headers: { "Content-Type": "application/json" } }
  return {
    list: async () =>
      Schema.decodeUnknownSync(Schema.Array(SessionScheduleV1.Info))(
        (await transport.get({ url: root, query, ...options })).data,
      ),
    get: async (id: string) =>
      Schema.decodeUnknownSync(SessionScheduleV1.Info)(
        (await transport.get({ url: `${root}/${encodeURIComponent(id)}`, query, ...options })).data,
      ),
    create: async (input: SessionScheduleV1.Input) =>
      Schema.decodeUnknownSync(SessionScheduleV1.Info)(
        (await transport.post({ url: root, query, body: input, ...options })).data,
      ),
    update: async (id: string, input: SessionScheduleV1.Input) =>
      Schema.decodeUnknownSync(SessionScheduleV1.Info)(
        (await transport.put({ url: `${root}/${encodeURIComponent(id)}`, query, body: input, ...options })).data,
      ),
    remove: async (id: string) =>
      Schema.decodeUnknownSync(Schema.Boolean)(
        (await transport.delete({ url: `${root}/${encodeURIComponent(id)}`, query, ...options })).data,
      ),
    pause: async (id: string, paused: boolean) =>
      Schema.decodeUnknownSync(SessionScheduleV1.Info)(
        (await transport.post({ url: `${root}/${encodeURIComponent(id)}/pause`, query, body: { paused }, ...options }))
          .data,
      ),
    preview: async (spec: SessionScheduleV1.Spec, scheduleID?: string) =>
      Schema.decodeUnknownSync(SessionScheduleV1.Preview)(
        (await transport.post({ url: `${root}/preview`, query, body: { spec, scheduleID }, ...options })).data,
      ),
    history: async (id: string, cursor?: number) =>
      Schema.decodeUnknownSync(SessionScheduleV1.History)(
        (
          await transport.get({
            url: `${root}/${encodeURIComponent(id)}/history`,
            query: { ...query, cursor },
            ...options,
          })
        ).data,
      ),
  }
}
