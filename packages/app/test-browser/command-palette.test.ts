import { describe, expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerSessionEntries, type CommandPaletteEntry } from "@/components/command-palette"
import type { LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { getProjectAvatarSource } from "@/pages/layout/helpers"

const stored: Project = {
  id: "project-1",
  name: "Palette project",
  worktree: "/workspace/project",
  sandboxes: ["/workspace/worktree"],
  icon: { url: "stored-project-avatar" },
  time: { created: 1, updated: 1 },
}

const session: SessionInfo = {
  id: "session-1",
  projectID: stored.id,
  agent: "build",
  model: { id: "model-1", providerID: "provider-1" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  location: { directory: stored.worktree },
  title: "Palette session",
  time: { created: 1, updated: 2 },
}

describe("command palette sessions", () => {
  test("uses the home project avatar and cancels superseded searches", async () => {
    const server = ServerConnection.Key.make("selected-server")
    const opened: LocalProject = {
      ...stored,
      icon: { override: "home-project-avatar" },
      expanded: true,
    }
    const searches: string[] = []
    const result = await new Promise<Awaited<ReturnType<ReturnType<typeof createServerSessionEntries>>>>(
      (resolve, reject) => {
        createRoot((dispose) => {
          const search = createServerSessionEntries({
            server,
            opened: () => [opened],
            stored: () => [stored],
            load: async (text) => {
              searches.push(text)
              return {
                data: [session, { ...session, id: "archived-session", time: { ...session.time, archived: 3 } }],
              }
            },
            untitled: () => "Untitled",
            category: () => "Sessions",
          })
          const first = search("palette")
          const second = search("palette session")
          Promise.all([first, second])
            .then(([cancelled, entries]) => {
              expect(cancelled).toEqual([])
              resolve(entries)
            })
            .catch(reject)
            .finally(dispose)
        })
      },
    )

    expect(searches).toEqual(["palette session"])
    expect(result).toHaveLength(1)
    expect(result[0]?.presentationProject).toBe(opened)
    expect(result[0]).toMatchObject({
      server,
      sessionID: session.id,
      description: stored.name,
      project: { id: stored.id, icon: opened.icon },
    })
  })

  const root: LocalProject = { ...stored, name: "Repository root", icon: { override: "root-icon" }, expanded: true }
  const worktree: LocalProject = {
    ...stored,
    name: "Exact worktree",
    worktree: "/workspace/worktree/",
    icon: { override: "worktree-icon" },
    expanded: true,
  }
  const sibling: LocalProject = {
    ...stored,
    name: "Unrelated sibling",
    worktree: "/workspace/sibling",
    sandboxes: [],
    icon: { override: "sibling-icon" },
    expanded: true,
  }

  test.each([
    { match: "exact directory", projects: [root, worktree, sibling], name: "Exact worktree", icon: "worktree-icon" },
    { match: "opened root sandbox", projects: [root, sibling], name: "Palette project", icon: "stored-project-avatar" },
    { match: "same-ID sibling", projects: [sibling], name: "Palette project", icon: "stored-project-avatar" },
  ])(
    "resolves presentation for $match without changing the same-ID navigation project",
    async ({ projects, name, icon }) => {
      const server = ServerConnection.Key.make("secondary-server")
      const [entry] = await createRoot((dispose) => {
        const search = createServerSessionEntries({
          server,
          opened: () => projects,
          stored: () => [stored],
          load: async () => ({ data: [{ ...session, location: { directory: "/workspace/worktree" } }] }),
          untitled: () => "Untitled",
          category: () => "Sessions",
        })
        return search("palette").finally(dispose)
      })

      expect(entry?.server).toBe(server)
      expect(entry?.project).toBe(sibling)
      expect(entry?.description).toBe(name)
      expect(entry?.presentationProject?.id).toBe(stored.id)
      expect(getProjectAvatarSource(entry?.presentationProject?.id, entry?.presentationProject?.icon)).toBe(icon)
    },
  )

  test("updates the description and avatar of the same result when its opened directory changes", async () => {
    await createRoot(async (dispose) => {
      try {
        const [state, setState] = createStore<{ opened: LocalProject[]; entry?: CommandPaletteEntry }>({
          opened: [{ ...stored, icon: { override: "initial-icon" }, expanded: true }],
        })
        const searches: string[] = []
        const search = createServerSessionEntries({
          server: ServerConnection.Key.make("secondary-server"),
          opened: () => state.opened,
          stored: () => [stored],
          load: async (text) => {
            searches.push(text)
            return { data: [session] }
          },
          untitled: () => "Untitled",
          category: () => "Sessions",
        })
        const description = createMemo(() => state.entry?.description)
        const avatar = createMemo(() => {
          const project = state.entry?.presentationProject
          return getProjectAvatarSource(project?.id, project?.icon)
        })
        const [entry] = await search("palette")
        setState("entry", entry)

        expect(description()).toBe("Palette project")
        expect(avatar()).toBe("initial-icon")
        setState("opened", [{ ...stored, name: "Renamed project", icon: { override: "new-icon" }, expanded: true }])
        expect(description()).toBe("Renamed project")
        expect(avatar()).toBe("new-icon")
        setState("opened", [{ ...stored, name: undefined, icon: { url: "" }, expanded: true }])
        expect(description()).toBe("project")
        expect(avatar()).toBeUndefined()
        setState("opened", [])
        expect(description()).toBe("Palette project")
        expect(avatar()).toBe("stored-project-avatar")
        expect(searches).toEqual(["palette"])
      } finally {
        dispose()
      }
    })
  })
})
