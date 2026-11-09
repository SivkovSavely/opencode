import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdir, readFile, stat, utimes } from "node:fs/promises"
import path from "node:path"
import { CodexUsage } from "../../src/plugin/openai/usage"
import { CodexReset } from "../../src/plugin/openai/reset"
import { withProcessLock } from "../../src/util/process-lock"
import { tmpdir } from "../fixture/fixture"

const accountID = "synthetic-account"
const now = Date.parse("2030-01-01T00:00:00Z")
const credit = (id = "synthetic-early", expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  title: "Synthetic full reset",
  status: "available",
  reset_type: "codex_rate_limits",
  is_supported_by_plan: true,
})

function fixture(
  options: {
    credits?: CodexUsage.Credit[]
    consume?: (body: { credit_id: string; redeem_request_id: string }) => Promise<Response>
  } = {},
) {
  const requests: Array<{ method: string; body?: { credit_id: string; redeem_request_id: string } }> = []
  const api = CodexUsage.create({ access: "synthetic-access", accountId: accountID }, async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method: init.method ?? "GET", ...(body && { body }) })
    if (init.method === "POST") {
      expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume")
      return options.consume ? options.consume(body) : Response.json({ code: "reset", windows_reset: 1 })
    }
    if (url.endsWith("/rate-limit-reset-credits"))
      return Response.json({ credits: options.credits ?? [credit()], available_count: 1 })
    if (url.endsWith("/usage"))
      return Response.json({
        plan_type: "prolite",
        rate_limit: { allowed: true, primary_window: { used_percent: 35, limit_window_seconds: 604800 } },
        rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
      })
    throw new Error("Unexpected mock request")
  })
  return { api, requests }
}

async function state(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"))
  expect(files).toHaveLength(1)
  const file = path.join(directory, files[0]!)
  return { file, raw: await readFile(file, "utf8"), data: await Bun.file(file).json() }
}

