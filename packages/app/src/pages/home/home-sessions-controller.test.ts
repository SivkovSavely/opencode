import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { bookmarkedHomeSessions } from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
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

describe("Home bookmarked session records", () => {
  test("includes old sessions from closed projects, labels them, deduplicates, and sorts by update time", () => {
    const old = session({ id: "old", projectID: "closed", directory: "/closed", updated: 1 })
    const current = session({ id: "current", projectID: "closed", directory: "/closed", updated: 100 })
    const missing = session({ id: "missing-project", projectID: "unknown", directory: "/old-worktree", updated: 50 })
    const closedProject: LocalProject = {
      id: "closed",
      name: "Closed project",
      worktree: "/closed",
      expanded: false,
    }

    const records = buildHomeSessionRecords({
      sessions: () => bookmarkedHomeSessions([old, current, missing, old]),
      projectDirectories: () => [],
      projects: () => [closedProject],
      projectByID: () => new Map([["closed", closedProject]]),
      allDirectories: true,
    })

    expect(records.map((record) => record.session.id)).toEqual(["current", "missing-project", "old"])
    expect(records.map((record) => record.projectName)).toEqual(["Closed project", "old-worktree", "Closed project"])
  })
})
