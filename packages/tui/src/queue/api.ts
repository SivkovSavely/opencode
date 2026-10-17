import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2"
import type { QueueAPI } from "./controller"

export function createQueueAPI(client: OpencodeClient, cached: (sessionID: string) => Session | undefined): QueueAPI {
  const options = {
    throwOnError: true as const,
    headers: { "x-opencode-directory": null, "x-opencode-workspace": null },
  }
  async function scope(sessionID: string) {
    const session = cached(sessionID) ?? (await client.session.get({ sessionID }, options)).data
    return { directory: session.directory, workspace: session.workspaceID }
  }

  return {
    list: async (sessionID) =>
      (await client.session.queueList({ sessionID, ...(await scope(sessionID)) }, options)).data,
    submit: async (sessionID, input) => {
      const payload = input.payload
      return (
        await client.session.queueSubmit(
          {
            sessionID,
            ...(await scope(sessionID)),
            ...input,
            payload:
              payload.kind === "prompt"
                ? { ...payload, parts: [...payload.parts] }
                : payload.kind === "command"
                  ? { ...payload, parts: payload.parts ? [...payload.parts] : undefined }
                  : payload,
          },
          options,
        )
      ).data
    },
    update: async (sessionID, input) =>
      (
        await client.session.queueUpdate(
          {
            sessionID,
            ...(await scope(sessionID)),
            ...input,
            mutation:
              input.mutation.action === "reorder"
                ? { ...input.mutation, ids: [...input.mutation.ids] }
                : input.mutation,
          },
          options,
        )
      ).data,
    flush: async (sessionID) =>
      (await client.session.queueFlush({ sessionID, ...(await scope(sessionID)) }, options)).data,
  }
}
