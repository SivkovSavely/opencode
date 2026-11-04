import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { layer, Service } from "@opencode/core/database/database"
import { DatabaseCompatibility } from "@opencode/core/database/compatibility"
import { migrations } from "@opencode/core/database/migration.gen"
import { sqliteLayer } from "@opencode/core/database/sqlite.bun"
import { SqlClient, Statement } from "effect/sql"
import { Reactivity } from "effect/reactivity"
import { Global } from "@opencode/util/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Retained journal entries from the native V2 registry before 0fbe489e35.
const previousV2Migrations = [
  "20260702134641_add_session_context_entry",
  "20260703090000_reset_v2_event_rename_sweep",
  "20260703181610_event_created_column",
  "20260703190000_reset_v2_shell_event_payloads",
  "20260703200000_reset_v2_session_events",
  "20260705180000_rename_instructions",
  "20260706223930_add-session-fork",
  "20260707010146_durable_session_inbox",
  "20260707120000_migrate_prelaunch_v2_state",
  "20260709013000_generic_session_input",
  "20260709025533_drop-todo",
  "20260709163752_time_suspended",
  "20260709190621_session_pending_table",
  "20260710025429_instruction_sync",
  "20260716020354_kv",
  "20260722011141_delete_tool_progress_events",
  "20260722170000_canonical_tool_results",
  "20260729022634_session_fork_boundary",
  "20260730195856_optional_session_title",
]

it.live("admits the complete retained native V2 journal before the split without changing the source", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "previous-v2.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT, session_id TEXT);
      CREATE TABLE session_message (id TEXT, session_id TEXT);
      CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER);
      INSERT INTO session VALUES ('ses_native');
      INSERT INTO message VALUES ('msg_native', 'ses_native');
      INSERT INTO session_message VALUES ('msg_native', 'ses_native');
    `)
    migrations
      .slice(
        0,
        migrations.findIndex((migration) => migration.id === "20260804233008_loose_psylocke"),
      )
      .map((migration) => migration.id)
      .concat(previousV2Migrations)
      .forEach((id) => native.query("INSERT INTO migration VALUES (?, 1)").run(id))
    const before = yield* Effect.promise(() => Bun.file(filename).bytes())
    yield* DatabaseCompatibility.check.pipe(
      Effect.provide(sqliteLayer({ filename, readonly: true, create: false, disableWAL: true })),
      Effect.scoped,
    )
    expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before)).toBe(true)
  }),
)

it.live("reopens current databases retaining the complete pre-split native V2 journal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "upgraded-v2.sqlite")
    yield* Effect.gen(function* () {
      const database = yield* Service
      yield* database.db.run("CREATE TABLE _embedding (data TEXT)")
      yield* database.db.run("INSERT INTO _embedding VALUES ('retained')")
    }).pipe(
      Effect.provide(layer({ path: filename })),
      Effect.provideService(Global.Service, Global.make({ data: directory.path })),
      Effect.scoped,
    )
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    previousV2Migrations.forEach((id) => native.query("INSERT INTO migration VALUES (?, 1)").run(id))
    yield* Effect.gen(function* () {
      const database = yield* Service
      expect(yield* database.db.all("SELECT data FROM _embedding")).toEqual([{ data: "retained" }])
      expect(yield* database.db.all("SELECT COUNT(*) AS count FROM migration")).toEqual([
        { count: migrations.length + previousV2Migrations.length },
      ])
    }).pipe(
      Effect.provide(layer({ path: filename })),
      Effect.provideService(Global.Service, Global.make({ data: directory.path })),
      Effect.scoped,
    )
  }),
)

it.live("refuses previous V2-only lineage with V1 history without touching committed WAL", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "history.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
      INSERT INTO session VALUES ('ses_history');
      INSERT INTO message VALUES ('msg_history', 'ses_history', '{"text":"retained history"}');
    `)
    migrations
      .slice(
        0,
        migrations.findIndex((migration) => migration.id === "20260804233008_loose_psylocke"),
      )
      .forEach((migration) => native.query("INSERT INTO migration VALUES (?, 1)").run(migration.id))
    native.exec("INSERT INTO migration VALUES ('20260730195856_optional_session_title', 1)")
    const before = yield* Effect.promise(() =>
      Promise.all([Bun.file(filename).bytes(), Bun.file(`${filename}-wal`).bytes()]),
    )
    expect(before[1].byteLength).toBeGreaterThan(0)

    yield* Effect.forEach([1, 2], () =>
      Effect.gen(function* () {
        const exit = yield* Layer.build(layer({ path: filename })).pipe(
          Effect.provideService(Global.Service, Global.make({ data: directory.path })),
          Effect.scoped,
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("Previous V2 database contains V1-only session history")
          expect(Cause.pretty(exit.cause)).toContain(filename)
        }
        expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before[0])).toBe(true)
        expect(Buffer.from(yield* Effect.promise(() => Bun.file(`${filename}-wal`).bytes())).equals(before[1])).toBe(
          true,
        )
        expect(native.query("SELECT data FROM message").get()).toEqual({ data: '{"text":"retained history"}' })
      }),
    )
  }),
)

it.live("refuses unrelated databases without enabling WAL or creating a migration journal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "unrelated.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep')")
    const before = yield* Effect.promise(() => Bun.file(filename).bytes())
    const exit = yield* Layer.build(layer({ path: filename })).pipe(
      Effect.provideService(Global.Service, Global.make({ data: directory.path })),
      Effect.scoped,
      Effect.exit,
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before)).toBe(true)
    expect(native.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
    expect(native.query("SELECT name FROM sqlite_master WHERE name = 'migration'").get()).toBeNull()
  }),
)

