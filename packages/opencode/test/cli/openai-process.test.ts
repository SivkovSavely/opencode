import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function run(
  home: string,
  args: string[],
  auth: object = {
    openai: {
      type: "oauth",
      access: "synthetic-cli-access-secret",
      refresh: "synthetic-cli-refresh-secret",
      accountId: "synthetic-cli-account",
      expires: Date.now() + 3600_000,
    },
  },
) {
  const requests = path.join(home, "requests.jsonl")
  await Bun.write(requests, "")
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.resolve(import.meta.dir, "../fixture/codex-cli-preload.ts"),
      path.resolve(import.meta.dir, "../../src/index.ts"),
      ...args,
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        OPENCODE_AUTH_CONTENT: JSON.stringify(auth),
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_CONTENT: "{}",
        CODEX_MOCK_REQUESTS: requests,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  )
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  try {
    return {
      exit: await proc.exited,
      stdout: await stdout,
      stderr: await stderr,
      requests: (await Bun.file(requests).text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    }
  } finally {
    proc.kill()
    await proc.exited
  }
}

describe("OpenAI CLI (all HTTP blocked or mocked, synthetic credentials)", () => {
  test("usage and list emit undecorated JSON and both aliases retain read-only behavior", async () => {
    await using tmp = await tmpdir()
    const usage = await run(tmp.path, ["provider", "openai", "usage", "--json"])
    expect(usage.exit).toBe(0)
    expect(JSON.parse(usage.stdout).plan_type).toBe("prolite")
    expect(usage.requests).toHaveLength(1)
    expect(usage.requests[0].method).toBe("GET")
    const list = await run(tmp.path, ["providers", "openai", "reset", "list", "--json"])
    expect(list.exit).toBe(0)
    expect(JSON.parse(list.stdout).credits.map((credit: { id: string }) => credit.id)).toEqual([
      "synthetic-earliest",
      "synthetic-explicit",
    ])
    expect(list.requests).toHaveLength(1)
    expect(list.requests[0].method).toBe("GET")
    const existing = await run(tmp.path, ["providers", "list"], {})
    expect(existing.exit).toBe(0)
    expect(existing.stdout + existing.stderr).toContain("Credentials")
    expect(existing.requests).toEqual([])
    const authAlias = await run(tmp.path, ["auth", "list"], {})
    expect(authAlias.exit).toBe(0)
  }, 30_000)

  test("noninteractive refusal and API-key rejection do not send HTTP requests or disclose credentials", async () => {
    await using tmp = await tmpdir()
    const refused = await run(tmp.path, ["provider", "openai", "reset", "redeem"])
    expect(refused.exit).not.toBe(0)
    expect(refused.stderr).toContain("--yes")
    expect(refused.requests).toEqual([])
    const api = await run(tmp.path, ["provider", "openai", "usage", "--json"], {
      openai: { type: "api", key: "synthetic-api-secret" },
    })
    expect(api.exit).not.toBe(0)
    expect(api.requests).toEqual([])
    expect(api.stderr + api.stdout).not.toContain("synthetic-api-secret")
    expect(refused.stderr + refused.stdout).not.toContain("synthetic-cli-access-secret")
    expect(refused.stderr + refused.stdout).not.toContain("synthetic-cli-refresh-secret")
  }, 30_000)

  test("hyphenated selection and dry-run flags work; --yes POST goes only to the in-memory mock", async () => {
    await using tmp = await tmpdir()
    const preview = await run(tmp.path, [
      "provider",
      "openai",
      "reset",
      "redeem",
      "--dry-run",
      "--credit-id",
      "synthetic-explicit",
    ])
    expect(preview.exit).toBe(0)
    expect(preview.stdout).toContain("[synthetic-explicit]")
    expect(preview.stdout).toContain("Remaining: 60%")
    expect(preview.requests.map((request) => request.method)).toEqual(["GET", "GET"])
    const redeemed = await run(tmp.path, [
      "provider",
      "openai",
      "reset",
      "redeem",
      "--credit-id",
      "synthetic-explicit",
      "--yes",
    ])
    expect(redeemed.exit).toBe(0)
    expect(redeemed.stdout).toContain("Reset completed")
    expect(redeemed.requests.map((request) => request.method)).toEqual(["GET", "GET", "POST"])
    expect(redeemed.requests[2].body.credit_id).toBe("synthetic-explicit")
    expect(redeemed.requests[2].body.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(redeemed.stderr + redeemed.stdout).not.toContain("synthetic-cli-access-secret")
  }, 30_000)
})
