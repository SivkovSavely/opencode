import { expect, test } from "bun:test"

test("managed attachments are rejected without a configured workspace", async () => {
  const env: Record<string, string | undefined> = { ...process.env, OPENCODE_MANAGED_PROFILE: "1" }
  delete env.OPENCODE_MANAGED_WORKSPACE
  const child = Bun.spawn(
    ["bun", "test", "test/session/prompt.test.ts", "-t", "managed file attachments are rejected before resolution"],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
}, 60_000)

test("managed structured subtasks are rejected", async () => {
  const env: Record<string, string | undefined> = { ...process.env, OPENCODE_MANAGED_PROFILE: "1" }
  delete env.OPENCODE_MANAGED_WORKSPACE
  const child = Bun.spawn(
    ["bun", "test", "test/session/prompt.test.ts", "-t", "managed structured subtasks are rejected before admission"],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
}, 60_000)