it.live("rejects unknown legacy timestamps before seeding the migration journal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "legacy.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
      INSERT INTO __drizzle_migrations VALUES (1, '', 0);
    `)
    const before = yield* Effect.promise(() => Bun.file(filename).bytes())
    const exit = yield* Layer.build(layer({ path: filename })).pipe(
      Effect.provideService(Global.Service, Global.make({ data: directory.path })),
      Effect.scoped,
      Effect.exit,
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Legacy migration timestamp 0")
    expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before)).toBe(true)
    expect(native.query("SELECT name FROM sqlite_master WHERE name = 'migration'").get()).toBeNull()
  }),
)

it.live("admits new, empty and current databases and preserves data on reopen", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.forEach([":memory:", "new.sqlite", "empty.sqlite"], (name) =>
      Effect.gen(function* () {
        const filename = name === ":memory:" ? name : path.join(directory.path, name)
        if (name === "empty.sqlite") yield* Effect.promise(() => Bun.write(filename, ""))
        yield* Effect.gen(function* () {
          const database = yield* Service
          yield* database.db.run("CREATE TABLE _embedding (data TEXT)")
          yield* database.db.run("INSERT INTO _embedding VALUES ('preserved')")
        }).pipe(
          Effect.provide(layer({ path: filename })),
          Effect.provideService(Global.Service, Global.make({ data: directory.path })),
          Effect.scoped,
        )
        if (name === ":memory:") return
        yield* Effect.gen(function* () {
          const database = yield* Service
          expect(yield* database.db.all("SELECT data FROM _embedding")).toEqual([{ data: "preserved" }])
        }).pipe(
          Effect.provide(layer({ path: filename })),
          Effect.provideService(Global.Service, Global.make({ data: directory.path })),
          Effect.scoped,
        )
      }),
    )
  }),
)

it.live("refuses unknown migration IDs and missing completed V2 tables without changing the source", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.forEach(["future_migration", "20260804233008_loose_psylocke"], (id) =>
      Effect.gen(function* () {
        const filename = path.join(directory.path, `${id}.sqlite`)
        const native = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(filename)),
          (db) => Effect.sync(() => db.close()),
        )
        native.exec("CREATE TABLE session (id TEXT); CREATE TABLE migration (id TEXT, time_completed INTEGER)")
        native.query("INSERT INTO migration VALUES (?, 1)").run(id)
        const before = yield* Effect.promise(() => Bun.file(filename).bytes())
        const exit = yield* Layer.build(layer({ path: filename })).pipe(
          Effect.provideService(Global.Service, Global.make({ data: directory.path })),
          Effect.scoped,
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            id === "future_migration" ? "Unknown database migration" : "Missing session_v2 table",
          )
        expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before)).toBe(true)
      }),
    )
  }),
)

it.live("uses one snapshot for schema and journal inspection", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "snapshot.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec("PRAGMA journal_mode = WAL; CREATE TABLE session (id TEXT); CREATE TABLE migration (id TEXT)")
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connection = yield* sql.reserve
      const intercepted = yield* SqlClient.make({
        acquirer: Effect.succeed({
          ...connection,
          execute(query, params, transform) {
            return connection.execute(query, params, transform).pipe(
              Effect.tap(() => {
                if (query.includes("sqlite_master")) native.exec("INSERT INTO migration VALUES ('future_migration')")
                return Effect.void
              }),
            )
          },
        }),
        compiler: Statement.makeCompilerSqlite(),
        driver: sql.driver,
        spanAttributes: [],
      })
      yield* DatabaseCompatibility.check.pipe(Effect.provideService(SqlClient.SqlClient, intercepted))
    }).pipe(
      Effect.provide(sqliteLayer({ filename, readonly: true, disableWAL: true })),
      Effect.provide(Reactivity.layer),
      Effect.scoped,
    )
    const exit = yield* DatabaseCompatibility.check.pipe(
      Effect.provide(sqliteLayer({ filename, readonly: true, disableWAL: true })),
      Effect.scoped,
      Effect.exit,
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("future_migration")
  }),
)

it.live("Node admission refuses incompatible history before writable open", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const filename = path.join(directory.path, "node.sqlite")
    const native = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      (db) => Effect.sync(() => db.close()),
    )
    native.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE session (id TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT);
      CREATE TABLE session_message (session_id TEXT);
      CREATE TABLE migration (id TEXT, time_completed INTEGER);
      INSERT INTO migration VALUES ('20260730195856_optional_session_title', 1);
      INSERT INTO message VALUES ('msg_node', 'ses_node');
    `)
    const before = yield* Effect.promise(() =>
      Promise.all([Bun.file(filename).bytes(), Bun.file(`${filename}-wal`).bytes()]),
    )
    const build = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixture/database-open.ts")],
        target: "node",
        conditions: ["node"],
        outdir: directory.path,
      }),
    )
    expect(build.success).toBe(true)
    const child = Bun.spawn(["node", build.outputs[0]!.path, filename], { stdout: "pipe", stderr: "pipe" })
    yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()))
    const [code, stderr] = yield* Effect.promise(() => Promise.all([child.exited, new Response(child.stderr).text()]))
    expect(stderr).toContain("Previous V2 database contains V1-only session history")
    expect(stderr).toContain(filename)
    expect(code).not.toBe(0)
    expect(Buffer.from(yield* Effect.promise(() => Bun.file(filename).bytes())).equals(before[0])).toBe(true)
    expect(Buffer.from(yield* Effect.promise(() => Bun.file(`${filename}-wal`).bytes())).equals(before[1])).toBe(true)
  }),
)
