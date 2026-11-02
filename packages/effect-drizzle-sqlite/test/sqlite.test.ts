import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Deferred, Effect, Exit, Fiber, References } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { EffectDrizzleSqlite } from "../src"

const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
})

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`create table users (id integer primary key autoincrement, name text not null)`)
  return db
})

const createMigrationsFolder = async () => {
  const migrationsFolder = await mkdtemp(join(tmpdir(), "effect-drizzle-sqlite-"))
  await mkdir(join(migrationsFolder, "20240101000000_create_migrated_users"), { recursive: true })
  await Bun.write(
    join(migrationsFolder, "20240101000000_create_migrated_users", "migration.sql"),
    "create table migrated_users (id integer primary key autoincrement, name text not null);",
  )
  return migrationsFolder
}

test("selects rows through Effect-yieldable query builders", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.insert(users).values({ name: "Ada" })

      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Ada" }])
      expect(yield* db.select({ id: users.id }).from(users).where(eq(users.name, "Ada")).get()).toEqual({ id: 1 })
    }),
  )
})

test("commits successful transactions", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb

      yield* db.transaction((tx) => tx.insert(users).values({ name: "Grace" }), { behavior: "immediate" })

      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Grace" }])
    }),
  )
})

test("interrupts a transaction waiting for the reserved connection", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* db
        .transaction(() => Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(held)
      yield* Effect.gen(function* () {
        const waiter = yield* db.transaction(() => Effect.void).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const interrupted = yield* Fiber.interrupt(waiter).pipe(Effect.timeoutOption("200 millis"))
        expect(interrupted._tag).toBe("Some")
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      yield* Fiber.join(holder)
      yield* db.transaction((tx) => tx.insert(users).values({ name: "reused" })).pipe(Effect.timeout("1 second"))
      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "reused" }])
    }),
  )
}, 5000)

test.each([32, 2048])(
  "does not leak the upstream driver's reservation at yield budget %s",
  async (budget) => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        const leaks: number[] = []
        for (let padding = Math.max(0, budget - 68); padding < budget + 52; padding++) {
          const owner = yield* Effect.gen(function* () {
            for (let i = 0; i < padding; i++) yield* Effect.sync(() => {})
            yield* db.transaction(() => Effect.never)
          }).pipe(
            Effect.provideService(References.MaxOpsBeforeYield, budget),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Fiber.interrupt(owner)
          const reused = yield* db.transaction(() => Effect.void).pipe(Effect.timeoutOption("50 millis"))
          if (reused._tag === "None") {
            leaks.push(padding)
            break
          }
        }
        expect(leaks).toEqual([])
        expect(yield* db.transaction(() => Effect.service(References.PreventSchedulerYield))).toBe(false)
      }).pipe(Effect.timeout("5 seconds")),
    )
  },
  7000,
)

test.each(["defect", "interruption"] as const)(
  "closes a partially acquired reservation on %s",
  async (failure) => {
    await run(
      Effect.gen(function* () {
        const client = yield* SqlClient
        const reserved = yield* Deferred.make<void>()
        const reserve = client.reserve.pipe(
          Effect.tap(() => Deferred.succeed(reserved, undefined)),
          Effect.andThen(failure === "defect" ? Effect.die("reservation defect") : Effect.never),
        )
        const db = yield* EffectDrizzleSqlite.makeWithDefaults().pipe(
          Effect.provideService(
            SqlClient,
            new Proxy(client, {
              get: (target, key, receiver) => (key === "reserve" ? reserve : Reflect.get(target, key, receiver)),
            }),
          ),
        )
        const attempt = yield* db.transaction(() => Effect.void).pipe(Effect.forkChild)
        yield* Deferred.await(reserved)
        if (failure === "interruption") yield* Fiber.interrupt(attempt)
        const exit = yield* Fiber.await(attempt)
        expect(Exit.isFailure(exit)).toBe(true)
        const ordinary = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* ordinary.transaction((tx) => tx.run(sql`select 1`)).pipe(Effect.timeout("1 second"))
      }).pipe(Effect.timeout("2 seconds")),
    )
  },
  5000,
)

test("rolls back failed transactions", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb

      yield* db
        .transaction((tx) =>
          tx
            .insert(users)
            .values({ name: "Linus" })
            .pipe(Effect.andThen(Effect.fail("boom"))),
        )
        .pipe(Effect.ignore)

      expect(yield* db.select().from(users)).toEqual([])
    }),
  )
})

