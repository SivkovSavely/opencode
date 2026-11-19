import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/app-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { InstanceState } from "@/effect/instance-state"
import { createHash } from "node:crypto"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      const strict = yield* InstanceState.reloading
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => res.arrayBuffer),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch(() =>
          strict
            ? Effect.die(
                new ConfigErrorV1.InvalidError({
                  path: "https://remote.invalid/",
                  message: "Remote skill download failed",
                }),
              )
            : Effect.logError("failed to download remote skill").pipe(Effect.as(false)),
        ),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const strict = yield* InstanceState.reloading
      const base = url.endsWith("/") ? url : `${url}/`
      const index = yield* Effect.try({ try: () => new URL("index.json", base).href, catch: () => undefined }).pipe(
        Effect.catch(() =>
          strict
            ? Effect.die(
                new ConfigErrorV1.InvalidError({
                  path: "https://remote.invalid/",
                  message: "Invalid remote skill URL",
                }),
              )
            : Effect.succeed(undefined),
        ),
      )
      if (!index) return []
      const host = base.slice(0, -1)

      yield* Effect.logInfo("fetching remote skill index")

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch(() =>
          strict
            ? Effect.die(
                new ConfigErrorV1.InvalidError({
                  path: "https://remote.invalid/",
                  message: "Invalid or unavailable remote skill index",
                }),
              )
            : Effect.logError("failed to fetch remote skill index").pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      if (strict && missing.length) {
        return yield* Effect.die(
          new ConfigErrorV1.InvalidError({
            path: "https://remote.invalid/",
            message: "Remote skill entry missing SKILL.md",
          }),
        )
      }
      yield* Effect.forEach(missing, () => Effect.logWarning("remote skill entry missing SKILL.md"), { discard: true })
      const list = data.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            const version = skill.version
            const source =
              version === undefined
                ? path.join(cache, skill.name)
                : path.join(cache, ".versions", skill.name, createHash("sha256").update(index).digest("hex"))
            const versionFile = path.join(source, ".opencode-version")
            const current =
              version === undefined
                ? undefined
                : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
            // Published metadata can outlive a rejected reload, so never replace a downloaded version's directory.
            const root =
              version === undefined ? source : path.join(source, createHash("sha256").update(version).digest("hex"))

            if (version === undefined || (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie))) {
              yield* Effect.forEach(
                skill.files,
                (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(root, file)),
                { concurrency: fileConcurrency, discard: true },
              )
            } else {
              const token = crypto.randomUUID()
              const staging = `${root}.tmp-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  skill.files,
                  (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(staging, file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* fs
                      .rename(staging, root)
                      .pipe(
                        Effect.catch((error) =>
                          fs
                            .exists(path.join(root, "SKILL.md"))
                            .pipe(Effect.flatMap((cached) => (cached ? Effect.void : Effect.fail(error)))),
                        ),
                      )
                    yield* fs.writeFileString(versionFile, version)
                  }),
                )
              }).pipe(
                Effect.catch(() =>
                  strict
                    ? Effect.die(
                        new ConfigErrorV1.InvalidError({
                          path: "https://remote.invalid/",
                          message: "Remote skill refresh failed",
                        }),
                      )
                    : Effect.logError("failed to refresh remote skill"),
                ),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            if (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) return root
            if (current === undefined) return null
            const previous = path.join(source, createHash("sha256").update(current).digest("hex"))
            return (yield* fs.exists(path.join(previous, "SKILL.md")).pipe(Effect.orDie)) ? previous : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, path, httpClient] })

export * as Discovery from "./discovery"
