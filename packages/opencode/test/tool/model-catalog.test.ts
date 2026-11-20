import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ModelCatalogTool, Parameters } from "@/tool/model-catalog"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import path from "node:path"

const id = ProviderV2.ID.make("acme")
const model = (name: string): Provider.Model => ({
  id: ModelV2.ID.make(name),
  providerID: id,
  name,
  api: { id: name, url: "", npm: "" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1, output: 1 },
  status: "active",
  options: { secret: "MODEL_SECRET" },
  headers: { Authorization: "HEADER_SECRET" },
  release_date: "",
  variants: { fast: { secret: "VARIANT_SECRET" } },
})
const entries: Record<string, Provider.Info> = {
  acme: {
    id,
    name: "Acme AI",
    source: "config",
    env: [],
    key: "KEY_SECRET",
    options: { secret: "OPTION_SECRET" },
    models: { alpha: model("alpha"), alphabet: model("alphabet"), beta: model("beta") },
  },
}
const it = testEffect(
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node, Provider.node]), [
    [Provider.node, Layer.mock(Provider.Service, { list: () => Effect.sync(() => entries) })],
  ]),
)
const live = testEffect(
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node, Provider.node, Config.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

describe("model catalog", () => {
  it.instance("searches current catalog safely with bounded output", () =>
    Effect.gen(function* () {
      const info = yield* ModelCatalogTool
      const tool = yield* info.init()
      const requests: string[] = []
      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (request) =>
          Effect.sync(() => {
            requests.push(request.permission)
          }),
      }
      const run = (params: typeof Parameters.Type) =>
        tool.execute(params, ctx).pipe(Effect.map((result) => JSON.parse(result.output)))
      const summary = yield* run({})
      expect(summary.providers).toEqual([{ id: "acme", name: "Acme AI", models: 3 }])
      expect(yield* run({ query: "   " })).toEqual(summary)
      const exact = yield* run({ query: "alpha" })
      expect(exact.models.map((item: { id: string }) => item.id)).toEqual(["acme/alpha", "acme/alphabet"])
      expect((yield* run({ query: "abt" })).models.map((item: { id: string }) => item.id)).toEqual(["acme/alphabet"])
      expect((yield* run({ query: "Acme AI", limit: 1 })).limited).toBe(true)
      expect((yield* run({ provider: "acme", variant: "fast" })).total).toBe(3)
      expect((yield* run({ provider: "acme", variant: "missing" })).models).toEqual([])
      expect((yield* run({ query: "not-found" })).total).toBe(0)
      expect((yield* run({ provider: "acm" })).suggestions[0].id).toBe("acme")
      expect((yield* run({ provider: "zzzz" })).suggestions[0].id).toBe("acme")
      expect(JSON.stringify(exact)).not.toContain("SECRET")
      expect(exact.models[0]).toMatchObject({
        id: "acme/alpha",
        variants: ["fast"],
        capabilities: { reasoning: true, tool: true, textInput: true, textOutput: true },
      })
      entries.acme.models.beta.name = "alpha"
      expect((yield* run({ query: "alpha" })).models.map((item: { id: string }) => item.id)).toEqual([
        "acme/alpha",
        "acme/beta",
        "acme/alphabet",
      ])
      expect((yield* run({ query: "acme/alpha" })).models[0].id).toBe("acme/alpha")
      expect((yield* run({ query: "alpha Acme AI" })).models.map((item: { id: string }) => item.id)).toContain(
        "acme/alpha",
      )
      entries.acme.models.beta.name = "beta"
      const long = "x".repeat(257)
      entries.acme.models.long = model(long)
      entries.acme.models.alpha.variants = { [long]: {}, fast: {} }
      entries.acme.models.alpha.name = "n".repeat(300)
      const longResult = yield* run({ provider: "acme" })
      expect(longResult.omittedIdentifiers).toBe(1)
      expect(longResult.models.some((item: { id: string }) => item.id === `acme/${long.slice(0, 256)}`)).toBe(false)
      expect(longResult.models[0].variants).toEqual(["fast"])
      expect(longResult.models[0].variantsLimited).toBe(true)
      expect(longResult.models[0].name.length).toBe(256)
      delete entries.acme.models.long
      entries.acme.models.alpha.name = "alpha"
      entries.acme.models.alpha.variants = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`variant-${i}`, { secret: "VARIANT_SECRET" }]),
      )
      const bounded = yield* run({ query: "alpha", limit: 1 })
      expect(bounded.models[0].variants).toHaveLength(20)
      expect(bounded.models[0].variantsLimited).toBe(true)
      entries.acme.models.alpha.variants = { fast: { secret: "VARIANT_SECRET" } }
      entries.acme.models.gamma = model("gamma")
      expect((yield* run({ query: "gamma" })).total).toBe(1)
      delete entries.acme.models.gamma
      expect(requests.every((request) => request === "model_catalog")).toBe(true)
    }),
  )
  it.instance("bounds provider summaries and model listings without inventing identifiers", () =>
    Effect.gen(function* () {
      const added = Array.from({ length: 25 }, (_, index) => `provider-${index.toString().padStart(2, "0")}`)
      for (const name of added) entries[name] = { ...entries.acme, id: ProviderV2.ID.make(name), name: "p".repeat(300) }
      const long = "z".repeat(257)
      entries[long] = { ...entries.acme, id: ProviderV2.ID.make(long) }
      for (const name of added) entries.acme.models[name] = model(name)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const name of added) {
            delete entries[name]
            delete entries.acme.models[name]
          }
          delete entries[long]
        }),
      )
      const info = yield* ModelCatalogTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const run = (params: typeof Parameters.Type) =>
        tool.execute(params, ctx).pipe(Effect.map((result) => JSON.parse(result.output)))
      const summary = yield* run({ limit: 20 })
      expect(summary.providers).toHaveLength(20)
      expect(summary.total).toBe(27)
      expect(summary.limited).toBe(true)
      expect(summary.omittedIdentifiers).toBe(1)
      expect(summary.providers[1].name.length).toBe(256)
      const list = yield* run({ provider: "acme", limit: 20 })
      expect(list.models).toHaveLength(20)
      expect(list.total).toBe(28)
      expect(list.limited).toBe(true)
    }),
  )
  live.instance("reads model changes after config reload", () =>
    Effect.gen(function* () {
      const context = yield* InstanceState.context
      const file = path.join(context.directory, "opencode.json")
      const config = yield* Config.Service
      const write = (name: string) =>
        Effect.promise(() =>
          Bun.write(
            file,
            JSON.stringify({
              enabled_providers: ["catalog-test"],
              provider: {
                "catalog-test": {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Catalog Test",
                  options: { apiKey: "SECRET" },
                  models: { [name]: { name, limit: { context: 8000, output: 1000 } } },
                },
              },
            }),
          ),
        )
      yield* write("before")
      const info = yield* ModelCatalogTool
      const tool = yield* info.init()
      const ctx: Tool.Context = {
        sessionID: SessionID.descending(),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const run = () =>
        tool.execute({ provider: "catalog-test" }, ctx).pipe(Effect.map((result) => JSON.parse(result.output)))
      expect((yield* run()).models.map((item: { id: string }) => item.id)).toEqual(["catalog-test/before"])
      yield* write("after")
      yield* config.reload(InstanceState.reload([context]))
      const after = yield* run()
      expect(after.models.map((item: { id: string }) => item.id)).toEqual(["catalog-test/after"])
      expect(JSON.stringify(after)).not.toContain("SECRET")
    }),
  )
})
