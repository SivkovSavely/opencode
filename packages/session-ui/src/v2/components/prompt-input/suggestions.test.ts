import { describe, expect, test } from "bun:test"
import { promptInputV2Suggestions } from "./suggestions"
import type { PromptInputV2Suggestion } from "./types"

const items: PromptInputV2Suggestion[] = [
  { id: "m1", kind: "model", label: "Sonnet", description: "Anthropic (anthropic/claude-sonnet)" },
  { id: "m2", kind: "model", label: "Sonnet", description: "Bedrock (bedrock/claude-sonnet)" },
  { id: "s", kind: "skill", label: "$review" },
  { id: "c", kind: "command", label: "/review" },
  { id: "f", kind: "file", label: "src/file.ts", recent: true },
  { id: "v", kind: "variant", label: "default" },
]

describe("prompt input v2 suggestions", () => {
  test("bare at offers only fuzzy namespace names", async () => {
    expect((await promptInputV2Suggestions("", items, () => [])).map((item) => item.label)).toEqual([
      "@file:",
      "@agent:",
      "@model:",
      "@variant:",
      "@reference:",
      "@resource:",
    ])
    expect((await promptInputV2Suggestions("mdl", items, () => [])).map((item) => item.label)).toEqual(["@model:"])
  })

  test("scoped models match names, canonical IDs and provider disambiguation", async () => {
    expect(await promptInputV2Suggestions("model:", items, () => [])).toHaveLength(2)
    expect((await promptInputV2Suggestions("model:bedrock", items, () => [])).map((item) => item.id)).toEqual(["m2"])
    expect(await promptInputV2Suggestions("model:claude-sonnet", items, () => [])).toHaveLength(2)
    expect((await promptInputV2Suggestions("variant:", items, () => [])).map((item) => item.id)).toEqual(["v"])
  })

  test("skills stay separate from slash commands and namespaces", async () => {
    expect((await promptInputV2Suggestions("$rev", items, () => [])).map((item) => item.id)).toEqual(["s"])
  })

  test("file scope searches only its suffix and deduplicates recent files", async () => {
    const results = await promptInputV2Suggestions("file:src", items, (query) => {
      expect(query).toBe("src")
      return [items[4], { id: "f2", kind: "file", label: "src/other.ts" }]
    })
    expect(results.map((item) => item.id)).toEqual(["f", "f2"])
  })
})
