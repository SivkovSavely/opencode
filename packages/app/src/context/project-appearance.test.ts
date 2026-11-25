import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { applyProjectAppearance, createProjectAppearance } from "./project-appearance"
import type { ProjectAppearance } from "@opencode-ai/schema/project-appearance"

test("late bootstrap and save responses cannot revert a newer server snapshot", async () => {
  const bootstrap = Promise.withResolvers<ProjectAppearance.Snapshot>()
  const saved = Promise.withResolvers<ProjectAppearance.Snapshot>()
  const snapshot = (revision: number, name: string): ProjectAppearance.Snapshot => ({
    revision,
    entries: { "/repo/app": { name } },
  })
  const requests = [bootstrap.promise, Promise.resolve(snapshot(3, "remote edit"))]
  const { appearance, dispose } = createRoot((dispose) => ({
    appearance: createProjectAppearance({ list: () => requests.shift()!, update: () => saved.promise }),
    dispose,
  }))
  try {
    const first = appearance.refresh()
    const write = appearance.update("/repo/app", { name: "local edit" })
    await appearance.refresh()
    bootstrap.resolve(snapshot(1, "old name"))
    saved.resolve(snapshot(2, "local edit"))
    await Promise.all([first, write])
    expect(appearance.get("/repo/app/")).toEqual({ name: "remote edit" })
  } finally {
    dispose()
  }
})

test("directory overrides take precedence over legacy caches and new shared metadata, including explicit clears", () => {
  const project = {
    worktree: "/repo/app",
    expanded: true,
    id: "one-repo",
    name: "Shared name",
    commands: { start: "npm start" },
    icon: { override: "shared.png", url: "auto.png", color: "cyan" },
  }
  const patch = { name: null, icon: null, color: "purple" }
  const result = applyProjectAppearance(project, patch)
  expect(result).toMatchObject({
    worktree: "/repo/app",
    id: "one-repo",
    expanded: true,
    commands: { start: "npm start" },
    icon: { color: "purple" },
  })
  expect(result.name).toBeUndefined()
  expect(result.icon?.override).toBeUndefined()
  expect(result.icon?.url).toBeFalsy()
  expect(applyProjectAppearance({ ...project, name: "New shared name" }, patch).name).toBeUndefined()
  expect(applyProjectAppearance({ ...project, worktree: "/elsewhere/app" }, undefined)).toMatchObject({
    name: "Shared name",
    icon: project.icon,
  })
})
