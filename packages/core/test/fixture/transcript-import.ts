import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../../src/database/database"
import { V1Migration } from "../../src/database/v1-migration"
import { SessionTable } from "../../src/session/sql"

export const transcriptIDs = {
  session: "ses_f002_import",
  user: "msg_000000000001aaaaaaaaaaaaaa",
  assistant: "msg_000000000002aaaaaaaaaaaaaa",
  first: "prt_000000000001aaaaaaaaaaaaaa",
  second: "prt_000000000002aaaaaaaaaaaaaa",
  file: "prt_000000000005aaaaaaaaaaaaaa",
  call: "call_import_read",
  toolPart: "prt_000000000008aaaaaaaaaaaaaa",
  durable: "msg_000000000003aaaaaaaaaaaaaa",
  shell: "msg_000000000004aaaaaaaaaaaaaa",
}

/** Synthetic V1 source rows run through the real importer. No V1 profile is read. */
export function importTranscriptFixture(
  db: Database.Interface["db"],
  directory: string,
  newerPrompts = 0,
  interruption: Record<string, unknown> = { interrupted: true },
) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('global',${directory},'[]',0,0)`,
    )
    yield* db.run(sql`INSERT INTO session_v2(id,project_id,slug,directory,version,time_created,time_updated,title)
      VALUES(${transcriptIDs.session},'global','f002',${directory},'test',1700000000000,1700000000100,'Imported closed history')`)
    const session = yield* db.select().from(SessionTable).get()
    const message = (id: string, role: "user" | "assistant", time: number): V1Migration.SourceMessage => ({
      id,
      session_id: transcriptIDs.session,
      time_created: time,
      time_updated: time + 100,
      data: JSON.stringify({
        role,
        time: { created: time, ...(role === "assistant" ? { completed: time + 10 } : {}) },
        agent: "retired-agent",
        ...(role === "user"
          ? { model: { providerID: "retired-provider", modelID: "retired-model" } }
          : {
              parentID: transcriptIDs.user,
              modelID: "retired-model",
              providerID: "retired-provider",
              mode: "build",
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              error: { name: "UnknownError", data: { message: "public assistant-error sentinel" } },
            }),
      }),
    })
    const part = (id: string, messageID: string, data: Record<string, unknown>): V1Migration.SourcePart => ({
      id,
      message_id: messageID,
      session_id: transcriptIDs.session,
      time_created: 1700000000001,
      time_updated: 1700000000002,
      data: JSON.stringify(data),
    })
    const result = V1Migration.transformSession({
      session: session!,
      hiddenMessageIDs: ["msg_hidden_import"],
      messages: [
        message(transcriptIDs.user, "user", 1700000000000),
        message(transcriptIDs.assistant, "assistant", 1700000000010),
        message(transcriptIDs.durable, "user", 1700000000050),
        message("msg_hidden_import", "user", 1700000000020),
      ],
      durableMessages: [
        {
          id: transcriptIDs.durable,
          session_id: transcriptIDs.session,
          type: "user",
          seq: 3,
          time_created: 1700000000050,
          time_updated: 1700000000050,
          data: JSON.stringify({ text: "preferred durable sentinel", time: { created: 1700000000050 } }),
        },
        {
          id: transcriptIDs.shell,
          session_id: transcriptIDs.session,
          type: "shell",
          seq: 4,
          time_created: 1700000000060,
          time_updated: 1700000000061,
          data: JSON.stringify({
            shellID: "sh_f002_import",
            command: "printf durable-shell sentinel",
            status: "exited",
            exit: 0,
            output: "durable-shell output sentinel",
            time: { created: 1700000000060, completed: 1700000000061 },
          }),
        },
      ],
      parts: [
        part("prt_shadow", transcriptIDs.durable, { type: "text", text: "excluded-stale-durable-sentinel" }),
        part(transcriptIDs.first, transcriptIDs.user, {
          type: "text",
          text: " first @notes.txt\n",
          time: { start: 1700000000001 },
        }),
        part(transcriptIDs.second, transcriptIDs.user, {
          type: "text",
          text: "\tsecond sentinel @retired-agent ",
          time: { start: 1700000000002 },
        }),
        part("prt_000000000003aaaaaaaaaaaaaa", transcriptIDs.user, {
          type: "text",
          text: "excluded-ignored-sentinel",
          ignored: true,
        }),
        part("prt_000000000004aaaaaaaaaaaaaa", transcriptIDs.user, {
          type: "text",
          text: "excluded-synthetic-sentinel",
          synthetic: true,
        }),
        part(transcriptIDs.file, transcriptIDs.user, {
          type: "file",
          mime: "text/plain",
          filename: "notes-sentinel.txt",
          url: `data:text/plain;base64,${Buffer.from("excluded-attachment-sentinel").toString("base64")}`,
        }),
        part("prt_000000000006aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "text",
          text: "public assistant sentinel",
          time: { start: 1700000000011 },
        }),
        part("prt_000000000007aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "reasoning",
          text: "excluded-reasoning-sentinel",
          time: { start: 1700000000011, end: 1700000000012 },
        }),
        part(transcriptIDs.toolPart, transcriptIDs.assistant, {
          type: "tool",
          callID: transcriptIDs.call,
          tool: "read",
          state: {
            status: "completed",
            input: { path: "public-input-sentinel" },
            output: "public-output-sentinel\n<script>not executable</script>",
            title: "Read fixture",
            metadata: { private: "excluded-metadata-sentinel" },
            time: { start: 1700000000012, end: 1700000000015 },
          },
        }),
        part("prt_000000000009aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "tool",
          callID: "call_import_error",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "printf public-shell-sentinel" },
            error: "public-error-sentinel ordinary interrupted wording",
            metadata: {},
            time: { start: 1700000000013, end: 1700000000016 },
          },
        }),
        part("prt_000000000010aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "tool",
          callID: "call_import_interrupted",
          tool: "read",
          state: {
            status: "error",
            input: { path: "public-interrupted-sentinel" },
            error: "explicit stop sentinel",
            metadata: interruption,
            time: { start: 1700000000013, end: 1700000000016 },
          },
        }),
        part("prt_000000000011aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "tool",
          callID: "call_import_question",
          tool: "question",
          state: {
            status: "pending",
            input: { question: "excluded-question-sentinel" },
            raw: "excluded-question-raw-sentinel",
          },
        }),
        part("prt_000000000012aaaaaaaaaaaaaa", transcriptIDs.assistant, {
          type: "tool",
          callID: "call_import_todo",
          tool: "todowrite",
          state: {
            status: "completed",
            input: { todos: "excluded-todo-sentinel" },
            output: "excluded-todo-output-sentinel",
            title: "Hidden todo",
            metadata: {},
            time: { start: 1700000000013, end: 1700000000016 },
          },
        }),
        part("prt_hidden", "msg_hidden_import", { type: "text", text: "excluded-hidden-sentinel" }),
      ],
    })
    for (const row of result.messages)
      yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
      VALUES(${row.id},${row.session_id},${row.type},${row.seq},${row.time_created},${row.time_updated},${JSON.stringify(row.data)})`)
    for (let index = 0; index < newerPrompts; index++)
      yield* db.run(sql`INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data)
      VALUES(${"msg_f002_tail_" + index},${transcriptIDs.session},'user',${index + 100},${1700000001000 + index},${1700000001000 + index},${JSON.stringify({ text: `Newer prompt ${index}`, time: { created: 1700000001000 + index } })})`)
    return result
  })
}
