import { describe, expect, test } from "bun:test"
import { formatCredits, formatPreview, formatUsage } from "../../src/cli/cmd/openai"

describe("cli.openai", () => {
  test("formats provider-reported usage and both allowance windows", () => {
    const output = formatUsage(
      {
        plan_type: "future_plan",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1_900_000_000 },
          secondary_window: { used_percent: 30, limit_window_seconds: 3600, reset_after_seconds: 1200 },
        },
        rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
      },
      1_800_000_000_000,
    )
    expect(output).toContain("Plan: future_plan")
    expect(output).toContain("Allowed: true")
    expect(output).toContain("Limit reached: false")
    expect(output).toContain("Duration: 7d")
    expect(output).toContain("Used: 10%")
    expect(output).toContain("Remaining: 90%")
    expect(output).toContain("Remaining: 70%")
    expect(output).toContain("less than 80% remaining")
    expect(output).not.toContain("provider fallback")
    expect(output).toContain("Applicable banked reset credits: 0")
  })

  test("prints full credit IDs and handles missing values safely", () => {
    const output = formatCredits(
      {
        available_count: 1,
        credits: [
          { id: "synthetic-credit-id", title: "Reset", status: "available", expires_at: "2030-01-01T00:00:00Z" },
        ],
      },
      Date.parse("2029-12-31T00:00:00Z"),
    )
    expect(output).toContain("synthetic-credit-id")
    expect(output).toContain("available")
    expect(output).toContain("1d remaining")
    expect(formatUsage({ rate_limit: { allowed: null } })).toContain("Allowed: unknown")
  })

  test("confirmation preview identifies the credit, account, expiration, both allowances, and refresh-period risk", () => {
    const output = formatPreview({
      accountID: "synthetic-account",
      credit: { id: "synthetic-credit", title: "Reset", expires_at: "2099-01-01T00:00:00Z" },
      usage: { rate_limit: { primary_window: { used_percent: 35 }, secondary_window: { used_percent: 5 } } },
      reason: "Exact selection",
      retry: false,
    })
    expect(output).toContain("synthetic-credit")
    expect(output).toContain("synthetic-account")
    expect(output).toContain("2099-01-01T00:00:00Z")
    expect(output).toContain("Remaining: 65%")
    expect(output).toContain("Remaining: 95%")
    expect(output).toContain("restart")
    expect(output).toContain("refresh period")
  })

  test("formats unknown fields and invalid or expired dates without misleading percentages or times", () => {
    expect(formatUsage({})).toContain("Banked reset credits: unknown")
    expect(formatUsage({ rate_limit: { primary_window: { used_percent: -5, reset_at: 1e99 } } })).not.toContain("105%")
    expect(formatCredits({ credits: [{ expires_at: "invalid" }] })).toContain("Expires: unknown")
    expect(formatCredits({ credits: [{ expires_at: "2000-01-01T00:00:00Z" }] })).toContain("(expired)")
    expect(formatUsage({ rate_limit: { primary_window: { reset_after_seconds: 60 } } }, 0)).toContain(
      "1970-01-01T00:01:00.000Z",
    )
  })
})
