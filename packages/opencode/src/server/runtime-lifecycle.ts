import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { sql } from "drizzle-orm"
import { Clock, Context, Deferred, Duration, Effect, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { randomUUID } from "node:crypto"

export type Action = "restart" | "shutdown"
export type Phase = "running" | "draining" | "quiescent" | "stopping"
export type ExecutionState =
  | "active"
  | "retry_wait"
  | "parked"
  | "waiting_child"
  | "completed"
  | "cancelled"
  | "recovery_needed"

export class RuntimeDrainingError extends Schema.TaggedErrorClass<RuntimeDrainingError>()("RuntimeDrainingError", {
  message: Schema.String,
}) {}

export type ExecutionRecord = {
  sessionID: string
  directory: string
  ownerLineage: string
  ownerInstance: string
  fence: number
  state: ExecutionState
  retryAt?: number
  parentSessionID?: string
  parentMessageID?: string
  parentCallID?: string
}

export type Interface = {
  readonly identity: {
    readonly lineage: string
    readonly instance: string
    readonly restartSupported: boolean
  }
  readonly bindDatabase: (database: Database.Interface) => void
  readonly admit: (input: {
    sessionID: string
    directory: string
    parentSessionID?: string
    parentMessageID?: string
    parentCallID?: string
  }) => Effect.Effect<void, RuntimeDrainingError>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly beforeTurn: (sessionID: string) => Effect.Effect<boolean>
  readonly checkpoint: (sessionID: string) => Effect.Effect<boolean>
  readonly retry: (sessionID: string, retryAt: number) => Effect.Effect<void>
  readonly resumeRetry: (sessionID: string) => Effect.Effect<boolean>
  readonly park: (sessionID: string) => Effect.Effect<void>
  readonly complete: (sessionID: string) => Effect.Effect<void>
  readonly awaitDraining: Effect.Effect<void>
  readonly awaitDrain: Effect.Effect<void>
  readonly awaitStop: Effect.Effect<{ action: Action }>
  readonly request: (action: Action) => Effect.Effect<Status>
  readonly status: () => Effect.Effect<Status>
  readonly isParked: (sessionID: string) => Effect.Effect<boolean>
  readonly recover: (run: (record: ExecutionRecord) => Effect.Effect<unknown>) => Effect.Effect<void>
}

export type Status = {
  state: Phase
  action?: Action
  active: number
  parked: number
  restartSupported: boolean
  lineage: string
  instance: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RuntimeLifecycle") {}

type Row = {
  id: string
  session_id: string
  directory: string
  owner_lineage: string
  owner_instance: string
  fence: number
  state: ExecutionState
  desired_active: number
  retry_at: number | null
  parent_session_id: string | null
  parent_message_id: string | null
  parent_call_id: string | null
}

type LocalExecution = {
  fence: number
  leases: number
  mode: "active" | "retry_wait" | "parked"
  retryAt?: number
}

type LocalState = {
  phase: Phase
  action?: Action
  drainStarted: boolean
  active: Map<string, LocalExecution>
}

type ReleaseResult = {
  released: boolean
  reason: "absent" | "lease_decrement" | "removed"
  phase: Phase
  mode?: LocalExecution["mode"]
  fence?: number
  leases?: number
  nextState?: ExecutionState
}

type RetryResult = {
  parked: boolean
  reason: "absent" | "scheduled" | "draining"
  phase: Phase
  mode?: LocalExecution["mode"]
  fence?: number
}

type ResumeResult = {
  resumed: boolean
  phase: Phase
  mode?: LocalExecution["mode"]
  fence?: number
}

export type MakeInput = {
  lineage: string
  instance?: string
  restartSupported?: boolean
}

let active: Interface | undefined

export function setCurrent(runtime: Interface) {
  active = runtime
}

export function current() {
  return active
}

export function make(input: MakeInput, scope: Scope.Scope, database?: Database.Interface): Interface {
  const identity = {
    lineage: input.lineage,
    instance: input.instance ?? randomUUID(),
    restartSupported: input.restartSupported ?? false,
  }
  const ref = SynchronizedRef.makeUnsafe<LocalState>({
    phase: "running",
    drainStarted: false,
    active: new Map(),
  })
  const drained = Deferred.makeUnsafe<void>()
  const draining = Deferred.makeUnsafe<void>()
  const stopped = Deferred.makeUnsafe<{ action: Action }>()
  const databaseRef: { current?: Database.Interface } = { current: database }

  const read = Effect.fnUntraced(function* (sessionID: string) {
    const database = databaseRef.current ?? (yield* Database.Service)
    return decodeRow(yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${sessionID}`))
  })

  const update = Effect.fnUntraced(function* (
    sessionID: string,
    fence: number,
    state: ExecutionState,
    retryAt?: number,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    yield* database.db.run(sql`
      UPDATE runtime_execution
      SET state = ${state}, retry_at = ${retryAt ?? null}, time_updated = ${Date.now()}
      WHERE session_id = ${sessionID}
        AND owner_lineage = ${identity.lineage}
        AND owner_instance = ${identity.instance}
        AND fence = ${fence}
    `)
  })

  const claim = Effect.fnUntraced(function* (record: Row) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const nextFence = record.fence + 1
    yield* Effect.logInfo("restart diagnostic recovery claim attempted", {
      ...rowFields(record),
      replacementInstance: identity.instance,
      nextFence,
      lineage: identity.lineage,
    })
    yield* database.db.run(sql`
      UPDATE runtime_execution
      SET owner_instance = ${identity.instance}, fence = ${nextFence},
          state = ${record.retry_at === null ? "active" : "retry_wait"}, retry_at = ${record.retry_at},
          time_updated = ${Date.now()}
      WHERE session_id = ${record.session_id}
        AND owner_lineage = ${identity.lineage}
        AND owner_instance = ${record.owner_instance}
        AND fence = ${record.fence}
        AND state IN ('parked', 'retry_wait')
        AND desired_active = 1
    `)
    const current = decodeRow(
      yield* database.db.get(sql`
        SELECT * FROM runtime_execution
        WHERE session_id = ${record.session_id} AND owner_instance = ${identity.instance} AND fence = ${nextFence}
      `),
    )
    if (!current) {
      const latest = decodeRow(
        yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${record.session_id}`),
      )
      yield* Effect.logWarning("restart diagnostic recovery claim failed", {
        ...rowFields(record),
        replacementInstance: identity.instance,
        nextFence,
        current: latest ? rowFields(latest) : undefined,
      })
      return undefined
    }
    const result = toExecutionRecord(current)
    yield* Effect.logInfo("restart diagnostic recovery claim succeeded", {
      ...recordFields(result),
      newOwnerInstance: identity.instance,
      newState: result.state,
      newFence: result.fence,
    })
    return result
  })

  const checkQuiescent = Effect.fnUntraced(function* () {
    const shouldStop = yield* SynchronizedRef.modify(ref, (state) => {
      if (state.phase !== "draining" || state.active.size > 0) return [false, state] as const
      return [true, { ...state, phase: "quiescent" }] as const
    })
    if (!shouldStop) return
    yield* Effect.logInfo("restart diagnostic quiescence transition", {
      phase: "draining -> quiescent -> stopping",
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* Deferred.succeed(drained, undefined).pipe(Effect.ignore)
    yield* SynchronizedRef.update(ref, (state) => ({ ...state, phase: "stopping" as const }))
    yield* Deferred.succeed(stopped, { action: SynchronizedRef.getUnsafe(ref).action! }).pipe(Effect.ignore)
    yield* Effect.logInfo("runtime quiescent", { lineage: identity.lineage, instance: identity.instance })
  })

  const parkRetrying = Effect.fnUntraced(function* () {
    const ids = [...SynchronizedRef.getUnsafe(ref).active.entries()]
      .filter(([, execution]) => execution.mode === "retry_wait")
      .map(([sessionID]) => sessionID)
    yield* Effect.logInfo("restart diagnostic retry executions selected for immediate parking", {
      sessionIDs: ids,
      count: ids.length,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* Effect.forEach(ids, park, { concurrency: "unbounded", discard: true })
  })

  const request = Effect.fn("RuntimeLifecycle.request")(function* (action: Action) {
    const result = yield* SynchronizedRef.modify(
      ref,
      (state): readonly [{ accepted: boolean; action?: Action; started: boolean }, LocalState] => {
        if (state.phase === "running") {
          return [
            { accepted: true, action, started: true },
            { ...state, phase: "draining", action, drainStarted: true },
          ] as const
        }
        if (state.action === action) return [{ accepted: true, action, started: false }, state] as const
        return [{ accepted: false, action: state.action, started: false }, state] as const
      },
    )
    if (result.accepted) {
      yield* Deferred.succeed(draining, undefined).pipe(Effect.ignore)
      yield* Effect.logInfo("runtime draining requested", {
        action,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      if (result.started) {
        const local = SynchronizedRef.getUnsafe(ref).active
        yield* Effect.logInfo("restart diagnostic drain local execution snapshot", {
          action,
          count: local.size,
          lineage: identity.lineage,
          instance: identity.instance,
        })
        yield* Effect.forEach(
          [...local.entries()],
          ([sessionID, execution]) =>
            Effect.logInfo("restart diagnostic drain local execution", {
              sessionID,
              fence: execution.fence,
              leases: execution.leases,
              mode: execution.mode,
              retryAt: execution.retryAt,
              lineage: identity.lineage,
              instance: identity.instance,
            }),
          { concurrency: "unbounded", discard: true },
        )
      }
      yield* parkRetrying()
      yield* checkQuiescent()
    }
    return yield* status()
  })

  const admit = Effect.fn("RuntimeLifecycle.admit")(function* (input: {
    sessionID: string
    directory: string
    parentSessionID?: string
    parentMessageID?: string
    parentCallID?: string
  }) {
    const existing = yield* read(input.sessionID)
    const localAdmission = yield* SynchronizedRef.modify(ref, (state) => {
      const local = state.active.get(input.sessionID)
      if (!local) return ["none" as const, state]
      if (state.phase !== "running") return ["draining" as const, state]
      const active = new Map(state.active)
      active.set(input.sessionID, { ...local, leases: local.leases + 1, mode: "active" })
      return ["admitted" as const, { ...state, active }]
    })
    if (localAdmission === "draining") yield* new RuntimeDrainingError({ message: "Runtime is draining" })
    if (localAdmission === "admitted") return

    const claimed = yield* SynchronizedRef.modify(ref, (state) => {
      if (state.phase !== "running") {
        return [Effect.fail(new RuntimeDrainingError({ message: "Runtime is draining" })), state] as const
      }
      const work = Effect.gen(function* () {
        const database = databaseRef.current ?? (yield* Database.Service)
        const row = yield* read(input.sessionID)
        if (
          row &&
          row.state === "active" &&
          (row.owner_lineage !== identity.lineage || row.owner_instance !== identity.instance)
        ) {
          return yield* Effect.fail(new RuntimeDrainingError({ message: "Session is owned by another runtime" }))
        }
        if (row && row.state === "parked") {
          return yield* Effect.fail(new RuntimeDrainingError({ message: "Session is parked for recovery" }))
        }
        if (row && row.state === "retry_wait") {
          return yield* Effect.fail(new RuntimeDrainingError({ message: "Session is waiting for retry" }))
        }
        const fence = row?.fence ?? 0
        if (!row) {
          yield* database.db.run(sql`
            INSERT INTO runtime_execution
              (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, retry_at,
               parent_session_id, parent_message_id, parent_call_id, time_created, time_updated)
            VALUES
              (${input.sessionID}, ${input.sessionID}, ${input.directory}, ${identity.lineage}, ${identity.instance},
               ${fence}, ${"active"}, 1, NULL, ${input.parentSessionID ?? null}, ${input.parentMessageID ?? null},
               ${input.parentCallID ?? null}, ${Date.now()}, ${Date.now()})
          `)
        } else {
          yield* database.db.run(sql`
            UPDATE runtime_execution
            SET directory = ${input.directory}, owner_lineage = ${identity.lineage}, owner_instance = ${identity.instance},
                fence = ${fence}, state = ${"active"}, desired_active = 1, retry_at = NULL,
                parent_session_id = ${input.parentSessionID ?? null}, parent_message_id = ${input.parentMessageID ?? null},
                parent_call_id = ${input.parentCallID ?? null}, time_updated = ${Date.now()}
            WHERE session_id = ${input.sessionID} AND fence = ${fence}
          `)
        }
        return fence
      })
      const next = new Map(state.active)
      next.set(input.sessionID, { fence: existing?.fence ?? 0, leases: 1, mode: "active" })
      return [work, { ...state, active: next }] as const
    })
    yield* claimed
  })

  const release = Effect.fn("RuntimeLifecycle.release")(function* (sessionID: string) {
    const result = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (!current) {
          const result: ReleaseResult = { released: false, reason: "absent", phase: state.phase }
          return [result, state] as const
        }
        if (current.leases > 1) {
          const active = new Map(state.active)
          active.set(sessionID, { ...current, leases: current.leases - 1 })
          const result: ReleaseResult = {
            released: false,
            reason: "lease_decrement",
            phase: state.phase,
            mode: current.mode,
            fence: current.fence,
            leases: current.leases,
          }
          return [result, { ...state, active }] as const
        }
        const nextState = state.phase === "draining" ? "parked" : "completed"
        yield* update(sessionID, current.fence, nextState, current.mode === "retry_wait" ? current.retryAt : undefined)
        const active = new Map(state.active)
        active.delete(sessionID)
        const result: ReleaseResult = {
          released: true,
          reason: "removed",
          phase: state.phase,
          mode: current.mode,
          fence: current.fence,
          leases: current.leases,
          nextState,
        }
        return [result, { ...state, active }] as const
      }),
    )
    yield* Effect.logInfo("restart diagnostic release", {
      sessionID,
      result: result.reason,
      phase: result.phase,
      mode: result.mode,
      fence: result.fence,
      leases: result.leases,
      nextState: result.nextState,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    if (!result.released) return
    yield* Effect.logInfo("execution released", {
      sessionID,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* checkQuiescent()
  })

  const park = Effect.fn("RuntimeLifecycle.park")(function* (sessionID: string) {
    const parked = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (!current) return [false, state] as const
        yield* update(sessionID, current.fence, "parked", current.mode === "retry_wait" ? current.retryAt : undefined)
        const active = new Map(state.active)
        active.delete(sessionID)
        return [true, { ...state, active }] as const
      }),
    )
    if (!parked) {
      yield* Effect.logWarning("restart diagnostic park no-op; execution absent", {
        sessionID,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      return
    }
    yield* Effect.logInfo("restart diagnostic execution parked", {
      sessionID,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* Effect.logInfo("execution parked", { sessionID, lineage: identity.lineage, instance: identity.instance })
    yield* checkQuiescent()
  })

  const complete = Effect.fn("RuntimeLifecycle.complete")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    if (!current) {
      yield* Effect.logWarning("restart diagnostic complete no-op; execution absent", {
        sessionID,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      return
    }
    yield* update(sessionID, current.fence, "completed")
    yield* SynchronizedRef.update(ref, (state) => {
      const active = new Map(state.active)
      active.delete(sessionID)
      return { ...state, active }
    })
    yield* Effect.logInfo("restart diagnostic execution marked completed", {
      sessionID,
      fence: current.fence,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* checkQuiescent()
  })

  const beforeTurn = Effect.fn("RuntimeLifecycle.beforeTurn")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    const phase = SynchronizedRef.getUnsafe(ref).phase
    const allowed = phase === "running" && current?.mode === "active"
    if (!allowed)
      yield* Effect.logInfo("restart diagnostic beforeTurn rejected", {
        sessionID,
        phase,
        mode: current?.mode,
        fence: current?.fence,
        lineage: identity.lineage,
        instance: identity.instance,
      })
    return allowed
  })

  const checkpoint = Effect.fn("RuntimeLifecycle.checkpoint")(function* (sessionID: string) {
    if (SynchronizedRef.getUnsafe(ref).phase === "running") {
      yield* Effect.logInfo("restart diagnostic checkpoint reached while running", {
        sessionID,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      return true
    }
    yield* Effect.logInfo("restart diagnostic checkpoint rejected; parking execution", {
      sessionID,
      phase: SynchronizedRef.getUnsafe(ref).phase,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* park(sessionID)
    return false
  })

  const retry = Effect.fn("RuntimeLifecycle.retry")(function* (sessionID: string, retryAt: number) {
    const result = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (!current) {
          const result: RetryResult = { parked: false, reason: "absent", phase: state.phase }
          return [result, state] as const
        }
        yield* update(sessionID, current.fence, "retry_wait", retryAt)
        const active = new Map(state.active)
        if (state.phase === "running") {
          active.set(sessionID, { ...current, mode: "retry_wait", retryAt })
        } else {
          active.delete(sessionID)
        }
        const result: RetryResult = {
          parked: state.phase !== "running",
          reason: state.phase === "running" ? "scheduled" : "draining",
          phase: state.phase,
          mode: current.mode,
          fence: current.fence,
        }
        return [result, { ...state, active }] as const
      }),
    )
    yield* Effect.logInfo("restart diagnostic retry transition", {
      sessionID,
      retryAt,
      result: result.reason,
      phase: result.phase,
      mode: result.mode,
      fence: result.fence,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    if (result.parked) yield* checkQuiescent()
  })

  const resumeRetry = Effect.fn("RuntimeLifecycle.resumeRetry")(function* (sessionID: string) {
    const result = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (state.phase !== "running" || !current || current.mode !== "retry_wait") {
          const result: ResumeResult = {
            resumed: false,
            phase: state.phase,
            mode: current?.mode,
            fence: current?.fence,
          }
          return [result, state] as const
        }
        yield* update(sessionID, current.fence, "active")
        const active = new Map(state.active)
        active.set(sessionID, { ...current, mode: "active", retryAt: undefined })
        const result: ResumeResult = { resumed: true, phase: state.phase, mode: current.mode, fence: current.fence }
        return [result, { ...state, active }] as const
      }),
    )
    yield* Effect.logInfo("restart diagnostic resumeRetry", {
      sessionID,
      resumed: result.resumed,
      phase: result.phase,
      mode: result.mode,
      fence: result.fence,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    return result.resumed
  })

  const awaitDraining = Deferred.await(draining)
  const awaitDrain = Deferred.await(drained)
  const awaitStop = Deferred.await(stopped)

  const recover = Effect.fn("RuntimeLifecycle.recover")(function* (
    run: (record: ExecutionRecord) => Effect.Effect<unknown>,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const candidates = yield* database.db.all<Row>(sql`
      SELECT * FROM runtime_execution
      WHERE desired_active = 1 AND state NOT IN ('completed', 'cancelled')
      ORDER BY time_updated ASC
    `)
    const rows = candidates.filter(
      (row) => row.owner_lineage === identity.lineage && (row.state === "parked" || row.state === "retry_wait"),
    )
    yield* Effect.forEach(
      candidates,
      (row) =>
        Effect.logInfo("restart diagnostic recovery candidate", {
          ...rowFields(row),
          ownerLineageMatches: row.owner_lineage === identity.lineage,
          eligibleForRecovery: rows.includes(row),
          currentLineage: identity.lineage,
          currentInstance: identity.instance,
        }),
      { concurrency: "unbounded", discard: true },
    )
    yield* Effect.logInfo("restart diagnostic recovery scan summary", {
      totalNonterminalDesiredActive: candidates.length,
      sameLineageCandidates: candidates.filter((row) => row.owner_lineage === identity.lineage).length,
      eligibleParkedOrRetryWait: rows.length,
      currentLineage: identity.lineage,
      currentInstance: identity.instance,
    })
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const record = yield* claim(row)
          if (!record) return
          yield* SynchronizedRef.update(ref, (state) => {
            const active = new Map(state.active)
            active.set(record.sessionID, {
              fence: record.fence,
              leases: 0,
              mode: record.state === "retry_wait" ? "retry_wait" : "active",
              retryAt: record.retryAt,
            })
            return { ...state, active }
          })
          yield* Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const remainingMs = record.retryAt === undefined ? 0 : Math.max(0, record.retryAt - now)
            if (record.retryAt !== undefined) {
              yield* Effect.logInfo("restart diagnostic recovery retry deadline", {
                ...recordFields(record),
                now,
                remainingMs,
                expired: remainingMs === 0,
              })
            }
            if (record.retryAt !== undefined && remainingMs > 0) {
              yield* Effect.logInfo("restart diagnostic recovery retry sleep beginning", {
                sessionID: record.sessionID,
                retryAt: record.retryAt,
                remainingMs,
                lineage: identity.lineage,
                instance: identity.instance,
              })
              const wake = yield* Effect.raceFirst(
                Effect.sleep(Duration.millis(remainingMs)).pipe(Effect.as("retry_deadline" as const)),
                awaitDraining.pipe(Effect.as("runtime_drain" as const)),
              )
              yield* Effect.logInfo("restart diagnostic recovery retry wait ended", {
                sessionID: record.sessionID,
                retryAt: record.retryAt,
                wake,
                lineage: identity.lineage,
                instance: identity.instance,
              })
            } else if (record.retryAt !== undefined) {
              yield* Effect.logInfo("restart diagnostic recovery retry wait ended", {
                sessionID: record.sessionID,
                retryAt: record.retryAt,
                wake: "retry_deadline",
                lineage: identity.lineage,
                instance: identity.instance,
              })
            }
            if (record.state === "retry_wait") {
              const resumed = yield* resumeRetry(record.sessionID)
              if (!resumed) {
                const phase = SynchronizedRef.getUnsafe(ref).phase
                yield* Effect.logWarning("restart diagnostic recovery exited without running", {
                  ...recordFields(record),
                  reason: phase === "running" ? "resumeRetry_failed" : "runtime_drain",
                  lineage: identity.lineage,
                  instance: identity.instance,
                })
                return
              }
            }
            const recoveryRecord = { ...record, state: "active" as const, retryAt: undefined }
            yield* Effect.logInfo("restart diagnostic recovery run started", {
              ...recordFields(recoveryRecord),
              recoveryRecord,
            })
            yield* run(recoveryRecord).pipe(
              Effect.tap(() =>
                Effect.logInfo("restart diagnostic recovery run returned successfully", {
                  ...recordFields(recoveryRecord),
                }),
              ),
              Effect.tap(() => complete(record.sessionID)),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const current = SynchronizedRef.getUnsafe(ref).active.get(record.sessionID)
                  if (current) {
                    yield* update(record.sessionID, current.fence, "recovery_needed")
                    yield* SynchronizedRef.update(ref, (state) => {
                      const active = new Map(state.active)
                      active.delete(record.sessionID)
                      return { ...state, active }
                    })
                    yield* checkQuiescent()
                    yield* Effect.logWarning("restart diagnostic recovery row transitioned to recovery_needed", {
                      ...recordFields(record),
                      fence: current.fence,
                      lineage: identity.lineage,
                      instance: identity.instance,
                    })
                  }
                  yield* Effect.logError("restart diagnostic recovery failed", {
                    sessionID: record.sessionID,
                    errorType: error instanceof Error ? error.name : typeof error,
                    rowTransitioned: Boolean(current),
                    lineage: identity.lineage,
                    instance: identity.instance,
                  })
                }),
              ),
            )
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }),
      { concurrency: "unbounded", discard: true },
    )
  })

  const status = Effect.fn("RuntimeLifecycle.status")(function* () {
    const database = databaseRef.current ?? (yield* Database.Service)
    const local = SynchronizedRef.getUnsafe(ref)
    const parked = yield* database.db.get<{ count: number }>(sql`
      SELECT count(*) as count FROM runtime_execution
      WHERE owner_lineage = ${identity.lineage} AND desired_active = 1 AND state IN ('parked', 'retry_wait')
    `)
    return {
      state: local.phase,
      action: local.action,
      active: local.active.size,
      parked: parked?.count ?? 0,
      restartSupported: identity.restartSupported,
      lineage: identity.lineage,
      instance: identity.instance,
    }
  })

  const isParked = Effect.fnUntraced(function* (sessionID: string) {
    if (SynchronizedRef.getUnsafe(ref).active.has(sessionID)) return false
    const row = yield* read(sessionID)
    return row?.state === "parked" || row?.state === "retry_wait"
  })

  return {
    identity,
    bindDatabase(database: Database.Interface) {
      databaseRef.current = database
    },
    admit,
    release,
    beforeTurn,
    checkpoint,
    retry,
    resumeRetry,
    park,
    complete,
    awaitDraining,
    awaitDrain,
    awaitStop,
    request,
    status,
    isParked,
    recover,
  } as Interface
}

export function unavailable(): Interface {
  const identity = { lineage: "unavailable", instance: "unavailable", restartSupported: false }
  const status = { state: "running" as const, active: 0, parked: 0, ...identity }
  return {
    identity,
    bindDatabase() {},
    admit: () => Effect.void,
    release: () => Effect.void,
    beforeTurn: () => Effect.succeed(true),
    checkpoint: () => Effect.succeed(true),
    retry: () => Effect.void,
    resumeRetry: () => Effect.succeed(true),
    park: () => Effect.void,
    complete: () => Effect.void,
    awaitDraining: Effect.never,
    awaitDrain: Effect.never,
    awaitStop: Effect.never,
    request: () => Effect.succeed(status),
    status: () => Effect.succeed(status),
    isParked: () => Effect.succeed(false),
    recover: () => Effect.void,
  }
}

function decodeRow(value: unknown): Row | undefined {
  if (!value || typeof value !== "object") return
  return value as Row
}

function rowFields(row: Row) {
  return {
    sessionID: row.session_id,
    directory: row.directory,
    state: row.state,
    desiredActive: row.desired_active === 1,
    retryAt: row.retry_at,
    ownerLineage: row.owner_lineage,
    ownerInstance: row.owner_instance,
    fence: row.fence,
    parentSessionID: row.parent_session_id,
    parentMessageID: row.parent_message_id,
    parentCallID: row.parent_call_id,
  }
}

function recordFields(record: ExecutionRecord) {
  return {
    sessionID: record.sessionID,
    directory: record.directory,
    state: record.state,
    retryAt: record.retryAt,
    ownerLineage: record.ownerLineage,
    ownerInstance: record.ownerInstance,
    fence: record.fence,
    parentSessionID: record.parentSessionID,
    parentMessageID: record.parentMessageID,
    parentCallID: record.parentCallID,
  }
}

function toExecutionRecord(row: Row): ExecutionRecord {
  return {
    sessionID: row.session_id,
    directory: row.directory,
    ownerLineage: row.owner_lineage,
    ownerInstance: row.owner_instance,
    fence: row.fence,
    state: row.state,
    retryAt: row.retry_at ?? undefined,
    parentSessionID: row.parent_session_id ?? undefined,
    parentMessageID: row.parent_message_id ?? undefined,
    parentCallID: row.parent_call_id ?? undefined,
  }
}

const defaultLayer = Layer.succeed(Service)(unavailable())

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [Database.node] })

export * as RuntimeLifecycle from "./runtime-lifecycle"
