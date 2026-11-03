import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2"
import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { Schema } from "effect"

export function createScheduleAPI(client: OpencodeClient, cached: (id: string) => Session | undefined) {
  async function request<T>(
    sessionID: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    suffix: string,
    schema: Schema.Decoder<T>,
    body?: unknown,
    cursor?: number,
  ) {
    const session =
      cached(sessionID) ??
      (
        await client.session.get(
          { sessionID },
          { throwOnError: true, headers: { "x-opencode-directory": null, "x-opencode-workspace": null } },
        )
      ).data
    // Use the configured SDK transport until these endpoints are generated into the SDK.
    const result = await client["client"].request({
      method,
      url: `/session/${encodeURIComponent(sessionID)}/schedule${suffix}`,
      query: { directory: session.directory, workspace: session.workspaceID, cursor },
      headers: { "x-opencode-directory": null, "x-opencode-workspace": null, "Content-Type": "application/json" },
      body,
      throwOnError: true,
    })
    return Schema.decodeUnknownSync(schema)(result.data)
  }
  return {
    list: (sessionID: string) => request(sessionID, "GET", "", Schema.Array(SessionScheduleV1.Info)),
    get: (sessionID: string, id: string) =>
      request(sessionID, "GET", `/${encodeURIComponent(id)}`, SessionScheduleV1.Info),
    save: (sessionID: string, input: SessionScheduleV1.Input, id?: string) =>
      request(
        sessionID,
        id ? "PUT" : "POST",
        id ? `/${encodeURIComponent(id)}` : "",
        SessionScheduleV1.Info,
        Schema.encodeSync(SessionScheduleV1.Input)(input),
      ),
    preview: (sessionID: string, spec: SessionScheduleV1.Spec, scheduleID?: string) =>
      request(sessionID, "POST", "/preview", SessionScheduleV1.Preview, { spec, scheduleID }),
    pause: (sessionID: string, id: string, paused: boolean) =>
      request(sessionID, "POST", `/${encodeURIComponent(id)}/pause`, SessionScheduleV1.Info, { paused }),
    remove: (sessionID: string, id: string) =>
      request(sessionID, "DELETE", `/${encodeURIComponent(id)}`, Schema.Boolean),
    history: (sessionID: string, id: string, cursor?: number) =>
      request(sessionID, "GET", `/${encodeURIComponent(id)}/history`, SessionScheduleV1.History, undefined, cursor),
  }
}
export type ScheduleAPI = ReturnType<typeof createScheduleAPI>
