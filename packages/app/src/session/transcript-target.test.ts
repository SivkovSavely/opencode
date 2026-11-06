import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "@opencode/client/solid"
import { OpenCode, type SessionMessageInfo } from "@opencode/client/promise"
import { resolveTranscriptTarget, transcriptTarget } from "./transcript-target"

const user: SessionMessageInfo = {
  id: "msg_1_user",
  type: "user",
  text: "firstsecond",
  experimental: {
    textParts: [
      { id: "prt_first", text: "first", timeCreated: 1 },
      { id: "prt_second", text: "second", timeCreated: 2 },
    ],
  },
  time: { created: 1 },
}

const assistant: SessionMessageInfo = {
  id: "msg_2_assistant",
  type: "assistant",
  agent: "build",
  model: { id: "old", providerID: "retired" },
  content: [
    { type: "text", text: "reply", experimental: { sourcePartID: "prt_reply", timeCreated: 3, searchable: true } },
  ],
  time: { created: 3 },
}

const newer: SessionMessageInfo = { id: "msg_3_new", type: "user", text: "newer", time: { created: 4 } }

test("structured hashes validate identity and retain independent legacy links", () => {
  expect(
    transcriptTarget(`#search:${encodeURIComponent(JSON.stringify({ messageID: "msg_user", partID: "prt_second" }))}`),
  ).toEqual({ messageID: "msg_user", partID: "prt_second" })

  for (const hash of ["#message-msg_user", "#search:%zz", "#search:{}", '#search:{"messageID":"x","partID":4}'])
    expect(transcriptTarget(hash)).toBeUndefined()
})

test("native history loads the owning prompt and preserves exact multipart and remapped assistant source IDs", async () => {
  const requests: string[] = []

  const file: SessionMessageInfo = {
    id: "msg_2_file",
    type: "user",
    text: "File only",
    files: [{ name: "old.txt", mime: "text/plain", data: "b2xk", source: { type: "inline" } }],
    experimental: { filePartIDs: ["prt_file"] },
    time: { created: 3 },
  }

  const api = OpenCode.make({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url)
        requests.push(url.searchParams.get("cursor") ?? "initial")

        return Response.json(
          url.searchParams.has("cursor")
            ? { data: [file, assistant, user], cursor: {} }
            : { data: [newer], cursor: { next: "older" } },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  })

  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/fixture", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const history = setup.data.session.message
    await history.sync("session")
    expect(
      await resolveTranscriptTarget(history, "session", { messageID: user.id, partID: "prt_second" }, () => true),
    ).toMatchObject({ status: "found", partID: "prt_second", ownerID: user.id })
    expect(
      await resolveTranscriptTarget(history, "session", { messageID: assistant.id, partID: "prt_reply" }, () => true),
    ).toMatchObject({ status: "found", partID: "msg_2_assistant:text:0", ownerID: user.id })
    expect(
      await resolveTranscriptTarget(history, "session", { messageID: file.id, partID: "prt_file" }, () => true),
    ).toMatchObject({ status: "found", partID: "prt_file", ownerID: file.id })
    expect(requests).toEqual(["initial", "older"])
  } finally {
    setup.dispose()
  }
})

test("missing parts get exactly one targeted refresh, never a sibling; explicit reselection can retry", async () => {
  let refreshes = 0
  let restored = false

  const api = OpenCode.make({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url)

        if (url.pathname.endsWith(`/${user.id}`)) {
          refreshes++

          return Response.json({
            data: restored
              ? user
              : { ...user, experimental: { textParts: [{ id: "prt_first", text: "first", timeCreated: 1 }] } },
          })
        }

        return Response.json({
          data: [{ ...user, experimental: { textParts: [{ id: "prt_first", text: "first", timeCreated: 1 }] } }],
          cursor: {},
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/fixture", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const history = setup.data.session.message
    await history.sync("session")
    expect(
      await resolveTranscriptTarget(history, "session", { messageID: user.id, partID: "prt_second" }, () => true),
    ).toEqual({ status: "unavailable" })
    expect(refreshes).toBe(1)
    restored = true
    expect(
      await resolveTranscriptTarget(history, "session", { messageID: user.id, partID: "prt_second" }, () => true),
    ).toMatchObject({ status: "found", partID: "prt_second" })
    expect(refreshes).toBe(2)
  } finally {
    setup.dispose()
  }
})

test("a failed page can be explicitly retried, in-flight history is joined and obsolete session ownership cannot resolve", async () => {
  let failed = true
  let pages = 0
  let current = true
  const held = Promise.withResolvers<Response>()
  const arrived = Promise.withResolvers<void>()

  const api = OpenCode.make({
    baseUrl: "http://fixture.local",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url)

        if (!url.searchParams.has("cursor")) return Response.json({ data: [newer], cursor: { next: "older" } })
        pages++

        if (failed) throw new Error("offline")
        arrived.resolve()

        return held.promise
      },
      { preconnect: fetch.preconnect },
    ),
  })

  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/fixture", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))

  try {
    const history = setup.data.session.message
    await history.sync("session")
    await expect(
      resolveTranscriptTarget(history, "session", { messageID: user.id }, () => current),
    ).rejects.toBeDefined()
    failed = false
    const first = resolveTranscriptTarget(history, "session", { messageID: user.id }, () => current)
    const second = resolveTranscriptTarget(history, "session", { messageID: user.id }, () => current)
    await arrived.promise
    current = false
    held.resolve(Response.json({ data: [user], cursor: {} }))
    expect(await first).toBeUndefined()
    expect(await second).toBeUndefined()
    expect(pages).toBe(2)
  } finally {
    setup.dispose()
  }
})
