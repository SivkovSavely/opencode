import { CodexReset } from "../../src/plugin/openai/reset"
import { CodexUsage } from "../../src/plugin/openai/usage"

// This worker has no network transport. Its only POST is an in-memory fake.
await CodexReset.redeem({
  directory: process.argv[2],
  accountID: "synthetic-account",
  yes: true,
  interactive: false,
  confirm: async () => false,
  api: CodexUsage.create({ access: "synthetic-access", accountId: "synthetic-account" }, async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body))
      process.send?.({ requestID: body.redeem_request_id })
      return new Promise<Response>(() => {})
    }
    if (url.endsWith("/usage")) return Response.json({})
    return Response.json({
      credits: [
        {
          id: "synthetic-early",
          expires_at: "2099-01-01T00:00:00Z",
          status: "available",
          reset_type: "codex_rate_limits",
          is_supported_by_plan: true,
        },
      ],
    })
  }),
})
