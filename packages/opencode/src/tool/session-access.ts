import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionWatchV1 } from "@opencode-ai/schema/v1/session-watch"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { ManagedSkill } from "@/skill/managed"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Tool } from "./tool"

export const authorize = Effect.fn("SessionAccess.authorize")(function* (
  sessions: Session.Interface,
  database: Database.Interface,
  ctx: Tool.Context,
  permission: string,
  action: string,
  ids: readonly string[],
) {
  if (ManagedSkill.enabled || process.env.OPENCODE_MANAGED_PROFILE === "1")
    return yield* Effect.die(new Error("Independent session orchestration is unavailable in the managed profile"))
  const instance = yield* InstanceState.context
  const workspaceID = yield* WorkspaceRef
  const caller = yield* sessions.get(ctx.sessionID)
  if (
    caller.directory !== instance.directory ||
    caller.projectID !== instance.project.id ||
    caller.workspaceID !== workspaceID
  )
    return yield* Effect.die(new Error("Caller is outside the active project/directory/workspace"))
  const targets = yield* Effect.forEach([...new Set(ids)], (id) => sessions.get(SessionID.make(id)))
  for (const target of targets) {
    if (target.time.archived) return yield* Effect.die(new Error("Archived sessions cannot be controlled or monitored"))
    if (target.directory !== caller.directory || target.projectID !== caller.projectID) {
      const glob = `${target.directory.replaceAll("\\", "/").replace(/\/$/, "")}/*`
      yield* ctx.ask({
        permission: "external_directory",
        patterns: [glob],
        always: [glob],
        metadata: { directory: target.directory, projectID: target.projectID, action },
      })
    }
    const pattern = `${action}:${target.id}:${target.projectID}:${target.directory}:${target.workspaceID ?? "local"}`
    yield* ctx.ask({
      permission,
      patterns: [pattern],
      always: [pattern],
      metadata: {
        action,
        sessionID: target.id,
        projectID: target.projectID,
        directory: target.directory,
        workspaceID: target.workspaceID,
      },
    })
    if (
      !(yield* local(database, {
        sessionID: target.id,
        projectID: target.projectID,
        directory: target.directory,
        workspaceID: target.workspaceID,
      }))
    )
      return yield* Effect.die(
        new Error(
          "Independent session orchestration requires local placement; remote workspace dispatch is unavailable",
        ),
      )
  }
  return targets
})

// Registration is a durable, narrowly scoped authorization. A later explicit
// deny or changed scope revokes future wakes; an "ask" rule does not lose a
// previously approved watch merely because its approving UI disconnected.
export const durable = Effect.fn("SessionAccess.durable")(function* (input: {
  database: Database.Interface
  store: InstanceStore.Interface
  agents: Agent.Interface
  owner: string
  agent: string | null
  scopes: readonly SessionWatchV1.Scope[]
  permission: string
  actions: readonly { sessionID: string; action: string }[]
}) {
  if (ManagedSkill.enabled || process.env.OPENCODE_MANAGED_PROFILE === "1") return false
  const owner = input.scopes.find((scope) => scope.sessionID === input.owner)
  if (!owner) return false
  const rows = yield* Effect.forEach(input.scopes, (scope) =>
    input.database.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionID.make(scope.sessionID)))
      .get()
      .pipe(Effect.orDie),
  )
  if (
    rows.some(
      (row, index) =>
        !row ||
        row.time_archived !== null ||
        row.project_id !== input.scopes[index]?.projectID ||
        row.directory !== input.scopes[index]?.directory ||
        (row.workspace_id ?? undefined) !== input.scopes[index]?.workspaceID,
    )
  )
    return false
  if (!(yield* Effect.forEach(input.scopes, (scope) => local(input.database, scope))).every(Boolean)) return false
  return yield* input.store.provide(
    { directory: owner.directory },
    Effect.gen(function* () {
      const current = yield* InstanceState.context
      if (current.project.id !== owner.projectID || current.directory !== owner.directory) return false
      const agent = input.agent ? yield* input.agents.get(input.agent) : yield* input.agents.defaultInfo()
      if (!agent) return false
      const session = rows.find((row) => row?.id === owner.sessionID)
      if (!session) return false
      return input.actions.every((item) => {
        const target = input.scopes.find((scope) => scope.sessionID === item.sessionID)
        if (!target) return false
        const pattern = `${item.action}:${target.sessionID}:${target.projectID}:${target.directory}:${target.workspaceID ?? "local"}`
        if (
          Permission.evaluate(input.permission, pattern, agent.permission, session.permission ?? []).action === "deny"
        )
          return false
        return (
          (target.directory === owner.directory && target.projectID === owner.projectID) ||
          Permission.evaluate(
            "external_directory",
            `${target.directory.replaceAll("\\", "/").replace(/\/$/, "")}/*`,
            agent.permission,
            session.permission ?? [],
          ).action !== "deny"
        )
      })
        ? JSON.stringify(session.permission ?? [])
        : false
    }).pipe(
      Effect.provideService(WorkspaceRef, owner.workspaceID ? WorkspaceV2.ID.make(owner.workspaceID) : undefined),
    ),
  )
})

const local = Effect.fn("SessionAccess.local")(function* (database: Database.Interface, scope: SessionWatchV1.Scope) {
  if (Flag.OPENCODE_WORKSPACE_ID) return scope.workspaceID === Flag.OPENCODE_WORKSPACE_ID
  if (!scope.workspaceID) return true
  const workspace = yield* database.db
    .select()
    .from(WorkspaceTable)
    .where(eq(WorkspaceTable.id, WorkspaceV2.ID.make(scope.workspaceID)))
    .get()
    .pipe(Effect.orDie)
  if (!workspace || workspace.project_id !== scope.projectID) return false
  const target = yield* WorkspaceAdapterRuntime.target({
    id: workspace.id,
    type: workspace.type,
    name: workspace.name,
    branch: workspace.branch,
    directory: workspace.directory,
    extra: workspace.extra,
    projectID: workspace.project_id,
  })
  return target.type === "local" && target.directory === scope.directory
})

export * as SessionAccess from "./session-access"
