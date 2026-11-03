import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"
import type { CompatibleApi } from "./server-compat"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  const options = {
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  }
  const client = OpenCode.make(options)
  const fetch = input.fetch ?? globalThis.fetch
  // Keep the pinned client's auth, request options, and response/error handling,
  // but bypass its outdated body whitelist for these two V2 endpoints.
  const session = (body: unknown) =>
    OpenCode.make({
      ...options,
      fetch: Object.assign(
        (url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, body: JSON.stringify(body) }),
        { preconnect: fetch.preconnect },
      ),
    }).session
  const prompt: CompatibleApi["session"]["prompt"] = (value, requestOptions) =>
    session({
      id: value.id ?? undefined,
      prompt: {
        text: value.text,
        files: value.files?.map(({ mention, ...file }) => ({ ...file, source: mention })),
        agents: value.agents?.map(({ mention, ...agent }) => ({ ...agent, source: mention })),
        agent: value.agent,
        model: value.model && {
          providerID: value.model.providerID,
          id: value.model.modelID,
          variant: value.variant,
        },
        selection: value.selection,
      },
      delivery: value.delivery ?? undefined,
      resume: value.resume ?? undefined,
    }).prompt(value, requestOptions)
  const command: CompatibleApi["session"]["command"] = (value, requestOptions) =>
    session({
      id: value.id ?? undefined,
      command: value.command,
      arguments: value.arguments ?? undefined,
      agent: value.agent ?? undefined,
      model: value.model ?? undefined,
      selection: value.selection,
      files: value.files?.map(({ mention, ...file }) => ({ ...file, source: mention })),
      agents: value.agents?.map(({ mention, ...agent }) => ({ ...agent, source: mention })),
      delivery: value.delivery ?? undefined,
      resume: value.resume ?? undefined,
    }).command(value, requestOptions)
  return { ...client, session: { ...client.session, prompt, command } }
}

export type ServerApi = OpenCodeClient
