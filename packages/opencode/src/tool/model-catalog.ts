import { Effect, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Model or provider search text",
  }),
  provider: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Exact provider ID",
  }),
  variant: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Exact variant name",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))).annotate({
    description: "Maximum results, default 10",
  }),
})

// Return a deterministic rank for exact, substring and subsequence matches.
function rank(query: string, values: string[]) {
  const scores = values.map((value) => {
    const text = value.toLowerCase().slice(0, 512)
    if (text === query) return 0
    if (text.includes(query)) return 1
    let index = 0
    for (const char of text) if (char === query[index]) index++
    return index === query.length ? 2 : 3
  })
  return Math.min(...scores)
}

export const ModelCatalogTool = Tool.define(
  "model_catalog",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return {
      description:
        "Search the configured model catalog to obtain exact model IDs and variant names instead of guessing them. Results describe local catalog metadata, not confirmed remote availability. Call without filters for provider counts.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "model_catalog", patterns: ["*"], always: ["*"], metadata: {} })
          const providers = Object.values(yield* provider.list()).sort((a, b) => a.id.localeCompare(b.id))
          const limit = params.limit ?? 10
          const query = params.query?.trim().toLowerCase() ?? ""
          const selected = params.provider ? providers.find((item) => item.id === params.provider) : undefined
          const eligible = providers.filter((item) => item.id.length <= 256)
          const summary = (item: Provider.Info) => ({
            id: item.id,
            name: item.name.slice(0, 256),
            models: Object.keys(item.models).length,
          })
          if (params.provider && !selected) {
            const requested = params.provider.toLowerCase()
            const suggestions = eligible
              .map((item) => ({ item, score: rank(requested, [item.id, item.name]) }))
              .sort((a, b) => a.score - b.score || a.item.id.localeCompare(b.item.id))
              .slice(0, limit)
              .map((entry) => summary(entry.item))
            return {
              title: "Model catalog",
              metadata: {},
              output: JSON.stringify({
                error: "Unknown provider",
                suggestions,
                omittedIdentifiers: providers.length - eligible.length,
                note: "Provider IDs longer than 256 characters are omitted.",
              }),
            }
          }
          if (!query && !params.provider && !params.variant) {
            return {
              title: "Model catalog",
              metadata: {},
              output: JSON.stringify({
                note: "Configured catalog metadata; remote availability is not verified. Provider IDs longer than 256 characters are omitted.",
                providers: eligible.slice(0, limit).map(summary),
                total: providers.length,
                returned: Math.min(eligible.length, limit),
                limited: providers.length > Math.min(eligible.length, limit),
                omittedIdentifiers: providers.length - eligible.length,
              }),
            }
          }
          const matches = (selected ? [selected] : providers)
            .flatMap((item) =>
              Object.values(item.models).flatMap((model) => {
                const variants = Object.keys(model.variants ?? {}).sort()
                if (params.variant && !variants.includes(params.variant)) return []
                const path = `${item.id}/${model.id}`.toLowerCase()
                const fields = [model.id, model.name, item.id, item.name].map((value) => value.toLowerCase())
                const score =
                  !query || path === query || fields[0] === query
                    ? 0
                    : fields.slice(1).includes(query)
                      ? 1
                      : path.includes(query) || fields.some((value) => value.includes(query))
                        ? 2
                        : query.split(/\s+/).every((token) => fields.some((value) => value.includes(token)))
                          ? 3
                          : rank(query, fields) === 2
                            ? 4
                            : 5
                if (score === 5) return []
                return [{ item, model, variants, score }]
              }),
            )
            .sort(
              (a, b) => a.score - b.score || a.item.id.localeCompare(b.item.id) || a.model.id.localeCompare(b.model.id),
            )
          const selectable = matches.filter(({ item, model }) => item.id.length <= 256 && model.id.length <= 256)
          const models = selectable.slice(0, limit).map(({ item, model, variants }) => ({
            id: `${item.id}/${model.id}`,
            name: model.name.slice(0, 256),
            variants: variants.filter((value) => value.length <= 256).slice(0, 20),
            variantsLimited: variants.length > 20 || variants.some((value) => value.length > 256),
            capabilities: {
              reasoning: model.capabilities.reasoning,
              tool: model.capabilities.toolcall,
              textInput: model.capabilities.input.text,
              textOutput: model.capabilities.output.text,
            },
          }))
          return {
            title: "Model catalog",
            metadata: {},
            output: JSON.stringify({
              note: "Configured catalog metadata; remote availability is not verified. Provider and model IDs longer than 256 characters are omitted.",
              models,
              total: matches.length,
              returned: models.length,
              limited: matches.length > models.length,
              omittedIdentifiers: matches.length - selectable.length,
            }),
          }
        }),
    }
  }),
)
