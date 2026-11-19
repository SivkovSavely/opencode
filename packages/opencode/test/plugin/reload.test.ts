import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Exit, Logger } from "effect"
import { Agent } from "../../src/agent/agent"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Agent.node, Plugin.node, Config.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)

it.instance("reload preserves function-valued config contributions across multiple plugin hooks", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = path.join(ctx.directory, "opencode.json")
    const source = path.join(ctx.directory, "functions.ts")
    const calls = path.join(ctx.directory, "calls")
    yield* Effect.promise(() =>
      Bun.write(
        source,
        `
        export const first = async () => ({
          config: async (config) => {
            await Bun.write(${JSON.stringify(calls)}, "first");
            const fetch = async () => new Response("plugin response");
            config.provider.retained.options.fetch = fetch;
            config.provider.retained.options.nested = { fetch };
            config.provider.retained.options.callbacks.push(fetch);
            config.provider.retained.options.transport = new class Transport { request = fetch; }();
          },
        });
        export const second = async () => ({
          config: async (config) => {
            await Bun.write(${JSON.stringify(calls)}, await Bun.file(${JSON.stringify(calls)}).text() + ":second");
            config.provider.retained.options.second = () => "second hook";
          },
        });
        `,
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          plugin: [pathToFileURL(source).href],
          provider: { retained: { options: { callbacks: ["before"], disk: "before" } } },
        }),
      ),
    )
    const plugin = yield* Plugin.Service
    const config = yield* Config.Service
    yield* plugin.init()
    const initial = (yield* config.get()).provider?.retained.options ?? {}
    const fetch = initial.fetch
    const second = initial.second
    if (typeof fetch !== "function" || typeof second !== "function") throw new Error("Plugin hooks did not run")
    expect(yield* Effect.promise(() => fetch().then((response: Response) => response.text()))).toBe("plugin response")
    expect(second()).toBe("second hook")
    yield* Effect.promise(() =>
      Bun.write(file, JSON.stringify({ provider: { retained: { options: { callbacks: ["after"], disk: "after" } } } })),
    )
    yield* config.reload(InstanceState.reload([ctx]))
    const next = (yield* config.get()).provider?.retained.options ?? {}
    expect(next.fetch).toBe(fetch)
    expect(next.second).toBe(second)
    expect(next.nested).toEqual({ fetch })
    expect(next.callbacks).toEqual(["after", fetch])
    expect(next.transport).toBe(initial.transport)
    expect(next.disk).toBe("after")
    yield* config.reload(InstanceState.reload([ctx]))
    expect(((yield* config.get()).provider?.retained.options ?? {}).callbacks).toEqual(["after", fetch])
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toBe("first:second")
  }),
)

it.instance("reload rejects invalid retained plugin contributions without rerunning the hook", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const source = path.join(ctx.directory, "invalid.ts")
    const calls = path.join(ctx.directory, "calls")
    yield* Effect.promise(() =>
      Bun.write(
        source,
        `
      export default async () => ({
        config: async (config) => {
          await Bun.write(${JSON.stringify(calls)}, "once");
          config.agent.invalid = { steps: "reload-secret" };
        },
      });
    `,
      ),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(ctx.directory, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(source).href] })),
    )
    const plugin = yield* Plugin.Service
    const config = yield* Config.Service
    yield* plugin.init()
    const previous = yield* config.get()
    const logs: unknown[] = []
    const exit = yield* config
      .reload(InstanceState.reload([ctx]))
      .pipe(Effect.exit, Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry))])))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* config.get()).toBe(previous)
    expect(JSON.stringify(logs)).not.toContain("reload-secret")
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toBe("once")
  }),
)

it.instance("reload retains loaded plugin config edits without rerunning hooks or freezing disk config", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = path.join(ctx.directory, "opencode.json")
    const source = path.join(ctx.directory, "plugin.ts")
    const calls = path.join(ctx.directory, "calls")
    yield* Effect.promise(() =>
      Bun.write(
        source,
        `
        export default async () => {
          await Bun.write(${JSON.stringify(calls)}, "init");
          return {
            config: async (config) => {
              await Bun.write(${JSON.stringify(calls)}, await Bun.file(${JSON.stringify(calls)}).text() + ":config");
              config.agent.retained = { description: "plugin agent", mode: "subagent" };
              config.agent.edited.description = "plugin description";
              delete config.agent.removed;
              config.instructions.push("plugin instruction");
              config.disabled_providers = ["plugin-disabled"];
              config.provider = { retained: { options: { apiKey: "plugin-key" } } };
            },
          };
        };
      `,
      ),
    )
    const disk = {
      plugin: [pathToFileURL(source).href],
      agent: {
        edited: { description: "old", prompt: "old prompt" },
        removed: { description: "remove me" },
        diskOnly: { description: "disk only" },
      },
      instructions: ["old instruction"],
      disabled_providers: ["old-disabled"],
    }
    yield* Effect.promise(() => Bun.write(file, JSON.stringify(disk)))
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agent = yield* Agent.Service
    yield* plugin.init()
    const hooks = yield* plugin.list()
    expect((yield* agent.get("retained")).description).toBe("plugin agent")
    const previous = yield* config.get()
    yield* Effect.promise(() => Bun.write(file, JSON.stringify({ agent: { invalid: { steps: "secret" } } })))
    expect(Exit.isFailure(yield* config.reload(InstanceState.reload([ctx])).pipe(Effect.exit))).toBe(true)
    expect(yield* config.get()).toBe(previous)
    yield* Effect.promise(() =>
      Bun.write(
        file,
        JSON.stringify({
          agent: { edited: { description: "new", prompt: "new prompt" }, removed: { description: "new" } },
          instructions: ["new instruction"],
          disabled_providers: ["new-disabled"],
          username: "new username",
        }),
      ),
    )
    yield* config.reload(InstanceState.reload([ctx]))
    const next = yield* config.get()
    expect(next.agent?.retained).toMatchObject({ description: "plugin agent" })
    expect(next.agent?.edited).toMatchObject({ description: "plugin description", prompt: "new prompt" })
    expect(next.agent?.removed).toBeUndefined()
    expect(next.agent?.diskOnly).toBeUndefined()
    expect(next.instructions).toEqual(["new instruction", "plugin instruction"])
    expect(next.disabled_providers).toEqual(["plugin-disabled"])
    expect(next.provider?.retained.options?.apiKey).toBe("plugin-key")
    expect(next.username).toBe("new username")
    expect((yield* agent.get("retained")).description).toBe("plugin agent")
    expect((yield* agent.get("edited")).prompt).toBe("new prompt")
    expect(yield* plugin.list()).toBe(hooks)
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toBe("init:config")
    yield* config.reload(InstanceState.reload([ctx]))
    expect((yield* config.get()).instructions).toEqual(["new instruction", "plugin instruction"])
    expect(yield* Effect.promise(() => Bun.file(calls).text())).toBe("init:config")
  }),
)
