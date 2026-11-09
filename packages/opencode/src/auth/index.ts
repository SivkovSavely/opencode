import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { acquireProcessLock } from "../util/process-lock"
import { writePrivateJson } from "../util/private-file"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly compareAndSet: (key: string, expected: Oauth, next: Oauth) => Effect.Effect<boolean, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)
    const lock = Effect.acquireRelease(
      Effect.callback<Awaited<ReturnType<typeof acquireProcessLock>>, AuthError>((resume, signal) => {
        const acquiring = acquireProcessLock("auth-file", { signal })
        acquiring.then(
          (lock) => resume(Effect.succeed(lock)),
          (cause) => resume(Effect.fail(fail("Failed to lock auth data")(cause))),
        )
        // Cancellation may race with successful acquisition before its finalizer is registered.
        return Effect.promise(() =>
          acquiring.then(
            (lock) => lock.release(),
            () => {},
          ),
        )
      }),
      (lock) => Effect.promise(() => lock.release()),
      { interruptible: true },
    )
    // Native writes ignore interruption, so keep their lock until the promise settles.
    const write = (data: Record<string, Info>) =>
      Effect.tryPromise({
        try: () => writePrivateJson(file, data),
        catch: fail("Failed to write auth data"),
      }).pipe(Effect.uninterruptible)

    const stored = Effect.gen(function* () {
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      return yield* stored
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* write({ ...data, [norm]: info })
        }),
      )
    })

    const compareAndSet = Effect.fn("Auth.compareAndSet")(function* (key: string, expected: Oauth, next: Oauth) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock
          const norm = key.replace(/\/+$/, "")
          // An environment override is not the persisted credential being replaced.
          const data = yield* stored
          const current = data[norm]
          if (
            current?.type !== "oauth" ||
            current.access !== expected.access ||
            current.refresh !== expected.refresh ||
            current.expires !== expected.expires ||
            current.accountId !== expected.accountId ||
            current.enterpriseUrl !== expected.enterpriseUrl
          )
            return false
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* write({ ...data, [norm]: next })
          return true
        }),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lock
          const norm = key.replace(/\/+$/, "")
          const data = yield* all()
          delete data[key]
          delete data[norm]
          yield* write(data)
        }),
      )
    })

    return Service.of({ get, all, set, compareAndSet, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
