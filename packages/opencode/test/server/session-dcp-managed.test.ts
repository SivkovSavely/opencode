import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("DCP access obeys managed workspace boundaries in the actual HTTP route tree", async () => {
  await using tmp = await tmpdir()
  const slot = path.join(tmp.path, "slot")
  const other = path.join(tmp.path, "other")
  await mkdir(slot)
  await mkdir(other)
  const child = Bun.spawn(["bun", "test", "./test/server/fixtures/session-dcp-managed.ts"], {
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
      OPENCODE_MANAGED_PROFILE: "1",
      OPENCODE_MANAGED_WORKSPACE: slot,
      TEST_OTHER: other,
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
}, 30_000)
