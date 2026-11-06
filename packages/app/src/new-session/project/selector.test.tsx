import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { PromptProjectControls } from "./selector"

mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))

const { createPromptProjectController } = await import("./selector")

describe("new session project selection", () => {
  test.each([false, true])("exact directory wins over shared sandbox metadata (reversed: %s)", (reversed) => {
    const metadata = { id: "shared", sandboxes: ["/repo/worktree"], worktrees: [{ directory: "/repo/worktree" }] }
    const parent = { ...metadata, worktree: "/repo", used: true }
    const worktree = { ...metadata, worktree: "/repo/worktree", used: true }
    const selected: string[] = []
    const controls: PromptProjectControls = {
      available: reversed ? [worktree, parent] : [parent, worktree],
      directory: "/repo/worktree/",
      projectID: "shared",
      select(directory) {
        selected.push(directory)
        controls.directory = directory
      },
      add() {},
    }

    createRoot((dispose) => {
      const controller = createPromptProjectController({ controls: () => controls })
      expect(controller.selected()).toBe(worktree)
      controller.select(parent)
      expect(selected).toEqual(["/repo"])
      expect(controls.directory).toBe("/repo")
      expect(controller.selected()).toBe(parent)
      dispose()
    })
  })

  test.each(["sandbox", "project ID"])("retains the %s fallback without an exact directory", (fallback) => {
    const byID = { id: "shared", worktree: "/id" }
    const sandbox = { id: "other", worktree: "/sandbox", sandboxes: ["C:/Repo/worktree/"] }
    const controls: PromptProjectControls = {
      available: fallback === "sandbox" ? [byID, sandbox] : [byID],
      directory: "C:\\Repo\\worktree",
      projectID: "shared",
      select() {},
      add() {},
    }

    createRoot((dispose) => {
      const controller = createPromptProjectController({ controls: () => controls })
      expect(controller.selected()).toBe(fallback === "sandbox" ? sandbox : byID)
      dispose()
    })
  })

  test("shows the current project's appearance before its worktree inventory loads", () => {
    const generic = { id: "other", worktree: "/other" }

    const current = {
      id: "current",
      worktree: "/repo",
      name: "My custom name",
      icon: { override: "data:image/png;base64,AAAA" },
    }

    const controls: PromptProjectControls = {
      available: [generic, current],
      directory: "/repo/.opencode/worktree/feature",
      projectID: "current",
      select() {},
      add() {},
    }

    createRoot((dispose) => {
      const controller = createPromptProjectController({ controls: () => controls })
      expect(controller.selected()).toEqual(current)
      dispose()
    })
  })

  test("does not select a matching project ID from another server", () => {
    const remote = {
      id: "shared",
      worktree: "/remote",
      server: { key: "remote", name: "Remote", kind: "remote" as const },
    }
    const local = {
      id: "shared",
      worktree: "/local",
      server: { key: "sidecar", name: "hailmary", kind: "current" as const },
    }

    const controls: PromptProjectControls = {
      available: [remote, local],
      directory: "/local/feature",
      projectID: "shared",
      server: "sidecar",
      select() {},
      add() {},
    }

    createRoot((dispose) => {
      const controller = createPromptProjectController({ controls: () => controls })
      expect(controller.selected()).toEqual(local)
      dispose()
    })
  })

  test("lists added projects in explicit order before discoverable projects by recent activity", () => {
    const local = { key: "sidecar", name: "hailmary", kind: "current" as const }
    const apollo = { key: "http://apollo:4096", name: "apollo", kind: "remote" as const }
    const entry = (id: string, server: typeof local | typeof apollo, active: number, used: boolean) => ({
      id,
      worktree: `/${id}`,
      server,
      used,
      time: { active },
    })

    // The same directory on two servers stays two rows.
    const controls: PromptProjectControls = {
      available: [
        entry("local-unused", local, 9, false),
        entry("local-used", local, 2, true),
        entry("opencode", local, 1, true),
        entry("apollo-unused", apollo, 5, false),
        entry("opencode", apollo, 3, true),
      ],
      directory: "/elsewhere",
      server: "sidecar",
      select() {},
      add() {},
    }

    createRoot((dispose) => {
      const controller = createPromptProjectController({ controls: () => controls })
      expect(controller.projects().map((project) => `${project.server?.name}:${project.id}`)).toEqual([
        "hailmary:local-used",
        "hailmary:opencode",
        "apollo:opencode",
        "hailmary:local-unused",
        "apollo:apollo-unused",
      ])
      dispose()
    })
  })
})