test("rolls back nested failures and propagates transaction context to child fibers", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(users).values({ name: "outer" })
            yield* tx
              .transaction((nested) =>
                nested
                  .insert(users)
                  .values({ name: "nested" })
                  .pipe(Effect.andThen(Effect.fail("nested failure"))),
              )
              .pipe(Effect.ignore)
            const child = yield* tx.insert(users).values({ name: "child" }).pipe(Effect.forkChild)
            yield* Fiber.join(child)
          }),
        )
        .pipe(Effect.timeout("1 second"))
      expect(yield* db.select().from(users)).toEqual([
        { id: 1, name: "outer" },
        { id: 2, name: "child" },
      ])
    }),
  )
}, 5000)

test("rolls back an interrupted owner and reuses its connection", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      const held = yield* Deferred.make<void>()
      const owner = yield* db
        .transaction((tx) =>
          tx
            .insert(users)
            .values({ name: "rolled back" })
            .pipe(Effect.andThen(Deferred.succeed(held, undefined)), Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(held)
      yield* Fiber.interrupt(owner).pipe(Effect.timeout("1 second"))
      yield* db.transaction((tx) => tx.insert(users).values({ name: "reused" })).pipe(Effect.timeout("1 second"))
      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "reused" }])
    }),
  )
}, 5000)

test("cleans up after a deferred constraint fails at commit", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`pragma foreign_keys = on`)
      yield* db.run(sql`create table parent (id integer primary key)`)
      yield* db.run(sql`create table child (parent_id integer references parent(id) deferrable initially deferred)`)
      const error = yield* db
        .transaction((tx) => tx.run(sql`insert into child values (1)`))
        .pipe(Effect.flip, Effect.timeout("1 second"))
      expect(isSqlError(error)).toBe(true)
      yield* db.transaction((tx) => tx.run(sql`insert into parent values (1)`)).pipe(Effect.timeout("1 second"))
      expect(yield* db.all(sql`select * from child`)).toEqual([])
    }),
  )
}, 5000)

test("rolls back explicit transaction rollback", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb

      yield* db
        .transaction((tx) =>
          tx
            .insert(users)
            .values({ name: "Barbara" })
            .pipe(Effect.andThen(Effect.fail(tx.rollback()))),
        )
        .pipe(Effect.ignore)

      expect(yield* db.select().from(users)).toEqual([])
    }),
  )
})

test("preserves failed transaction begin errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effect-drizzle-sqlite-"))
  const filename = join(dir, "locked.db")
  const holder = new Database(filename)

  try {
    holder.run("create table users (id integer primary key autoincrement, name text not null)")
    holder.run("pragma busy_timeout = 0")
    holder.run("begin immediate")

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`pragma busy_timeout = 0`)

        const error = yield* db
          .transaction((tx) => tx.insert(users).values({ name: "Blocked" }), { behavior: "immediate" })
          .pipe(Effect.flip)

        if (!isSqlError(error)) throw new Error("Expected SqlError")
        expect(error.reason._tag).toBe("LockTimeoutError")
        expect(error.reason.cause instanceof Error ? error.reason.cause.message : "").toContain("database is locked")
        holder.run("rollback")
        yield* db
          .transaction((tx) => tx.insert(users).values({ name: "Available" }), { behavior: "immediate" })
          .pipe(Effect.timeout("1 second"))
        expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Available" }])
      }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
    )
  } finally {
    if (holder.inTransaction) holder.run("rollback")
    holder.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("supports returning and rejects empty update sets", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb

      const inserted = yield* db.insert(users).values({ name: "Ada" }).returning({ id: users.id, name: users.name })
      expect(inserted).toEqual([{ id: 1, name: "Ada" }])

      const updated = yield* db.update(users).set({ name: "Grace" }).where(eq(users.id, 1)).returning()
      expect(updated).toEqual([{ id: 1, name: "Grace" }])

      const deleted = yield* db.delete(users).where(eq(users.id, 1)).returning({ id: users.id })
      expect(deleted).toEqual([{ id: 1 }])

      expect(() => db.update(users).set({ name: undefined })).toThrow("No values to set")
    }),
  )
})

test("runs migrations once and records migration metadata", async () => {
  const migrationsFolder = await createMigrationsFolder()
  try {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()

        yield* EffectDrizzleSqlite.migrate(db, { migrationsFolder })
        yield* EffectDrizzleSqlite.migrate(db, { migrationsFolder })
        yield* db.run(sql`insert into migrated_users (name) values ('Margaret')`)

        expect(yield* db.all<{ name: string }>(sql`select name from migrated_users`)).toEqual([{ name: "Margaret" }])
        expect(yield* db.all<{ name: string | null }>(sql`select name from __drizzle_migrations`)).toEqual([
          { name: "20240101000000_create_migrated_users" },
        ])
      }),
    )
  } finally {
    await rm(migrationsFolder, { recursive: true, force: true })
  }
})