describe("Codex reset redemption (mock transport only)", () => {
  test("dry-run selects earliest eligible credit without POST, confirmation, or durable attempt", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "not-created")
    const mock = fixture({ credits: [credit("synthetic-late", "2099-02-01T00:00:00Z"), credit()] })
    const result = await CodexReset.redeem({
      api: mock.api,
      accountID,
      directory,
      dryRun: true,
      interactive: false,
      now: () => now,
      confirm: async () => {
        throw new Error("Must not prompt")
      },
    })
    expect(result.preview.credit.id).toBe("synthetic-early")
    expect(result.preview.reason.toLowerCase()).toContain("earliest")
    expect(result.response).toBeUndefined()
    expect(mock.requests.every((request) => request.method === "GET")).toBe(true)
    expect(await Bun.file(path.join(directory, "unused")).exists()).toBe(false)
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("requires affirmative interactive consent and refuses noninteractive execution without --yes", async () => {
    await using tmp = await tmpdir()
    const mock = fixture()
    const input = { api: mock.api, accountID, directory: tmp.path, now: () => now }
    await expect(CodexReset.redeem({ ...input, interactive: false, confirm: async () => true })).rejects.toThrow(
      "--yes",
    )
    await expect(
      CodexReset.redeem({
        ...input,
        interactive: true,
        confirm: async (preview) => {
          expect(preview.accountID).toBe(accountID)
          expect(preview.credit.expires_at).toBe("2099-01-01T00:00:00Z")
          expect(preview.usage.rate_limit?.primary_window?.used_percent).toBe(35)
          return false
        },
      }),
    ).rejects.toThrow(/cancel/i)
    expect(mock.requests.some((request) => request.method === "POST")).toBe(false)
    expect((await readdir(tmp.path)).filter((file) => file.endsWith(".json"))).toEqual([])
    const result = await CodexReset.redeem({ ...input, interactive: true, confirm: async () => true })
    expect(result.response?.code).toBe("reset")
  })

  test("persists a private UUID before POST and never repeats a completed credit", async () => {
    await using tmp = await tmpdir()
    const mock = fixture({
      consume: async (body) => {
        const saved = await state(tmp.path)
        expect(saved.data.account_id).toBe(accountID)
        expect(saved.data.attempts[0].credit_id).toBe("synthetic-early")
        expect(saved.data.attempts[0].redeem_request_id).toBe(body.redeem_request_id)
        expect(body.redeem_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(saved.data.attempts[0].code).toBeUndefined()
        expect((await stat(saved.file)).mode & 0o777).toBe(0o600)
        expect((await stat(tmp.path)).mode & 0o777).toBe(0o700)
        expect(saved.raw).not.toContain("synthetic-access")
        return Response.json({ code: "reset", windows_reset: 2 })
      },
    })
    const input = {
      api: mock.api,
      accountID,
      directory: tmp.path,
      yes: true,
      interactive: false,
      confirm: async () => false,
    }
    const result = await CodexReset.redeem(input)
    expect(result.response).toEqual({ code: "reset", windows_reset: 2 })
    await expect(CodexReset.redeem(input)).rejects.toThrow(/already|completed/i)
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1)
    expect((await state(tmp.path)).data.attempts[0].code).toBe("reset")
  })

  test("reconciles ambiguous attempts with the same UUID, even if the credit disappeared", async () => {
    await using tmp = await tmpdir()
    const first = fixture({
      consume: async () => {
        throw new Error("secret token in network failure")
      },
    })
    const input = { accountID, directory: tmp.path, yes: true, interactive: false, confirm: async () => false }
    const failure = await CodexReset.redeem({ ...input, api: first.api }).catch((error: unknown) => error)
    expect(String(failure)).toContain("indeterminate")
    expect(String(failure)).not.toContain("secret token")
    const saved = (await state(tmp.path)).data.attempts[0]
    const other = fixture({ credits: [credit("synthetic-other")] })
    await expect(CodexReset.redeem({ ...input, api: other.api, creditID: "synthetic-other" })).rejects.toThrow(
      /unresolved|pending/i,
    )
    expect(other.requests.some((request) => request.method === "POST")).toBe(false)
    const retry = fixture({ credits: [] })
    const result = await CodexReset.redeem({ ...input, api: retry.api })
    expect(result.preview.retry).toBe(true)
    expect(retry.requests.find((request) => request.method === "POST")?.body).toEqual({
      credit_id: "synthetic-early",
      redeem_request_id: saved.redeem_request_id,
    })
    expect((await state(tmp.path)).data.attempts).toHaveLength(1)
  })

  test("dry-run of a pending attempt neither resolves it nor generates a new UUID", async () => {
    await using tmp = await tmpdir()
    const mock = fixture({ consume: async () => new Response("ambiguous", { status: 500 }) })
    const input = {
      api: mock.api,
      accountID,
      directory: tmp.path,
      yes: true,
      interactive: false,
      confirm: async () => false,
    }
    await expect(CodexReset.redeem(input)).rejects.toThrow(/indeterminate/)
    const before = await state(tmp.path)
    const preview = await CodexReset.redeem({ ...input, dryRun: true })
    expect(preview.preview.retry).toBe(true)
    expect((await state(tmp.path)).raw).toBe(before.raw)
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })

  test.each([
    { name: "authentication error", response: () => new Response("synthetic-access-secret", { status: 401 }) },
    { name: "server error", response: () => new Response("synthetic-access-secret", { status: 503 }) },
    { name: "malformed JSON", response: () => new Response("synthetic-access-secret") },
    { name: "unexpected code", response: () => Response.json({ code: "future-code" }) },
  ])("retains the UUID after $name", async ({ response }) => {
    await using tmp = await tmpdir()
    const mock = fixture({ consume: async () => response() })
    const input = {
      api: mock.api,
      accountID,
      directory: tmp.path,
      yes: true,
      interactive: false,
      confirm: async () => false,
    }
    await expect(CodexReset.redeem(input)).rejects.toThrow(/indeterminate/)
    const pending = (await state(tmp.path)).data.attempts[0]
    await expect(CodexReset.redeem(input)).rejects.toThrow(/indeterminate/)
    expect(
      mock.requests.filter((request) => request.method === "POST").map((request) => request.body?.redeem_request_id),
    ).toEqual([pending.redeem_request_id, pending.redeem_request_id])
    expect((await state(tmp.path)).data.attempts).toHaveLength(1)
  })

  test("corrupt state fails closed rather than discarding an unresolved request", async () => {
    await using tmp = await tmpdir()
    const mock = fixture({
      consume: async () => {
        throw new Error("lost response")
      },
    })
    const input = {
      api: mock.api,
      accountID,
      directory: tmp.path,
      yes: true,
      interactive: false,
      confirm: async () => false,
    }
    await expect(CodexReset.redeem(input)).rejects.toThrow(/indeterminate/)
    await Bun.write((await state(tmp.path)).file, "invalid-state")
    await expect(CodexReset.redeem(input)).rejects.toThrow(/Invalid redemption state/)
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })

  test.each(["nothing_to_reset", "no_credit", "already_redeemed"] as const)(
    "records known outcome %s",
    async (code) => {
      await using tmp = await tmpdir()
      const mock = fixture({ consume: async () => Response.json({ code }) })
      const input = {
        api: mock.api,
        accountID,
        directory: tmp.path,
        yes: true,
        interactive: false,
        confirm: async () => false,
      }
      expect((await CodexReset.redeem(input)).response?.code).toBe(code)
      const first = (await state(tmp.path)).data.attempts[0]
      if (code !== "nothing_to_reset") {
        await expect(CodexReset.redeem(input)).rejects.toThrow(/already|completed/i)
        expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1)
        return
      }
      await CodexReset.redeem(input)
      const attempts = (await state(tmp.path)).data.attempts
      expect(attempts).toHaveLength(2)
      expect(attempts[1].redeem_request_id).not.toBe(first.redeem_request_id)
      expect(attempts[0].code).toBe("nothing_to_reset")
    },
  )

  test("simultaneous invocations cannot initiate separate attempts for the same credit", async () => {
    await using tmp = await tmpdir()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mock = fixture({
      consume: async () => {
        entered.resolve()
        await release.promise
        return Response.json({ code: "reset" })
      },
    })
    const input = {
      api: mock.api,
      accountID,
      directory: tmp.path,
      yes: true,
      interactive: false,
      confirm: async () => false,
    }
    const first = CodexReset.redeem(input)
    await entered.promise
    const second = CodexReset.redeem(input).catch((error: unknown) => error)
    release.resolve()
    await first
    expect(await second).toBeInstanceOf(CodexReset.ResetError)
    expect(mock.requests.filter((request) => request.method === "POST")).toHaveLength(1)
  })

  test("a suspended process retains ownership and crash recovery preserves the pending UUID", async () => {
    await using tmp = await tmpdir()
    const ready = Promise.withResolvers<string>()
    const worker = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../fixture/codex-reset-worker.ts"), tmp.path],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
        ipc(message: unknown) {
          if (typeof message === "object" && message && "requestID" in message && typeof message.requestID === "string")
            ready.resolve(message.requestID)
        },
      },
    )
    try {
      const requestID = await Promise.race([
        ready.promise,
        worker.exited.then(async () => {
          throw new Error(`Worker exited before request: ${await new Response(worker.stderr).text()}`)
        }),
      ])
      if (process.platform !== "win32") process.kill(worker.pid, "SIGSTOP")
      const old = new Date(Date.now() - 120_000)
      const locks = (await readdir(tmp.path)).filter((file) => file.endsWith(".lock.sqlite"))
      expect(locks).toHaveLength(1)
      await utimes(path.join(tmp.path, locks[0]!), old, old)
      let entered = false
      await expect(
        withProcessLock(
          `openai-reset:${createHash("sha256").update(accountID).digest("hex")}`,
          async () => {
            entered = true
          },
          { directory: tmp.path, timeoutMs: 50 },
        ),
      ).rejects.toThrow(/Timed out/)
      expect(entered).toBe(false)
      worker.kill("SIGKILL")
      await worker.exited
      const mock = fixture({ credits: [] })
      await CodexReset.redeem({
        api: mock.api,
        accountID,
        directory: tmp.path,
        yes: true,
        interactive: false,
        confirm: async () => false,
      })
      expect(mock.requests.find((request) => request.method === "POST")?.body?.redeem_request_id).toBe(requestID)
      expect((await state(tmp.path)).data.attempts).toHaveLength(1)
    } finally {
      worker.kill()
      await worker.exited
    }
  })
})
