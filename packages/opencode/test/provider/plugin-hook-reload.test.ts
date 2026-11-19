import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { Npm } from "@opencode-ai/core/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit, Layer } from "effect"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Plugin.node, Config.node, CrossSpawnSpawner.node]), [
    [
      Auth.node,
      Layer.mock(Auth.Service)({
        all: () => Effect.succeed({ openai: new Auth.Api({ type: "api", key: "test-key" }) }),
        get: (id) => Effect.succeed(id === "openai" ? new Auth.Api({ type: "api", key: "test-key" }) : undefined),
      }),
    ],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

it.instance("provider hooks retain resources across reloads without retaining disk model overrides", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = path.join(ctx.directory, "opencode.json")
    const source = path.join(ctx.directory, "plugin.ts")
    const calls = path.join(ctx.directory, "calls.jsonl")
    yield* Effect.promise(() =>
      Bun.write(
        source,
        `
        import { appendFile } from "node:fs/promises";
        const record = (event) => appendFile(${JSON.stringify(calls)}, JSON.stringify(event) + "\\n");
        export default async () => {
          await record("init");
          return {
            provider: {
              id: "openai",
              async models(provider) {
                await record("models");
                const base = provider.models["gpt-5.4"];
                return {
                  ...provider.models,
                  "plugin-model": {
                    ...base,
                    id: "plugin-model",
                    name: "Plugin model",
                    options: { plugin: true, callback: () => "model callback" },
                    variants: { plugin: { reasoningEffort: "low" } },
                  },
                };
              },
            },
            auth: {
              provider: "openai",
              methods: [],
              async loader(getAuth) {
                await record("loader");
                const transport = new class Transport {}();
                return {
                  transport,
                  credentialProvider: getAuth,
                  headers: { "x-plugin": "retained" },
                  fetch: async (input, init) => {
                    const auth = await getAuth();
                    await record({ url: String(input), key: auth.key, disk: new Headers(init.headers).get("x-disk") });
                    return Response.json({
                      id: "resp_test", object: "response", created_at: 0, model: "gpt-5.4",
                      status: "completed", error: null, incomplete_details: null,
                      output: [{
                        type: "message", role: "assistant", id: "msg_test", status: "completed",
                        content: [{ type: "output_text", text: "plugin response", annotations: [] }],
                      }],
                      usage: {
                        input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
                        output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2,
                      },
                    });
                  },
                };
              },
            },
            async dispose() { await record("dispose"); },
          };
        };
        `,
      ),
    )
    const disk = {
      plugin: [pathToFileURL(source).href],
      provider: {
        openai: {
          options: { baseURL: "https://before.test/v1", diskOnly: true, headers: { "x-disk": "before" } },
          models: {
            "plugin-model": {
              name: "Disk before",
              options: { diskOnly: true },
              headers: { "x-model-disk": "before" },
              variants: { plugin: { disabled: true }, disk: { reasoningEffort: "high" } },
            },
            "disk-only": { name: "Disk only" },
          },
        },
      },
    }
    yield* Effect.promise(() => Bun.write(file, JSON.stringify(disk)))
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const provider = yield* Provider.Service
    const hooks = yield* plugin.list()
    const first = yield* provider.getProvider(ProviderV2.ID.openai)
    const modelID = ModelV2.ID.make("plugin-model")
    const firstLanguage = yield* provider.getLanguage(yield* provider.getModel(ProviderV2.ID.openai, modelID))
    expect(first.models[modelID].name).toBe("Disk before")
    expect(first.models[modelID].variants?.plugin).toBeUndefined()
    expect(first.models["disk-only"]).toBeDefined()

    const reject = yield* InstanceState.make(
      () =>
        Effect.gen(function* () {
          if ((yield* config.get()).username === "reject") return yield* Effect.die(new Error("reject staged reload"))
        }),
      { reloadable: true },
    )
    yield* InstanceState.get(reject)

    const next = {
      provider: {
        openai: {
          options: { baseURL: "https://after.test/v1", headers: { "x-disk": "after" } },
          models: {
            "plugin-model": {
              name: "Disk after",
              options: { after: true },
              variants: { disk: { reasoningEffort: "medium" } },
            },
            added: { name: "Added on reload" },
          },
        },
      },
    }
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ ...next, username: "reject" })))
    const failed = yield* config.reload(InstanceState.reload([ctx])).pipe(Effect.exit)
    expect(Exit.isFailure(failed) && String(Cause.squash(failed.cause))).toContain("reject staged reload")
    expect(yield* provider.getProvider(ProviderV2.ID.openai)).toBe(first)
    expect(yield* provider.getLanguage(yield* provider.getModel(ProviderV2.ID.openai, modelID))).toBe(firstLanguage)
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toBe('"init"\n"models"\n"loader"\n')

    yield* Effect.promise(() => Bun.write(file, JSON.stringify(next)))
    yield* config.reload(InstanceState.reload([ctx]))
    const after = yield* provider.getProvider(ProviderV2.ID.openai)
    expect(after).not.toBe(first)
    expect(after.options.fetch).toBe(first.options.fetch)
    expect(after.options.transport).toBe(first.options.transport)
    expect(after.options.credentialProvider).toBe(first.options.credentialProvider)
    expect(yield* Effect.promise(() => after.options.credentialProvider())).toMatchObject({ key: "test-key" })
    expect(after.options.diskOnly).toBeUndefined()
    expect(after.models[modelID]).toMatchObject({
      name: "Disk after",
      options: { plugin: true, after: true },
      variants: { plugin: { reasoningEffort: "low" }, disk: { reasoningEffort: "medium" } },
    })
    expect(after.models[modelID].options.diskOnly).toBeUndefined()
    expect(after.models[modelID].options.callback()).toBe("model callback")
    expect(after.models[modelID].headers["x-model-disk"]).toBeUndefined()
    expect(after.models["disk-only"]).toBeUndefined()
    expect(after.models.added.name).toBe("Added on reload")
    const language = yield* provider.getLanguage(yield* provider.getModel(ProviderV2.ID.openai, modelID))
    expect(language).not.toBe(firstLanguage)
    const response = yield* Effect.promise(() =>
      language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] }),
    )
    expect(response.content).toMatchObject([{ type: "text", text: "plugin response" }])
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toContain(
      JSON.stringify({ url: "https://after.test/v1/responses", key: "test-key", disk: "after" }),
    )

    yield* config.reload(InstanceState.reload([ctx]))
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ provider: { openai: {} } })))
    yield* config.reload(InstanceState.reload([ctx]))
    const removed = yield* provider.getProvider(ProviderV2.ID.openai)
    expect(removed.models[modelID].name).toBe("Plugin model")
    expect(removed.models[modelID].options.after).toBeUndefined()
    expect(removed.models[modelID].variants).toEqual({ plugin: { reasoningEffort: "low" } })
    expect(removed.models.added).toBeUndefined()
    expect(removed.options.baseURL).toBeUndefined()
    expect(removed.options.headers).toEqual({ "x-plugin": "retained" })
    expect(removed.options.fetch).toBe(first.options.fetch)
    expect(removed.options.transport).toBe(first.options.transport)
    expect(yield* plugin.list()).toBe(hooks)
    const events = (yield* Effect.promise(() => Bun.file(calls).text())).trim().split("\n")
    expect(events.filter((event) => event === '"models"')).toHaveLength(1)
    expect(events.filter((event) => event === '"loader"')).toHaveLength(1)
    expect(events).not.toContain('"dispose"')

    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ plugin: disk.plugin, provider: { openai: {} } })))
    const store = yield* InstanceStore.Service
    yield* store.dispose(ctx)
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toEndWith('"dispose"\n')
    const fresh = yield* provider.getProvider(ProviderV2.ID.openai)
    expect(fresh.options.fetch).not.toBe(first.options.fetch)
    expect(fresh.options.transport).not.toBe(first.options.transport)
    const restarted = (yield* Effect.promise(() => Bun.file(calls).text())).trim().split("\n")
    expect(restarted.filter((event) => event === '"models"')).toHaveLength(2)
    expect(restarted.filter((event) => event === '"loader"')).toHaveLength(2)
  }),
)

