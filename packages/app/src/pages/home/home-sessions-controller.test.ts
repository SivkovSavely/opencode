import { describe, expect, test } from "bun:test"
import type { Project, Session } from "@opencode-ai/sdk/v2/client"
import { bookmarkedHomeSessions } from "@/context/global-sync/home-session-index"
import { applyProjectAppearance } from "@/context/project-appearance"
import { buildHomeSessionRecords } from "./home-session-records"

const session = (input: { id: string; projectID: string; directory: string; updated: number; bookmarked?: boolean }) =>
  ({
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    bookmarked: input.bookmarked ?? true,
    directory: input.directory,
    title: input.id,
    version: "",
    time: { created: 1, updated: input.updated },
  }) satisfies Session

describe("Home session records", () => {
  test("includes old sessions from closed projects, labels them, deduplicates, and sorts by update time", () => {
    const old = session({ id: "old", projectID: "closed", directory: "/closed", updated: 1 })
    const current = session({ id: "current", projectID: "closed", directory: "/closed", updated: 100 })
    const missing = session({ id: "missing-project", projectID: "unknown", directory: "/old-worktree", updated: 50 })
    const closedProject: Project = {
      id: "closed",
      name: "Closed project",
      worktree: "/closed",
      sandboxes: [],
      time: { created: 1, updated: 1 },
    }

    const records = buildHomeSessionRecords({
      sessions: () => bookmarkedHomeSessions([old, current, missing, old]),
      projectDirectories: () => [],
      openedProjects: () => [],
      repositoryProjects: () => [closedProject],
      allDirectories: true,
    })

    expect(records.map((record) => record.session.id)).toEqual(["current", "missing-project", "old"])
    expect(records.map((record) => record.projectName)).toEqual(["Closed project", "old-worktree", "Closed project"])
  })

  test("uses directory appearance only for the exact opened worktree", () => {
    const repository: Project = {
      id: "repo",
      name: "Repository name",
      worktree: "/repo",
      sandboxes: ["/worktree", "/other-worktree"],
      icon: { override: "repository.png", color: "cyan" },
      time: { created: 1, updated: 1 },
    }
    const root = applyProjectAppearance(
      { ...repository, expanded: true },
      { name: "Root only", icon: "root.png", color: "purple" },
    )
    const worktree = applyProjectAppearance(
      { ...repository, worktree: "/worktree/", expanded: true },
      { name: "Exact worktree", icon: "worktree.png", color: "mint" },
    )
    const exact = session({ id: "exact", projectID: "repo", directory: "/worktree", updated: 2 })
    const other = session({ id: "other", projectID: "repo", directory: "/other-worktree", updated: 1 })

    const records = buildHomeSessionRecords({
      sessions: () => [other, exact],
      projectDirectories: () => [root.worktree, ...(root.sandboxes ?? []), worktree.worktree],
      openedProjects: () => [root, worktree],
      repositoryProjects: () => [repository],
    })

    expect(records).toEqual([
      { session: exact, project: worktree, projectName: "Exact worktree" },
      { session: other, project: { ...repository, expanded: false }, projectName: "Repository name" },
    ])
  })
})
