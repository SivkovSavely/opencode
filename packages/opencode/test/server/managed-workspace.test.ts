import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("managed workspace routing is isolated at import time", async () => {
  await using tmp = await tmpdir()
  const slot = path.join(tmp.path, "slot")
  const other = path.join(tmp.path, "other")
  const alias = path.join(tmp.path, "alias")
  await mkdir(slot)
  await mkdir(other)
  await symlink(slot, alias)
  const child = Bun.spawn(["bun", "test", "./test/server/fixtures/managed-workspace.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tmp.path,
      OPENCODE_TEST_HOME: tmp.path,
      OPENCODE_DB: path.join(tmp.path, "test.db"),
      XDG_CONFIG_HOME: tmp.path,
      XDG_DATA_HOME: tmp.path,
      XDG_CACHE_HOME: tmp.path,
      XDG_STATE_HOME: tmp.path,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_MANAGED_PROFILE: "1",
      OPENCODE_MANAGED_WORKSPACE: slot,
      TEST_OTHER: other,
      TEST_ALIAS: alias,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
})

test("managed workspace rejects noncanonical startup configuration", async () => {
  await using tmp = await tmpdir()
  const alias = path.join(tmp.path, "alias")
  await symlink(tmp.path, alias)
  for (const workspace of ["relative", path.join(tmp.path, "missing"), alias]) {
    const child = Bun.spawn(["bun", "-e", 'import "./src/server/managed-workspace"'], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_MANAGED_PROFILE: "1", OPENCODE_MANAGED_WORKSPACE: workspace },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(stderr).toContain("OPENCODE_MANAGED_WORKSPACE")
  }
})
