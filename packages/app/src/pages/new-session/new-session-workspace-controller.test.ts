import { describe, expect, test } from "bun:test"
import {
  createNewSessionWorkspaceListController,
  normalizeNewSessionWorktree,
  resolveNewSessionBranch,
  resolveNewSessionWorktree,
} from "./new-session-workspace-controller"

describe("new session workspace selection", () => {
  test("refreshes on each opening and replaces discovered workspaces", async () => {
    const current = {
      client: {},
      scope: "server",
      directory: "/project",
      project: { id: "project", worktree: "/project", vcs: "git", sandboxes: ["/project/registered"] },
    }
    const responses: ((directories: string[]) => void)[] = []
    let requests = 0
    const workspaces = createNewSessionWorkspaceListController({
      current: () => current,
      list: () => {
        requests++
        return new Promise<string[]>((resolve) => responses.push(resolve))
      },
    })

    expect(workspaces.workspaces()).toEqual(["/project/registered"])
    const first = workspaces.refresh()
    expect(workspaces.refresh()).toBe(first)
    expect(requests).toBe(1)
    responses[0]?.(["/project/registered", "/external/feature"])
    await first
    expect(workspaces.workspaces()).toEqual(["/project/registered", "/external/feature"])

    const second = workspaces.refresh()
    expect(requests).toBe(2)
    responses[1]?.([])
    await second
    expect(workspaces.workspaces()).toEqual([])
  })

  test("ignores stale results when the client or project changes", async () => {
    const firstClient = {}
    const secondClient = {}
    let current = {
      client: firstClient,
      scope: "local",
      directory: "/project",
      project: { id: "project", worktree: "/project", vcs: "git", sandboxes: ["/project/registered"] },
    }
    const responses: ((directories: string[]) => void)[] = []
    let requests = 0
    const workspaces = createNewSessionWorkspaceListController({
      current: () => current,
      list: () => {
        requests++
        return new Promise<string[]>((resolve) => responses.push(resolve))
      },
    })

    const cached = workspaces.refresh()
    responses[0]?.(["/project/first-client"])
    await cached
    expect(workspaces.workspaces()).toEqual(["/project/first-client"])

    const first = workspaces.refresh()
    current = {
      ...current,
      client: secondClient,
    }
    expect(workspaces.workspaces()).toEqual(["/project/registered"])

    const second = workspaces.refresh()
    expect(requests).toBe(3)
    responses[1]?.(["/project/stale"])
    await first
    expect(workspaces.workspaces()).toEqual(["/project/registered"])

    responses[2]?.(["/project/fresh"])
    await second
    expect(workspaces.workspaces()).toEqual(["/project/fresh"])

    current = {
      ...current,
      client: firstClient,
    }
    expect(workspaces.workspaces()).toEqual(["/project/registered"])

    const projectSwitch = workspaces.refresh()
    current = {
      ...current,
      project: {
        id: "next-project",
        worktree: "/next-project",
        vcs: "git",
        sandboxes: ["/next-project/registered"],
      },
    }
    responses[3]?.(["/project/stale"])
    await projectSwitch
    expect(workspaces.workspaces()).toEqual(["/next-project/registered"])
  })

  test("keeps fallback and last successful results when refresh fails", async () => {
    const current = {
      client: {},
      scope: "server",
      directory: "/project",
      project: { id: "project", worktree: "/project", vcs: "git", sandboxes: ["/project/registered"] },
    }
    let requests = 0
    const workspaces = createNewSessionWorkspaceListController({
      current: () => current,
      list: async () => {
        requests++
        if (requests === 1) return ["/project/registered", "/external/feature"]
        throw new Error("request failed")
      },
    })

    await workspaces.refresh()
    expect(workspaces.workspaces()).toEqual(["/project/registered", "/external/feature"])
    current.project.sandboxes.push("/project/new-registered")
    expect(workspaces.workspaces()).toEqual(["/project/registered", "/project/new-registered"])
    await workspaces.refresh()
    expect(workspaces.workspaces()).toEqual(["/project/registered", "/project/new-registered"])
  })

  test("uses main when the workspace bar is unavailable", () => {
    expect(
      resolveNewSessionWorktree({
        enabled: false,
        selected: "/project/feature",
        directory: "/project/feature",
        projectWorktree: "/project",
      }),
    ).toBe("main")
  })

  test("derives an existing worktree from the current directory", () => {
    expect(
      resolveNewSessionWorktree({ enabled: true, directory: "/project/feature", projectWorktree: "/project" }),
    ).toBe("/project/feature")
    expect(resolveNewSessionWorktree({ enabled: true, directory: "/project", projectWorktree: "/project" })).toBe(
      "main",
    )
  })

  test("falls back to local when the selected worktree disappears", () => {
    expect(
      resolveNewSessionWorktree({
        enabled: true,
        selected: "/external/removed",
        directory: "/project",
        projectWorktree: "/project",
        workspaces: ["/project/registered"],
      }),
    ).toBe("main")
    expect(
      resolveNewSessionWorktree({
        enabled: true,
        selected: "/project/registered",
        directory: "/project",
        projectWorktree: "/project",
        workspaces: ["/project/registered"],
      }),
    ).toBe("/project/registered")
  })

  test("normalizes main to the project root outside the main worktree", () => {
    expect(normalizeNewSessionWorktree("main", "/project/feature", "/project")).toBe("/project")
    expect(normalizeNewSessionWorktree("main", "/project", "/project")).toBe("main")
  })

  test("falls back to the local branch for main, create, and unknown worktrees", () => {
    const branch = (worktree: string) => (worktree === "/project/feature" ? "feature" : undefined)
    expect(resolveNewSessionBranch({ worktree: "main", local: "dev", worktreeBranch: branch })).toBe("dev")
    expect(resolveNewSessionBranch({ worktree: "create", local: "dev", worktreeBranch: branch })).toBe("dev")
    expect(resolveNewSessionBranch({ worktree: "/project/feature", local: "dev", worktreeBranch: branch })).toBe(
      "feature",
    )
    expect(resolveNewSessionBranch({ worktree: "/missing", local: "dev", worktreeBranch: branch })).toBe("dev")
  })
})
