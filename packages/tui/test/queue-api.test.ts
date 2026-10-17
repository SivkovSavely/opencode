import { expect, test } from "bun:test"
import { createOpencodeClient, type Session } from "@opencode-ai/sdk/v2"
import { createQueueAPI } from "../src/queue/api"

for (const workspaceID of [undefined, "workspace-b"]) {
  test(`queue operations resolve new-session placement instead of fixed TUI scope (${workspaceID ?? "local"})`, async () => {
    const requests: Request[] = []
    const session: Session = {
      id: "ses_new",
      slug: "new",
      projectID: "project",
      directory: "/worktree-b",
      workspaceID,
      title: "New session",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    const client = createOpencodeClient({
      baseUrl: "http://queue.test",
      directory: "/worktree-a",
      experimental_workspaceID: "workspace-a",
      fetch: Object.assign(
        async (request: Parameters<typeof fetch>[0]) => {
          const input = request instanceof Request ? request : new Request(request)
          requests.push(input)
          return Response.json(new URL(input.url).pathname.endsWith("/ses_new") ? session : {})
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const api = createQueueAPI(client, () => undefined)
    await api.list(session.id)
    await api.submit(session.id, {
      id: "entry",
      payload: {
        kind: "prompt",
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        parts: [{ type: "text", text: "task" }],
      },
    })
    await api.update(session.id, { revision: 1, mutation: { action: "pause", paused: true } })
    await api.flush(session.id)
    const mutations = requests.filter((request) => new URL(request.url).pathname.includes("/queue"))
    expect(mutations).toHaveLength(4)
    for (const request of mutations) {
      const url = new URL(request.url)
      expect(url.searchParams.get("directory")).toBe("/worktree-b")
      expect(url.searchParams.get("workspace")).toBe(workspaceID ?? null)
      expect(request.headers.get("x-opencode-directory")).toBeNull()
      expect(request.headers.get("x-opencode-workspace")).toBeNull()
    }
  })
}
