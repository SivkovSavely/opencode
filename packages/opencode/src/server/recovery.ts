import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit } from "effect"
import { RuntimeLifecycle } from "./runtime-lifecycle"

export const initialize = Effect.fn("ServerRecovery.initialize")(function* () {
  const current = RuntimeLifecycle.current()
  if (!current) return
  const runtime = current

  const { AppRuntime } = yield* Effect.promise(() => import("../effect/app-runtime"))
  const { InstanceStore } = yield* Effect.promise(() => import("../project/instance-store"))
  const { Session } = yield* Effect.promise(() => import("../session/session"))
  const { SessionPrompt } = yield* Effect.promise(() => import("../session/prompt"))
  const { SessionID, MessageID, PartID } = yield* Effect.promise(() => import("../session/schema"))
  const { Database } = yield* Effect.promise(() => import("@opencode-ai/core/database/database"))
  const { sql } = yield* Effect.promise(() => import("drizzle-orm"))
  const { renderOutput } = yield* Effect.promise(() => import("../tool/task"))

  yield* Effect.logInfo("runtime recovery startup", {
    lineage: runtime.identity.lineage,
    instance: runtime.identity.instance,
    restartSupported: runtime.identity.restartSupported,
  })
  yield* Effect.promise(() =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const database = yield* Database.Service
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const staleParents = yield* database.db.all<{ session_id: string; directory: string }>(sql`
          SELECT session_id, directory FROM runtime_execution
          WHERE owner_lineage = ${runtime.identity.lineage}
            AND desired_active = 1 AND state IN ('active', 'waiting_child', 'completed')
        `)
        let reconstructed = 0
        for (const parent of staleParents) {
          if ((yield* runtime.verifyOwner(parent.session_id)) !== "dead") continue
          reconstructed += yield* store
            .provide({ directory: parent.directory }, reconstructChildren(parent.session_id))
            .pipe(
              Effect.catchCause((cause) => {
                const error = Cause.squash(cause)
                return Effect.logWarning("Task child reconstruction failed; parent history will remain recoverable", {
                  parentSessionID: parent.session_id,
                  errorType: error instanceof Error ? error.name : typeof error,
                }).pipe(Effect.as(0))
              }),
            )
        }
        if (reconstructed > 0)
          yield* Effect.logWarning("runtime recovery reconstructed missing Task child prompts", {
            count: reconstructed,
          })

        const children = yield* database.db.all<{
          session_id: string
          directory: string
          owner_lineage: string
          owner_instance: string
          fence: number
          state: string
          retry_at: number | null
          parent_session_id: string | null
          parent_message_id: string | null
          parent_call_id: string | null
          parent_mode: "foreground" | "background" | null
          parent_notification_state: "pending" | "delivering" | "delivered" | null
          recovery_attempts: number
        }>(sql`
          SELECT session_id, directory, owner_lineage, owner_instance, fence, state, retry_at,
                 parent_session_id, parent_message_id, parent_call_id, parent_mode,
                 parent_notification_state, recovery_attempts
          FROM runtime_execution
          WHERE desired_active = 1 AND state = ${"completed"}
            AND owner_lineage = ${runtime.identity.lineage}
            AND parent_mode = ${"foreground"}
        `)
        for (const child of children) {
          const record = {
            sessionID: child.session_id,
            directory: child.directory,
            ownerLineage: child.owner_lineage,
            ownerInstance: child.owner_instance,
            fence: child.fence,
            state: "completed" as const,
            retryAt: child.retry_at ?? undefined,
            parentSessionID: child.parent_session_id ?? undefined,
            parentMessageID: child.parent_message_id ?? undefined,
            parentCallID: child.parent_call_id ?? undefined,
            parentMode: child.parent_mode ?? undefined,
            parentNotificationState: child.parent_notification_state ?? undefined,
            recoveryAttempts: child.recovery_attempts,
          }
          const result = yield* store.provide({ directory: record.directory }, childResult(record)).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              return Effect.logWarning("completed foreground Task result could not be loaded", {
                childSessionID: record.sessionID,
                parentSessionID: record.parentSessionID,
                errorType: error instanceof Error ? error.name : typeof error,
              }).pipe(Effect.as(undefined))
            }),
          )
          if (result)
            yield* store.provide({ directory: record.directory }, settleForeground(record, result)).pipe(
              Effect.catchCause((cause) => {
                const error = Cause.squash(cause)
                return Effect.logWarning("completed foreground Task result could not be persisted", {
                  childSessionID: record.sessionID,
                  parentSessionID: record.parentSessionID,
                  errorType: error instanceof Error ? error.name : typeof error,
                })
              }),
            )
        }

        yield* runtime.recover((record) =>
          store.provide(
            { directory: record.directory },
            Effect.gen(function* () {
              if (record.state === "completed") {
                const result = yield* childResult(record)
                if (result && record.parentMode === "background") yield* notifyBackground(record, result)
                return
              }
              const result = yield* prompt.recover(SessionID.make(record.sessionID))
              if (record.parentMode === "foreground") yield* settleForeground(record, result)
            }),
          ),
        )

        function childResult(record: { sessionID: string }) {
          return Effect.gen(function* () {
            const messages = yield* sessions
              .messages({ sessionID: SessionID.make(record.sessionID) })
              .pipe(Effect.orDie)
            const assistant = messages.findLast((message) => message.info.role === "assistant")
            return assistant
          })
        }

        function reconstructChildren(parentSessionID: string) {
          return Effect.gen(function* () {
            const parentID = SessionID.make(parentSessionID)
            const messages = yield* sessions.messages({ sessionID: parentID }).pipe(Effect.orDie)
            let count = 0
            for (const message of messages) {
              if (message.info.role !== "assistant") continue
              for (const part of message.parts) {
                if (part.type !== "tool" || part.tool !== "task") continue
                if (part.state.status !== "running" && part.state.status !== "completed") continue
                const metadata = part.state.metadata
                if (!metadata || typeof metadata !== "object") continue
                if (part.state.status === "completed" && metadata.background !== true) continue
                const childSessionID = metadata.sessionId
                const childMessageID = metadata.messageID
                const model = metadata.model
                const taskInput = part.state.input
                if (
                  typeof childSessionID !== "string" ||
                  metadata.parentSessionId !== parentSessionID ||
                  typeof childMessageID !== "string" ||
                  !childMessageID.startsWith("msg") ||
                  !taskInput ||
                  typeof taskInput.prompt !== "string" ||
                  !model ||
                  typeof model !== "object" ||
                  typeof model.modelID !== "string" ||
                  model.modelID.length === 0 ||
                  typeof model.providerID !== "string" ||
                  model.providerID.length === 0
                )
                  continue
                const childID = SessionID.make(childSessionID)
                const child = yield* sessions.get(childID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                if (!child || child.parentID !== parentSessionID) continue
                const parent = yield* sessions.get(parentID).pipe(Effect.orDie)
                if (child.directory !== parent.directory || child.workspaceID !== parent.workspaceID) continue
                const agent = child.agent ?? taskInput.subagent_type
                if (typeof agent !== "string" || agent.length === 0) continue
                const existing = yield* database.db.get<{
                  parent_session_id: string | null
                  parent_message_id: string | null
                  parent_call_id: string | null
                  parent_mode: "foreground" | "background" | null
                  owner_instance: string
                  state: string
                }>(sql`
                  SELECT parent_session_id, parent_message_id, parent_call_id, parent_mode, owner_instance, state
                  FROM runtime_execution WHERE session_id = ${childSessionID}
                `)
                if (
                  existing &&
                  (existing.parent_session_id !== parentSessionID ||
                    existing.parent_message_id !== message.info.id ||
                    existing.parent_call_id !== part.callID ||
                    !["active", "waiting_child", "parked", "retry_wait"].includes(existing.state))
                )
                  continue
                if (
                  existing &&
                  ["active", "waiting_child"].includes(existing.state) &&
                  (yield* runtime.verifyOwner(childSessionID)) !== "dead"
                )
                  continue
                if (
                  existing &&
                  metadata.background === true &&
                  existing.parent_mode !== "background" &&
                  existing.owner_instance !== runtime.identity.instance &&
                  (yield* runtime.verifyOwner(childSessionID)) !== "dead"
                )
                  continue
                if (existing && metadata.background === true && existing.parent_mode !== "background")
                  yield* runtime.setParentMode(childSessionID, "background")
                const resolved = yield* prompt.resolvePromptParts(taskInput.prompt)
                yield* prompt.prompt({
                  sessionID: childID,
                  messageID: MessageID.make(childMessageID),
                  agent,
                  model: { modelID: model.modelID, providerID: model.providerID },
                  variant:
                    metadata.inheritVariant === true
                      ? message.info.variant
                      : typeof metadata.variant === "string"
                        ? metadata.variant
                        : undefined,
                  idempotent: true,
                  noReply: true,
                  parts: resolved.map((item, index) => ({
                    ...item,
                    id: PartID.ascending(`prt_task_recovery_${childMessageID}_${index}`),
                  })),
                })
                const recovered = existing
                  ? true
                  : yield* runtime.reconstructChild({
                      sessionID: childSessionID,
                      directory: child.directory,
                      parentSessionID,
                      parentMessageID: message.info.id,
                      parentCallID: part.callID,
                      parentMode: metadata.background === true ? "background" : "foreground",
                    })
                if (recovered) count++
              }
            }
            return count
          })
        }

        function taskOutcome(sessionID: string, result: SessionV1.WithParts) {
          const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
          const assistant = result.info.role === "assistant" ? result.info : undefined
          const failed = result.parts.findLast((part) => part.type === "tool" && part.state.status === "error")
          if (assistant?.error) {
            const error = assistant.error.data
            const message =
              "message" in error && typeof error.message === "string" ? error.message : assistant.error.name
            return { state: "error" as const, text: `Subagent failed (task_id: ${sessionID}): ${message}` }
          }
          if (failed?.type === "tool" && failed.state.status === "error")
            return { state: "error" as const, text: `Subagent failed (task_id: ${sessionID}): ${failed.state.error}` }
          return { state: "completed" as const, text }
        }

        function settleForeground(
          record: {
            sessionID: string
            parentSessionID?: string
            parentMessageID?: string
            parentCallID?: string
          },
          result: SessionV1.WithParts,
        ) {
          return Effect.gen(function* () {
            if (!record.parentSessionID || !record.parentMessageID || !record.parentCallID) return
            const parentExecution = yield* database.db.get<{ state: string }>(sql`
              SELECT state FROM runtime_execution WHERE session_id = ${record.parentSessionID}
            `)
            if (parentExecution?.state === "cancelled") {
              yield* Effect.logInfo("foreground Task result not delivered to cancelled parent", {
                childSessionID: record.sessionID,
                parentSessionID: record.parentSessionID,
              })
              return
            }
            const parentSessionID = SessionID.make(record.parentSessionID)
            const messages = yield* sessions.messages({ sessionID: parentSessionID }).pipe(Effect.orDie)
            const message = messages.find((item) => item.info.id === record.parentMessageID)
            const part = message?.parts.find(
              (item) => item.type === "tool" && item.tool === "task" && item.callID === record.parentCallID,
            )
            if (part?.type !== "tool" || part.state.status !== "running") {
              yield* Effect.logWarning("foreground Task recovery could not update the original parent call", {
                childSessionID: record.sessionID,
                parentSessionID: record.parentSessionID,
                parentMessageID: record.parentMessageID,
                parentCallID: record.parentCallID,
                reason: part?.type === "tool" ? `parent tool is ${part.state.status}` : "parent call is missing",
              })
              return
            }
            if (part.state.metadata?.sessionId !== record.sessionID) {
              yield* Effect.logWarning("foreground Task recovery link does not match parent metadata", {
                childSessionID: record.sessionID,
                parentSessionID: record.parentSessionID,
                parentCallID: record.parentCallID,
              })
              return
            }
            const outcome = taskOutcome(record.sessionID, result)
            const time = { start: part.state.time.start, end: Date.now() }
            yield* sessions.updatePart(
              outcome.state === "completed"
                ? {
                    ...part,
                    state: {
                      status: "completed",
                      input: part.state.input,
                      output: renderOutput({
                        sessionID: SessionID.make(record.sessionID),
                        state: "completed",
                        text: outcome.text,
                      }),
                      title: part.state.title ?? "Subagent task",
                      metadata: part.state.metadata ?? {},
                      time,
                    },
                  }
                : {
                    ...part,
                    state: {
                      status: "error",
                      input: part.state.input,
                      error: outcome.text,
                      metadata: part.state.metadata,
                      time,
                    },
                  },
            )
            yield* Effect.logInfo("foreground Task recovery settled parent call", {
              childSessionID: record.sessionID,
              parentSessionID: record.parentSessionID,
              parentCallID: record.parentCallID,
              outcome: outcome.state,
            })
          })
        }

        function notifyBackground(
          record: {
            sessionID: string
            parentSessionID?: string
            parentMessageID?: string
            parentCallID?: string
          },
          result: SessionV1.WithParts,
        ) {
          return Effect.gen(function* () {
            if (!record.parentSessionID || !record.parentCallID) return
            const outcome = taskOutcome(record.sessionID, result)
            const parentSessionID = SessionID.make(record.parentSessionID)
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) yield* Effect.sleep(attempt === 1 ? "1 second" : "5 seconds")
              const claimed = yield* runtime.claimParentNotification(record.sessionID, record.parentCallID)
              if (!claimed) {
                yield* Effect.logInfo("background Task notification was already delivered or remains owned", {
                  childSessionID: record.sessionID,
                  parentSessionID: record.parentSessionID,
                })
                return
              }
              const delivered = yield* Effect.exit(
                Effect.gen(function* () {
                  const messages = yield* sessions.messages({ sessionID: parentSessionID }).pipe(Effect.orDie)
                  const parentMessage = messages.find((item) => item.info.id === record.parentMessageID)
                  const variant = parentMessage?.info.role === "assistant" ? parentMessage.info.variant : undefined
                  const taskPart = parentMessage?.parts.find(
                    (item) => item.type === "tool" && item.tool === "task" && item.callID === record.parentCallID,
                  )
                  const description =
                    taskPart?.type === "tool" && "title" in taskPart.state ? taskPart.state.title : undefined
                  const parent = yield* sessions.get(parentSessionID).pipe(Effect.orDie)
                  yield* prompt
                    .prompt(
                      {
                        sessionID: parentSessionID,
                        messageID: MessageID.ascending(`msg_task_notification_${record.sessionID}`),
                        agent: parent.agent,
                        variant,
                        idempotent: true,
                        parts: [
                          {
                            id: PartID.ascending(`prt_task_notification_${record.sessionID}`),
                            type: "text",
                            synthetic: true,
                            text: renderOutput({
                              sessionID: SessionID.make(record.sessionID),
                              state: outcome.state,
                              summary: `${outcome.state === "completed" ? "Background task completed" : "Background task failed"}${description ? `: ${description}` : ""}`,
                              text: outcome.text,
                            }),
                          },
                        ],
                      },
                      { notification: true },
                    )
                    .pipe(
                      Effect.tap(() => runtime.acknowledgeParentNotification(record.sessionID, record.parentCallID)),
                    )
                }),
              )
              if (Exit.isSuccess(delivered)) return
              yield* runtime.releaseParentNotificationClaim(record.sessionID, record.parentCallID)
              const error = Cause.squash(delivered.cause)
              yield* Effect.logWarning("background Task recovery notification retry scheduled", {
                childSessionID: record.sessionID,
                parentSessionID: record.parentSessionID,
                parentCallID: record.parentCallID,
                attempt: attempt + 1,
                errorType: error instanceof Error ? error.name : typeof error,
              })
            }
          })
        }
      }),
    ),
  )
  yield* Effect.logInfo("runtime recovery scheduling complete", {
    lineage: runtime.identity.lineage,
    instance: runtime.identity.instance,
    note: "Eligible executions are claimed atomically and recovered asynchronously.",
  })
})

export * as ServerRecovery from "./recovery"
