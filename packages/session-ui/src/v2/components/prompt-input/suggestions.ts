import fuzzysort from "fuzzysort"
import type { PromptInputV2Suggestion } from "./types"

export async function promptInputV2Suggestions(
  query: string,
  items: PromptInputV2Suggestion[],
  searchFiles: (query: string) => PromptInputV2Suggestion[] | Promise<PromptInputV2Suggestion[]>,
) {
  const filter = (items: PromptInputV2Suggestion[], value: string) =>
    value ? fuzzysort.go(value, items, { keys: ["label", "description", "path"] }).map((result) => result.obj) : items
  if (query.startsWith("$"))
    return filter(
      items.filter((item) => item.kind === "skill"),
      query.slice(1),
    )
  const namespace = query.includes(":") ? query.slice(0, query.indexOf(":")) : undefined
  if (!namespace)
    return filter(
      ["file", "agent", "model", "variant", "reference", "resource"].map((name) => ({
        id: `namespace:${name}`,
        kind: "namespace" as const,
        label: `@${name}:`,
      })),
      query,
    )
  const scoped = items.filter((item) => item.kind === namespace)
  const search = query.slice(query.indexOf(":") + 1)
  if (namespace !== "file") return filter(scoped, search)
  const recent = scoped.filter((item) => item.recent)
  if (!search.trim()) return recent
  const seen = new Set(recent.map((item) => item.id))
  return [...filter(recent, search), ...(await searchFiles(search)).filter((item) => !seen.has(item.id))]
}