it.instance("built-in provider loaders rederive config-dependent defaults after reload", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = path.join(ctx.directory, "opencode.json")
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          provider: {
            "amazon-bedrock": { options: { apiKey: "test", region: "us-east-1", endpoint: "https://before.test" } },
            "google-vertex": { options: { project: "before", location: "eu" } },
          },
        }),
      ),
    )
    expect((yield* provider.getProvider(ProviderV2.ID.amazonBedrock)).options.baseURL).toBe("https://before.test")
    const model = yield* provider.getModel(ProviderV2.ID.googleVertex, ModelV2.ID.make("claude-sonnet-4-6@default"))
    const before = yield* provider.getLanguage(model)
    expect((before as unknown as { config: { baseURL: string } }).config.baseURL).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/before/locations/eu/publishers/anthropic/models",
    )
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          provider: {
            "amazon-bedrock": { options: { apiKey: "test", region: "eu-west-1" } },
            "google-vertex": { options: { project: "after", location: "us" } },
          },
        }),
      ),
    )
    yield* config.reload(InstanceState.reload([ctx]))
    const bedrock = yield* provider.getProvider(ProviderV2.ID.amazonBedrock)
    expect(bedrock.options.region).toBe("eu-west-1")
    expect(bedrock.options.baseURL).toBeUndefined()
    const after = yield* provider.getLanguage(model)
    expect((after as unknown as { config: { baseURL: string } }).config.baseURL).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/after/locations/us/publishers/anthropic/models",
    )
  }),
)
