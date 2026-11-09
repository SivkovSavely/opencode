import { describe, expect, spyOn } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { watch } from "node:fs"
import { open, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Auth } from "../../src/auth"
import { acquireProcessLock } from "../../src/util/process-lock"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  for (const operation of ["set", "compareAndSet", "remove"] as const) {
    it.live(`interrupted ${operation} holds the auth lock until its pending write settles`, () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const key = `synthetic-interrupted-${operation}`
        const initial: Auth.Oauth = {
          type: "oauth",
          access: "synthetic-initial-access",
          refresh: "synthetic-initial-refresh",
          expires: 0,
        }
        const refreshed = { ...initial, access: "synthetic-refreshed-access" }
        const login = { ...initial, access: "synthetic-new-login-access" }
        yield* auth.set(key, initial)

        const handle = yield* Effect.promise(() => open(path.join(Global.Path.data, "auth.json"), "r"))
        const prototype: Pick<FileHandle, "sync"> = Object.getPrototypeOf(handle)
        const sync = prototype.sync
        yield* Effect.promise(() => handle.close())
        const syncing = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const spy = spyOn(prototype, "sync").mockImplementationOnce(async function (this: FileHandle) {
          syncing.resolve()
          await release.promise
          await sync.call(this)
        })
        const mutation =
          operation === "set"
            ? auth.set(`${key}-unrelated`, { type: "api", key: "synthetic-unrelated-key" })
            : operation === "compareAndSet"
              ? auth.compareAndSet(key, initial, refreshed)
              : auth.remove(key)
        const writer = yield* mutation.pipe(Effect.forkScoped)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            release.resolve()
            yield* Fiber.interrupt(writer)
            spy.mockRestore()
          }),
        )
        yield* Effect.promise(() => syncing.promise)
        const cancelling = yield* Fiber.interrupt(writer).pipe(Effect.forkScoped({ startImmediately: true }))
        const admitted = yield* Effect.promise(() =>
          acquireProcessLock("auth-file", { timeoutMs: 0 }).then(
            async (lock) => {
              await lock.release()
              return true
            },
            (error: unknown) => {
              if (!(error instanceof Error)) throw error
              expect(error.message).toBe("Timed out waiting for private operation lock")
              return false
            },
          ),
        )
        const following = yield* (
          operation === "set"
            ? auth.compareAndSet(key, initial, refreshed)
            : operation === "compareAndSet"
              ? auth.remove(key)
              : auth.set(key, login)
        ).pipe(Effect.forkScoped)
        // Reproduce the stale-rename order if cancellation incorrectly admits a writer.
        if (admitted) yield* Fiber.join(following)
        const renamed = Promise.withResolvers<void>()
        const watcher = watch(Global.Path.data, (event, name) => {
          if (event === "rename" && name === "auth.json") renamed.resolve()
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()))
        release.resolve()
        yield* Effect.promise(() => renamed.promise)
        yield* Fiber.join(cancelling)
        yield* Fiber.join(following)
        expect(Exit.hasInterrupts(yield* Fiber.await(writer))).toBe(true)
        expect(yield* auth.get(key)).toEqual(
          operation === "compareAndSet" ? undefined : operation === "set" ? refreshed : login,
        )
        expect(admitted).toBe(false)
      }),
    )
  }

  it.live("interrupts an auth mutation waiting for the lock without leaving ownership or writing", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const blocker = yield* Effect.acquireRelease(
        Effect.promise(() => acquireProcessLock("auth-file")),
        (lock) => Effect.promise(() => lock.release()),
      )
      const key = "synthetic-interrupted-lock-waiter"
      const writer = yield* auth
        .set(key, { type: "api", key: "synthetic-cancelled-key" })
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Fiber.interrupt(writer)
      expect(Exit.hasInterrupts(yield* Fiber.await(writer))).toBe(true)
      expect(yield* auth.get(key)).toBeUndefined()
      yield* Effect.promise(() => blocker.release())
      yield* auth.set(key, { type: "api", key: "synthetic-following-key" })
      expect(yield* auth.get(key)).toEqual({ type: "api", key: "synthetic-following-key" })
    }),
  )

  it.live("compareAndSet commits only one matching OAuth update and preserves other providers", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const initial: Auth.Oauth = {
        type: "oauth",
        access: "synthetic-old-access",
        refresh: "synthetic-old-refresh",
        expires: 0,
        accountId: "synthetic-account",
      }
      yield* auth.set("synthetic-cas", initial)
      yield* auth.set("synthetic-cas-unrelated", { type: "api", key: "synthetic-key" })
      const updates = [
        { ...initial, access: "synthetic-first-access", refresh: "synthetic-first-refresh" },
        { ...initial, access: "synthetic-second-access", refresh: "synthetic-second-refresh" },
      ]
      const results = yield* Effect.all(
        updates.map((next) => auth.compareAndSet("synthetic-cas", initial, next)),
        { concurrency: "unbounded" },
      )
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(yield* auth.get("synthetic-cas")).toEqual(updates[results.indexOf(true)])
      expect(yield* auth.get("synthetic-cas-unrelated")).toEqual({ type: "api", key: "synthetic-key" })
      const file = yield* Effect.promise(() => stat(path.join(Global.Path.data, "auth.json")))
      if (process.platform !== "win32") expect(file.mode & 0o777).toBe(0o600)
    }),
  )

  it.live("compareAndSet rejects every changed OAuth field, logout, and a replacement API key", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const initial: Auth.Oauth = {
        type: "oauth",
        access: "synthetic-old-access",
        refresh: "synthetic-old-refresh",
        expires: 0,
        accountId: "synthetic-account",
        enterpriseUrl: "https://synthetic.invalid",
      }
      for (const replacement of [
        { ...initial, access: "synthetic-other-access" },
        { ...initial, refresh: "synthetic-other-refresh" },
        { ...initial, expires: 1 },
        { ...initial, accountId: "synthetic-other-account" },
        { ...initial, enterpriseUrl: "https://other.synthetic.invalid" },
        { type: "api" as const, key: "synthetic-replacement-key" },
        undefined,
      ]) {
        if (replacement) yield* auth.set("synthetic-cas-rejected", replacement)
        if (!replacement) yield* auth.remove("synthetic-cas-rejected")
        expect(
          yield* auth.compareAndSet("synthetic-cas-rejected", initial, {
            ...initial,
            access: "synthetic-stale-refresh-access",
          }),
        ).toBe(false)
        expect(yield* auth.get("synthetic-cas-rejected")).toEqual(replacement)
      }
    }),
  )

  it.live("compareAndSet cannot restore credentials from a stale environment override", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const key = "synthetic-cas-env"
      const initial: Auth.Oauth = {
        type: "oauth",
        access: "synthetic-env-access",
        refresh: "synthetic-env-refresh",
        expires: 0,
      }
      yield* auth.set(key, initial)
      yield* auth.remove(key)
      const previous = process.env.OPENCODE_AUTH_CONTENT
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
          if (previous !== undefined) process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      )
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ [key]: initial })
      expect(yield* auth.compareAndSet(key, initial, { ...initial, access: "synthetic-stale-refresh" })).toBe(false)
      const stored = yield* Effect.promise(() => Bun.file(path.join(Global.Path.data, "auth.json")).json())
      expect(stored[key]).toBeUndefined()
    }),
  )

  it.live("concurrent writes preserve entries and replace the file privately", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const file = path.join(Global.Path.data, "auth.json")
      yield* auth.set("concurrency-seed", { type: "api", key: "seed" })
      const before = yield* Effect.promise(() => stat(file))
      yield* Effect.all(
        Array.from({ length: 12 }, (_, i) => auth.set(`concurrent-${i}`, { type: "api", key: `key-${i}` })),
        { concurrency: "unbounded" },
      )
      const data = yield* auth.all()
      for (let i = 0; i < 12; i++) expect(data[`concurrent-${i}`]).toEqual({ type: "api", key: `key-${i}` })
      const after = yield* Effect.promise(() => stat(file))
      if (process.platform !== "win32") {
        expect(after.mode & 0o777).toBe(0o600)
        expect(after.ino).not.toBe(before.ino)
      }
    }),
  )
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})
