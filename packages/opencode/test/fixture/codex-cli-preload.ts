// A separate CLI process cannot receive an injected function. Replace fetch
// completely, with no fallback, so every HTTP request is mocked and recorded.
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? "GET"
    await Bun.write(
      process.env.CODEX_MOCK_REQUESTS!,
      (await Bun.file(process.env.CODEX_MOCK_REQUESTS!).text()) +
        JSON.stringify({
          url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        }) +
        "\n",
    )
    if (url === "https://chatgpt.com/backend-api/wham/usage" && method === "GET")
      return Response.json({
        plan_type: "prolite",
        rate_limit: {
          allowed: true,
          primary_window: { used_percent: 40, limit_window_seconds: 604800 },
          secondary_window: null,
        },
      })
    if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" && method === "GET")
      return Response.json({
        credits: [
          {
            id: "synthetic-earliest",
            title: "Early",
            status: "available",
            reset_type: "codex_rate_limits",
            is_supported_by_plan: true,
            expires_at: "2099-01-01T00:00:00Z",
          },
          {
            id: "synthetic-explicit",
            title: "Later",
            status: "available",
            reset_type: "codex_rate_limits",
            is_supported_by_plan: true,
            expires_at: "2099-02-01T00:00:00Z",
          },
        ],
        available_count: 2,
      })
    if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume" && method === "POST")
      return Response.json({ code: "reset", windows_reset: 1 })
    throw new Error("Blocked unexpected request in isolated CLI test")
  },
  { preconnect() {} },
)
