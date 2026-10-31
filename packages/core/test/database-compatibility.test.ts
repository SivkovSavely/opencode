import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Effect, Layer } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseCompatibility } from "../src/database/compatibility"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { layer } from "../src/database/sqlite.bun"
import { tmpdir } from "./fixture/tmpdir"

const open = (filename: string) => Effect.runPromise(Effect.scoped(Layer.build(layer({ filename }))))

async function nodeProbe(filename: string, directory: string) {
  const build = await Bun.build({
    entrypoints: [new URL("./fixture/database-compatibility-node.ts", import.meta.url).pathname],
    target: "node",
    outdir: directory,
  })
  expect(build.success, JSON.stringify(build.logs)).toBe(true)
  const result = Bun.spawn(["node", `${directory}/database-compatibility-node.js`, filename], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(result.stderr).text()
  return { stderr, exitCode: await result.exited }
}

describe("database compatibility preflight", () => {
  test("inspects schema and journal from one WAL snapshot", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/snapshot.sqlite`
    using writer = new SQLite(filename, { create: true })
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE migration (id TEXT);
    `)
    using reader = new SQLite(filename, { readonly: true })
    let committed = false
    const check = () =>
      DatabaseCompatibility.check(filename, (sql) => {
        const rows = reader.query(sql).all()
        if (!committed && sql.startsWith("SELECT name FROM sqlite_master")) {
          writer.exec(`
            BEGIN;
            CREATE TABLE data_migration (id TEXT PRIMARY KEY);
            INSERT INTO migration VALUES ('20260511000411_data_migration_state');
            COMMIT;
          `)
          committed = true
        }
        if (sql === "SELECT id FROM migration" && committed) expect(rows).toEqual([])
        return rows
      })
    expect(check).not.toThrow()
    expect(committed).toBe(true)
    expect(reader.query("SELECT id FROM migration").all()).toEqual([{ id: "20260511000411_data_migration_state" }])
    expect(() => DatabaseCompatibility.check(filename, (sql) => reader.query(sql).all())).not.toThrow()
  })

  test("ends the read transaction on empty databases and inspection failures", () => {
    using db = new SQLite(":memory:")
    const check = () => DatabaseCompatibility.check("cleanup.sqlite", (sql) => db.query(sql).all())
    expect(check).not.toThrow()
    db.exec("BEGIN; ROLLBACK")
    db.exec("CREATE TABLE project (id TEXT PRIMARY KEY)")
    expect(check).toThrow("non-empty database has no session table")
    db.exec("BEGIN; ROLLBACK")
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE migration (wrong_column TEXT)")
    expect(check).toThrow("SQL: SELECT id FROM migration")
    db.exec("BEGIN; ROLLBACK")
  })

  test("preserves inspection errors if rollback fails", () => {
    using db = new SQLite(":memory:")
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE migration (wrong_column TEXT)")
    const error = (() => {
      try {
        DatabaseCompatibility.check("cleanup.sqlite", (sql) => {
          if (sql === "ROLLBACK") {
            db.exec("ROLLBACK")
            throw new Error("cleanup failed")
          }
          return db.query(sql).all()
        })
      } catch (cause) {
        return cause
      }
    })()
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected inspection to fail")
    expect(error.message).toContain("SQL: SELECT id FROM migration")
    expect(String(error.cause)).toContain("no such column")
    db.exec("BEGIN; ROLLBACK")
  })

  for (const runtime of ["bun", "node"] as const) {
    test(`${runtime} rejects committed WAL shape before checkpoints, journal or application writes`, async () => {
      await using tmp = await tmpdir()
      const filename = `${tmp.path}/incompatible.sqlite`
      using writer = new SQLite(filename, { create: true })
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
      writer.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE workspace (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY);
        CREATE TABLE session_message (id TEXT REFERENCES message(id) ON DELETE CASCADE);
        INSERT INTO session VALUES ('preserved');
      `)
      const before = await Bun.file(filename).bytes()
      const wal = await Bun.file(`${filename}-wal`).bytes()
      expect(wal.length).toBeGreaterThan(0)
      if (runtime === "bun") {
        await expect(Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))).rejects.toThrow(
          filename,
        )
        await expect(open(filename)).rejects.toThrow("workspace has incompatible columns")
        await expect(open(filename)).rejects.toThrow("session_message foreign key id -> message.id")
      }
      if (runtime === "node") {
        const result = await nodeProbe(filename, tmp.path)
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(filename)
        expect(result.stderr).toContain("workspace has incompatible columns")
        expect(result.stderr).toContain("session_message foreign key id -> message.id")
      }
      expect(await Bun.file(filename).bytes()).toEqual(before)
      expect(await Bun.file(`${filename}-wal`).bytes()).toEqual(wal)
      expect(writer.query("SELECT * FROM session").all()).toEqual([{ id: "preserved" }])
      expect(writer.query("SELECT name FROM sqlite_master WHERE name = 'migration'").all()).toEqual([])
    })

    for (const shape of [
      "missing-fk",
      "set-null",
      "no-action",
      "missing-seq",
      "data-migration",
      "runtime-execution",
    ] as const) {
      test(`${runtime} rejects completed-schema ${shape} before touching committed WAL`, async () => {
        await using tmp = await tmpdir()
        const filename = `${tmp.path}/completed.sqlite`
        await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
        using writer = new SQLite(filename)
        writer.exec("PRAGMA wal_autocheckpoint = 0")
        if (shape === "data-migration") writer.exec("DROP TABLE data_migration")
        if (shape === "runtime-execution") writer.exec("DROP TABLE runtime_execution")
        if (shape !== "data-migration" && shape !== "runtime-execution") {
          writer.exec("DROP TABLE session_message")
          writer.exec(`CREATE TABLE session_message (
            id TEXT PRIMARY KEY, session_id TEXT ${shape === "missing-fk" ? "" : `REFERENCES session(id) ON DELETE ${shape === "set-null" ? "SET NULL" : shape === "missing-seq" ? "CASCADE" : "NO ACTION"}`},
            type TEXT, ${shape === "missing-seq" ? "" : "seq INTEGER,"} time_created INTEGER, time_updated INTEGER, data TEXT
          )`)
        }
        const before = await Bun.file(filename).bytes()
        const wal = await Bun.file(`${filename}-wal`).bytes()
        const journal = writer.query("SELECT * FROM migration ORDER BY id").all()
        const diagnostic = {
          "data-migration": "missing data_migration table although migration 20260511000411_data_migration_state is completed",
          "runtime-execution":
            "missing runtime_execution table although migration 20260916183243_durable_runtime_execution is completed",
          "missing-fk": "session_message is missing its session_id -> session.id foreign key",
          "missing-seq": "session_message has incompatible columns: missing seq",
          "set-null": "session_message foreign key session_id -> session.id is incompatible (ON DELETE SET NULL",
          "no-action": "session_message foreign key session_id -> session.id is incompatible (ON DELETE NO ACTION",
        }[shape]
        if (runtime === "bun")
          await expect(Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))).rejects.toThrow(
            diagnostic,
          )
        if (runtime === "node") {
          const result = await nodeProbe(filename, tmp.path)
          expect(result.exitCode).not.toBe(0)
          expect(result.stderr).toContain(diagnostic)
          expect(result.stderr).toContain(filename)
        }
        expect(wal.length).toBeGreaterThan(0)
        expect(await Bun.file(filename).bytes()).toEqual(before)
        expect(await Bun.file(`${filename}-wal`).bytes()).toEqual(wal)
        expect(writer.query("SELECT * FROM migration ORDER BY id").all()).toEqual(journal)
      })
    }
  }

  test("rejects audited session_v2 and worktree project graph without losing V1 or V2 history", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/project.sqlite`
    using writer = new SQLite(filename, { create: true })
    writer.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE project (id TEXT PRIMARY KEY);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT REFERENCES message(id) ON DELETE CASCADE);
      CREATE TABLE worktree (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE, directory TEXT);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE, worktree_id TEXT REFERENCES worktree(id), title TEXT);
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE,
        type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      INSERT INTO project VALUES ('project');
      INSERT INTO session VALUES ('session', 'project');
      INSERT INTO message VALUES ('message', 'session');
      INSERT INTO part VALUES ('part', 'message');
      INSERT INTO worktree VALUES ('worktree', 'project', '/repo');
      INSERT INTO session_v2 VALUES ('session-v2', 'project', 'worktree', 'V2 history');
      INSERT INTO session_message VALUES ('message-v2', 'session-v2', 'user', 1, 1, 1, '{"parts":[{"type":"text","text":"preserve V2 history"}]}');
    `)
    const before = await Bun.file(filename).bytes()
    const tables = ["project", "session", "message", "part", "worktree", "session_v2", "session_message"]
    const history = tables.map((table) => writer.query(`SELECT * FROM ${table}`).all())
    await expect(Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))).rejects.toThrow(
      "unsupported project-child foreign key worktree.project_id",
    )
    await expect(open(filename)).rejects.toThrow("unsupported project-child foreign key session_v2.project_id")
    await expect(open(filename)).rejects.toThrow("session_message foreign key session_id -> session_v2.id")
    expect(await Bun.file(filename).bytes()).toEqual(before)
    expect(tables.map((table) => writer.query(`SELECT * FROM ${table}`).all())).toEqual(history)
    expect(writer.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(writer.query("SELECT name FROM sqlite_master WHERE name = 'migration'").all()).toEqual([])
    expect(writer.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
  })

  for (const journal of ["migration", "named", "timestamp"] as const) {
    test(`honors removed and recreated tables and projection order in ${journal} journal`, () => {
      using db = new SQLite(":memory:")
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE project (id TEXT PRIMARY KEY);
        CREATE TABLE message (id TEXT PRIMARY KEY);
        CREATE TABLE part (id TEXT PRIMARY KEY);
        CREATE TABLE todo (id TEXT PRIMARY KEY);
        CREATE TABLE session_share (id TEXT PRIMARY KEY);
        CREATE TABLE ${journal === "migration" ? "migration (id TEXT)" : journal === "named" ? "__drizzle_migrations (name TEXT)" : "__drizzle_migrations (created_at INTEGER)"};
      `)
      const complete = (id: string) =>
        db
          .query(`INSERT INTO ${journal === "migration" ? "migration" : "__drizzle_migrations"} VALUES (?)`)
          .run(
            journal === "timestamp"
              ? Date.parse(
                  `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}Z`,
                )
              : id,
          )
      const check = () => DatabaseCompatibility.check("stages.sqlite", (sql) => db.query(sql).all())
      complete("20260127222353_familiar_lady_ursula")
      expect(check).toThrow("missing permission table")
      complete("20260601202201_amazing_prowler")
      expect(check).not.toThrow()
      complete("20260602002951_lowly_union_jack")
      expect(check).toThrow("missing permission table although migration 20260602002951_lowly_union_jack is completed")
      db.exec("CREATE TABLE permission (id TEXT PRIMARY KEY)")
      expect(check).not.toThrow()

      complete("20260413175956_chief_energizer")
      expect(check).toThrow("missing session_entry table")
      db.exec("CREATE TABLE session_entry (id TEXT PRIMARY KEY)")
      expect(check).not.toThrow()
      db.exec(`
        DROP TABLE session_entry;
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE);
      `)
      complete("20260427172553_slow_nightmare")
      // The real pre-launch table has no seq until projection-order completes.
      expect(check).not.toThrow()
      complete("20260603040000_session_message_projection_order")
      expect(check).toThrow(
        "session_message has incompatible columns: missing seq although migration 20260603040000_session_message_projection_order is completed",
      )
      db.exec("ALTER TABLE session_message ADD seq INTEGER")
      expect(check).not.toThrow()
    })

    for (const [table, id] of [
      ["project", "20260127222353_familiar_lady_ursula"],
      ["message", "20260127222353_familiar_lady_ursula"],
      ["part", "20260127222353_familiar_lady_ursula"],
      ["todo", "20260127222353_familiar_lady_ursula"],
      ["session_share", "20260127222353_familiar_lady_ursula"],
      ["permission", "20260127222353_familiar_lady_ursula"],
      ["control_account", "20260213144116_wakeful_the_professor"],
      ["workspace", "20260225215848_workspace"],
      ["account", "20260228203230_blue_harpoon"],
      ["account_state", "20260228203230_blue_harpoon"],
      ["event", "20260323234822_events"],
      ["event_sequence", "20260323234822_events"],
      ["session_entry", "20260413175956_chief_energizer"],
      ["session_message", "20260427172553_slow_nightmare"],
      ["data_migration", "20260511000411_data_migration_state"],
      ["project_directory", "20260602182828_add_project_directories"],
      ["permission", "20260602002951_lowly_union_jack"],
      ["session_input", "20260603141458_session_input_inbox"],
      ["session_context_epoch", "20260605003541_add_session_context_snapshot"],
      ["credential", "20260611035744_credential"],
      ["runtime_execution", "20260916183243_durable_runtime_execution"],
      ["session_queue_state", "20261016124546_session_queue"],
      ["session_queue", "20261016124546_session_queue"],
      ["session_queue_import", "20261016130309_session_queue_import"],
      ["transcript_search_state", "20261027085712_transcript_search"],
      ["transcript_search", "20261027085712_transcript_search"],
      ["runtime_retirement", "20261028141815_runtime_retirement_table"],
      ["runtime_retirement_member", "20261028143259_runtime_retirement_members"],
      ["managed_command_coverage", "20261028171804_managed_command_ownership"],
      ["managed_command", "20261028171804_managed_command_ownership"],
    ] as const) {
      test(`distinguishes completed from pending ${table} creation (${id}) in ${journal} journal`, () => {
        using db = new SQLite(":memory:")
        db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)")
        if (journal === "migration") db.exec("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER)")
        if (journal === "named") db.exec("CREATE TABLE __drizzle_migrations (name TEXT)")
        if (journal === "timestamp") db.exec("CREATE TABLE __drizzle_migrations (created_at INTEGER)")
        const check = () => DatabaseCompatibility.check("test.sqlite", (sql) => db.query(sql).all())
        expect(check).not.toThrow()
        if (journal === "migration") db.query("INSERT INTO migration VALUES (?, 1)").run(id)
        if (journal === "named") db.query("INSERT INTO __drizzle_migrations VALUES (?)").run(id)
        if (journal === "timestamp")
          db.query("INSERT INTO __drizzle_migrations VALUES (?)").run(
            Date.parse(
              `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}Z`,
            ),
          )
        expect(check).toThrow(`missing ${table} table although migration ${id} is completed`)
      })
    }
  }

  test("reports the missing required session_message FK even when another FK exists", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (session_id TEXT, message_id TEXT REFERENCES message(id) ON DELETE CASCADE);
    `)
    expect(() => DatabaseCompatibility.check("fk.sqlite", (sql) => db.query(sql).all())).toThrow(
      "session_message is missing its session_id -> session.id foreign key",
    )
  })

  test("rejects a nonempty database missing the session table", () => {
    using db = new SQLite(":memory:")
    db.exec("CREATE TABLE project (id TEXT PRIMARY KEY)")
    expect(() => DatabaseCompatibility.check("missing.sqlite", (sql) => db.query(sql).all())).toThrow(
      "non-empty database has no session table",
    )
  })

  test("rejects unknown legacy timestamps before the runner seeds its journal", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE __drizzle_migrations (created_at INTEGER);
      INSERT INTO __drizzle_migrations VALUES (0);
    `)
    expect(() => DatabaseCompatibility.check("unknown.sqlite", (sql) => db.query(sql).all())).toThrow(
      "unknown legacy migration timestamp prefix 19700101000000",
    )
  })

  test("ignores stale unknown legacy timestamps when the modern journal is populated", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE migration (id TEXT);
      INSERT INTO migration VALUES ('unknown_migration');
      CREATE TABLE __drizzle_migrations (created_at INTEGER);
      INSERT INTO __drizzle_migrations VALUES (0);
    `)
    expect(() => DatabaseCompatibility.check("stale.sqlite", (sql) => db.query(sql).all())).not.toThrow()
  })

  test("rejects session_message before its unconditional creation", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE);
    `)
    expect(() => DatabaseCompatibility.check("early.sqlite", (sql) => db.query(sql).all())).toThrow(
      "session_message exists before pending migration 20260427172553_slow_nightmare",
    )
  })

  test("rejects cascading workspace children only while the workspace rebuild is pending", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE workspace (id TEXT PRIMARY KEY, type TEXT, branch TEXT, directory TEXT, extra TEXT, project_id TEXT);
      CREATE TABLE extension_data (workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE);
      CREATE TABLE migration (id TEXT);
      INSERT INTO migration VALUES ('20260303231226_add_workspace_fields');
    `)
    const check = () => DatabaseCompatibility.check("workspace-child.sqlite", (sql) => db.query(sql).all())
    expect(check).toThrow("unsupported workspace-child foreign key extension_data.workspace_id")
    db.exec("INSERT INTO migration VALUES ('20260410174513_workspace-name')")
    expect(check).not.toThrow()
  })

  test("rejects populated config-era workspaces but allows empty ones", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, config TEXT, project_id TEXT);
    `)
    const check = () => DatabaseCompatibility.check("workspace.sqlite", (sql) => db.query(sql).all())
    expect(check).not.toThrow()
    db.exec("INSERT INTO workspace (id) VALUES ('workspace')")
    expect(check).toThrow("populated config-era workspace cannot run pending migration")
  })

  test("rejects upgraded workspace fields when add-fields is pending", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE workspace (id TEXT PRIMARY KEY, type TEXT, branch TEXT, directory TEXT, extra TEXT, project_id TEXT);
      CREATE TABLE migration (id TEXT);
      INSERT INTO migration VALUES ('20260225215848_workspace');
    `)
    expect(() => DatabaseCompatibility.check("workspace.sqlite", (sql) => db.query(sql).all())).toThrow(
      "workspace has incompatible columns: type, directory, extra already present before pending migration",
    )
  })

  test("accepts fresh databases and reopens the migrated current schema", async () => {
    await using tmp = await tmpdir()
    const filename = `${tmp.path}/fresh.sqlite`
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    using db = new SQLite(filename, { readonly: true })
    expect(db.query("SELECT count(*) AS count FROM migration").get()).toMatchObject({ count: expect.any(Number) })
  })

  test("accepts legacy workspace config and pre-name workspace shapes with canonical project edges", () => {
    for (const fields of ["config TEXT", "type TEXT, directory TEXT, extra TEXT"]) {
      using db = new SQLite(":memory:")
      db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY);
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE);
        CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, ${fields}, project_id TEXT REFERENCES project(id) ON DELETE CASCADE);
      `)
      if (!fields.startsWith("config"))
        db.exec("CREATE TABLE migration (id TEXT); INSERT INTO migration VALUES ('20260303231226_add_workspace_fields')")
      expect(() => DatabaseCompatibility.check("legacy.sqlite", (sql) => db.query(sql).all())).not.toThrow()
    }
  })

  test("does not assume an unfamiliar FK on a known project child is safe", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE SET NULL);
    `)
    expect(() => DatabaseCompatibility.check("altered.sqlite", (sql) => db.query(sql).all())).toThrow(
      "unsupported project-child foreign key session.project_id -> project.id (SET NULL)",
    )
  })

  test("does not overlook case-varied or composite project FKs", () => {
    for (const child of [
      "CREATE TABLE worktree (project_id TEXT REFERENCES PROJECT(id) ON DELETE CASCADE)",
      "CREATE TABLE session (project_id TEXT, other_project_id TEXT, FOREIGN KEY (project_id, other_project_id) REFERENCES project(id, id) ON DELETE CASCADE)",
    ]) {
      using db = new SQLite(":memory:")
      db.exec("CREATE TABLE project (id TEXT PRIMARY KEY)")
      if (!child.includes("TABLE session")) db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)")
      db.exec(child)
      expect(() => DatabaseCompatibility.check("fk.sqlite", (sql) => db.query(sql).all())).toThrow(
        "unsupported project-child foreign key",
      )
    }
  })

  test("does not let stale config columns bypass a completed workspace-fields migration", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, project_id TEXT, config TEXT);
      CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER);
      INSERT INTO migration VALUES ('20260303231226_add_workspace_fields', 1);
    `)
    expect(() => DatabaseCompatibility.check("workspace.sqlite", (sql) => db.query(sql).all())).toThrow(
      "workspace has incompatible columns: missing type, directory, extra",
    )
  })

  for (const field of ["type", "name", "directory", "extra"]) {
    test(`rejects config-era workspace with ${field} already added before pending ALTERs`, () => {
      using db = new SQLite(":memory:")
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, project_id TEXT, config TEXT, ${field} TEXT);
      `)
      expect(() => DatabaseCompatibility.check("partial-workspace.sqlite", (sql) => db.query(sql).all())).toThrow(
        `workspace has incompatible columns: ${field} already present before pending migration 20260303231226_add_workspace_fields`,
      )
    })
  }

  for (const journal of ["migration (wrong_column TEXT)", "__drizzle_migrations (wrong_column TEXT)"]) {
    test(`preserves SQL failure cause and database path for malformed ${journal}`, () => {
      using db = new SQLite(":memory:")
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE ${journal}`)
      const error = (() => {
        try {
          DatabaseCompatibility.check("/diagnostic/malformed.sqlite", (sql) => db.query(sql).all())
        } catch (error) {
          return error
        }
      })()
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("Expected inspection to fail")
      expect(error.message).toContain("/diagnostic/malformed.sqlite")
      expect(error.message).toContain("Refusing to open for writes or run migrations")
      expect(error.message).toContain("SQL: SELECT")
      expect(error.cause).toBeInstanceOf(Error)
      expect(String(error.cause)).toContain("no such column")
    })
  }

  test("uses the populated modern journal instead of stale legacy completion records", () => {
    using db = new SQLite(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER);
      INSERT INTO migration VALUES ('unknown_migration', 1);
      CREATE TABLE __drizzle_migrations (name TEXT);
      INSERT INTO __drizzle_migrations VALUES ('20260511000411_data_migration_state');
    `)
    expect(() => DatabaseCompatibility.check("journal.sqlite", (sql) => db.query(sql).all())).not.toThrow()
  })

  for (const journal of ["migration", "__drizzle_migrations"]) {
    test(`does not mistake unknown timestamp-like names for completed migrations in ${journal}`, () => {
      using db = new SQLite(":memory:")
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE ${journal} (${journal === "migration" ? "id" : "name"} TEXT);
        INSERT INTO ${journal} VALUES ('20260511000411');
        INSERT INTO ${journal} VALUES ('20260511000411_unrelated_migration');
      `)
      expect(() => DatabaseCompatibility.check("unknown.sqlite", (sql) => db.query(sql).all())).not.toThrow()
    })
  }

  for (const journal of ["migration", "named", "timestamp"] as const) {
    for (const stage of [
      "20260225215848_workspace",
      "20260303231226_add_workspace_fields",
      "20260413175956_chief_energizer",
      "20260511000411_data_migration_state",
      "20260601202201_amazing_prowler",
      "20260602002951_lowly_union_jack",
      "20260603040000_session_message_projection_order",
      "20260605042240_add_context_epoch_agent",
    ]) {
      test(`upgrades supported ${journal} legacy state through ${stage} preserving canonical history`, async () => {
        await using tmp = await tmpdir()
        const filename = `${tmp.path}/legacy.sqlite`
        const index = migrations.findIndex((migration) => migration.id === stage)
        expect(index).toBeGreaterThanOrEqual(0)
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const db = yield* EffectDrizzleSqlite.makeWithDefaults()
              yield* DatabaseMigration.applyOnly(db, migrations.slice(0, index + 1))
            }).pipe(Effect.provide(layer({ filename }))),
          ),
        )
        using writer = new SQLite(filename)
        writer.exec(`
          PRAGMA foreign_keys = ON;
          INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]');
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'project', 'legacy', '/repo', 'Legacy history', 'test', 1, 1);
          INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{"role":"user","time":{"created":1}}');
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{"type":"text","text":"legacy history"}');
        `)
        if (stage === "20260511000411_data_migration_state")
          writer.exec(
            `INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('pre-seq', 'session', 'user', 1, 1, '{"parts":[{"type":"text","text":"pre-launch projection"}]}')`,
          )
        if (journal !== "migration") {
          writer.exec(`CREATE TABLE __drizzle_migrations (${journal === "named" ? "name TEXT" : "created_at INTEGER"})`)
          for (const migration of migrations.slice(0, index + 1)) {
            const id = migration.id
            writer
              .query("INSERT INTO __drizzle_migrations VALUES (?)")
              .run(
                journal === "named"
                  ? id
                  : Date.parse(
                      `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}Z`,
                    ),
              )
          }
          writer.exec("DROP TABLE migration")
        }
        // Unknown named IDs are harmless to the runner and must not become a version gate.
        if (journal === "migration") writer.exec("INSERT INTO migration VALUES ('unknown_migration', 1)")
        if (journal === "named") writer.exec("INSERT INTO __drizzle_migrations VALUES ('unknown_migration')")
        const history = ["message", "part"].map((table) => writer.query(`SELECT * FROM ${table}`).all())
        expect(() => DatabaseCompatibility.check(filename, (sql) => writer.query(sql).all())).not.toThrow()
        await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
        if (stage === "20260511000411_data_migration_state")
          expect(writer.query("SELECT id FROM session_message WHERE id = 'pre-seq'").all()).toEqual([])
        expect(["message", "part"].map((table) => writer.query(`SELECT * FROM ${table}`).all())).toEqual(history)
        expect(writer.query("SELECT id, title, project_id FROM session").all()).toEqual([
          { id: "session", title: "Legacy history", project_id: "project" },
        ])
        expect(writer.query("SELECT id FROM project").all()).toEqual([{ id: "project" }])
        expect(writer.query("SELECT name FROM sqlite_master WHERE name = 'data_migration'").all()).toEqual([
          { name: "data_migration" },
        ])
        expect(writer.query("SELECT count(*) AS count FROM migration").get()).toEqual({
          count: migrations.length + (journal === "timestamp" ? 0 : 1),
        })
        expect(writer.query("PRAGMA foreign_key_check").all()).toEqual([])
        // Reopening verifies the final schema and journal pass the same admission check.
        await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
      })
    }
  }
})
