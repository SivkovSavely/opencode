import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { sql } from "drizzle-orm"
import { Cause, Clock, Context, Deferred, Duration, Effect, Layer, Schema, Scope, SynchronizedRef } from "effect"
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

export class RuntimeFencedTransitionError extends Schema.TaggedErrorClass<RuntimeFencedTransitionError>()(
  "RuntimeFencedTransitionError",
  {
    message: Schema.String,
    sessionID: Schema.String,
    operation: Schema.String,
  },
) {}

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
  readonly admit: (input: AdmissionInput) => Effect.Effect<void, RuntimeDrainingError>
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
  readonly recover: (run: (record: ExecutionRecord) => Effect.Effect<unknown, unknown>) => Effect.Effect<void>
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

type AdmissionInput = {
  sessionID: string
  directory: string
  parentSessionID?: string
  parentMessageID?: string
  parentCallID?: string
}

type FencedTransitionInput = {
  sessionID: string
  operation: string
  fence: number
  expectedState: ExecutionState
  nextState: ExecutionState
  retryAt?: number
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

  const update = Effect.fnUntraced(function* (input: FencedTransitionInput) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const updated = decodeRow(
      yield* database.db.get<Row>(sql`
      UPDATE runtime_execution
       SET state = ${input.nextState}, retry_at = ${input.retryAt ?? null}, time_updated = ${Date.now()}
       WHERE session_id = ${input.sessionID}
         AND owner_lineage = ${identity.lineage}
         AND owner_instance = ${identity.instance}
         AND fence = ${input.fence}
         AND state = ${input.expectedState}
       RETURNING *
    `),
    )
    if (updated) return updated

    const current = yield* read(input.sessionID)
    yield* Effect.logWarning("restart diagnostic fenced transition failed", {
      sessionID: input.sessionID,
      operation: input.operation,
      expectedOwnerLineage: identity.lineage,
      expectedOwnerInstance: identity.instance,
      expectedFence: input.fence,
      expectedState: input.expectedState,
      requestedNextState: input.nextState,
      requestedRetryAt: input.retryAt,
      currentPersistedRow: current ? rowFields(current) : undefined,
      currentRuntimeInstance: identity.instance,
    })
    return yield* Effect.die(
      new RuntimeFencedTransitionError({
        message: `Fenced ${input.operation} transition failed for session ${input.sessionID}`,
        sessionID: input.sessionID,
        operation: input.operation,
      }),
    )
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
    const claimed = decodeRow(
      yield* database.db.get<Row>(sql`
      UPDATE runtime_execution
      SET owner_instance = ${identity.instance}, fence = ${nextFence},
          state = ${record.retry_at === null ? "active" : "retry_wait"}, retry_at = ${record.retry_at},
          time_updated = ${Date.now()}
      WHERE session_id = ${record.session_id}
        AND owner_lineage = ${identity.lineage}
        AND owner_instance = ${record.owner_instance}
        AND fence = ${record.fence}
        AND state = ${record.state}
        AND desired_active = 1
      RETURNING *
    `),
    )
    if (!claimed) {
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
    const result = toExecutionRecord(claimed)
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

  const rejectAdmission = (input: AdmissionInput, reason: string, row?: Row) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("restart diagnostic admission durable claim failed", {
        sessionID: input.sessionID,
        reason,
        observed: row ? rowFields(row) : undefined,
        currentRuntimeLineage: identity.lineage,
        currentRuntimeInstance: identity.instance,
      })
      return yield* new RuntimeDrainingError({ message: reason })
    })

  const admitDurably = Effect.fnUntraced(function* (input: AdmissionInput, row: Row | undefined) {
    const database = databaseRef.current ?? (yield* Database.Service)
    yield* Effect.logInfo("restart diagnostic admission durable claim beginning", {
      sessionID: input.sessionID,
      observed: row ? rowFields(row) : undefined,
      currentRuntimeLineage: identity.lineage,
      currentRuntimeInstance: identity.instance,
    })

    if (!row) {
      const inserted = decodeRow(
        yield* database.db.get<Row>(sql`
          INSERT INTO runtime_execution
            (id, session_id, directory, owner_lineage, owner_instance, fence, state, desired_active, retry_at,
             parent_session_id, parent_message_id, parent_call_id, time_created, time_updated)
          VALUES
            (${input.sessionID}, ${input.sessionID}, ${input.directory}, ${identity.lineage}, ${identity.instance},
             0, ${"active"}, 1, NULL, ${input.parentSessionID ?? null}, ${input.parentMessageID ?? null},
             ${input.parentCallID ?? null}, ${Date.now()}, ${Date.now()})
          ON CONFLICT (session_id) DO NOTHING
          RETURNING *
        `),
      )
      if (!inserted) {
        const current = yield* read(input.sessionID)
        yield* Effect.logWarning("restart diagnostic admission durable claim failed", {
          sessionID: input.sessionID,
          reason: current ? "insert compare-and-set conflict" : "insert returned no row",
          current: current ? rowFields(current) : undefined,
          currentRuntimeLineage: identity.lineage,
          currentRuntimeInstance: identity.instance,
        })
        if (current) return yield* rejectAdmission(input, "Session was admitted by another runtime", current)
        return yield* Effect.die(
          new RuntimeFencedTransitionError({
            message: `Durable admission failed for session ${input.sessionID}`,
            sessionID: input.sessionID,
            operation: "admit",
          }),
        )
      }
      yield* Effect.logInfo("restart diagnostic admission durable claim succeeded", {
        ...rowFields(inserted),
        takeover: false,
        currentRuntimeInstance: identity.instance,
      })
      return inserted
    }

    if (
      row.state === "active" &&
      (row.owner_lineage !== identity.lineage || row.owner_instance !== identity.instance)
    ) {
      return yield* rejectAdmission(input, "Session is owned by another runtime", row)
    }
    if (row.state === "parked") return yield* rejectAdmission(input, "Session is parked for recovery", row)
    if (row.state === "retry_wait") return yield* rejectAdmission(input, "Session is waiting for retry", row)
    if (row.state === "recovery_needed" && row.owner_lineage !== identity.lineage) {
      return yield* rejectAdmission(input, "Session requires recovery by its owning server identity", row)
    }
    if (!(["active", "completed", "cancelled", "recovery_needed"] as ExecutionState[]).includes(row.state)) {
      return yield* rejectAdmission(input, `Session cannot be admitted from state ${row.state}`, row)
    }

    const takeover = row.state !== "active"
    const nextFence = takeover ? row.fence + 1 : row.fence
    const claimed = decodeRow(
      yield* database.db.get<Row>(sql`
        UPDATE runtime_execution
        SET directory = ${input.directory}, owner_lineage = ${identity.lineage}, owner_instance = ${identity.instance},
            fence = ${nextFence}, state = ${"active"}, desired_active = 1, retry_at = NULL,
            parent_session_id = ${input.parentSessionID ?? row.parent_session_id},
            parent_message_id = ${input.parentMessageID ?? row.parent_message_id},
            parent_call_id = ${input.parentCallID ?? row.parent_call_id}, time_updated = ${Date.now()}
        WHERE session_id = ${row.session_id}
          AND owner_lineage = ${row.owner_lineage}
          AND owner_instance = ${row.owner_instance}
          AND fence = ${row.fence}
          AND state = ${row.state}
          AND desired_active = ${row.desired_active}
        RETURNING *
      `),
    )
    if (!claimed) {
      const current = yield* read(input.sessionID)
      yield* Effect.logWarning("restart diagnostic admission durable claim failed", {
        sessionID: input.sessionID,
        reason: "compare-and-set conflict",
        observed: rowFields(row),
        current: current ? rowFields(current) : undefined,
        currentRuntimeLineage: identity.lineage,
        currentRuntimeInstance: identity.instance,
      })
      return yield* Effect.die(
        new RuntimeFencedTransitionError({
          message: `Durable admission compare-and-set failed for session ${input.sessionID}`,
          sessionID: input.sessionID,
          operation: "admit",
        }),
      )
    }
    yield* Effect.logInfo("restart diagnostic admission durable claim succeeded", {
      ...rowFields(claimed),
      takeover,
      previousOwnerInstance: row.owner_instance,
      currentRuntimeInstance: identity.instance,
    })
    return claimed
  })

  const admit = Effect.fn("RuntimeLifecycle.admit")(function* (input: AdmissionInput) {
    yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        if (state.phase !== "running") {
          return yield* new RuntimeDrainingError({ message: "Runtime is draining" })
        }

        const row = yield* read(input.sessionID)
        const local = state.active.get(input.sessionID)
        if (local) {
          if (
            local.mode !== "active" ||
            !row ||
            row.state !== "active" ||
            row.owner_lineage !== identity.lineage ||
            row.owner_instance !== identity.instance ||
            row.fence !== local.fence
          ) {
            return yield* rejectAdmission(input, "Session is no longer owned by this runtime", row)
          }
          const claimed = yield* admitDurably(input, row)
          const active = new Map(state.active)
          active.set(input.sessionID, { fence: claimed.fence, leases: local.leases + 1, mode: "active" })
          return [undefined, { ...state, active }] as const
        }

        const claimed = yield* admitDurably(input, row)
        const active = new Map(state.active)
        active.set(input.sessionID, { fence: claimed.fence, leases: 1, mode: "active" })
        return [undefined, { ...state, active }] as const
      }),
    )
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
        yield* update({
          sessionID,
          operation: "release",
          fence: current.fence,
          expectedState: current.mode === "retry_wait" ? "retry_wait" : "active",
          nextState,
          retryAt: nextState === "parked" && current.mode === "retry_wait" ? current.retryAt : undefined,
        })
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
        yield* update({
          sessionID,
          operation: "park",
          fence: current.fence,
          expectedState: current.mode === "retry_wait" ? "retry_wait" : "active",
          nextState: "parked",
          retryAt: current.mode === "retry_wait" ? current.retryAt : undefined,
        })
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
    const current = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (!current) return [undefined, state] as const
        if (current.leases > 0) return [null, state] as const
        yield* update({
          sessionID,
          operation: "complete",
          fence: current.fence,
          expectedState: current.mode === "retry_wait" ? "retry_wait" : "active",
          nextState: "completed",
        })
        const active = new Map(state.active)
        active.delete(sessionID)
        return [current.fence, { ...state, active }] as const
      }),
    )
    if (current === null) {
      yield* Effect.logInfo("restart diagnostic recovery completion retained admitted execution", {
        sessionID,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      return
    }
    if (current === undefined) {
      yield* Effect.logWarning("restart diagnostic complete no-op; execution absent", {
        sessionID,
        lineage: identity.lineage,
        instance: identity.instance,
      })
      return
    }
    yield* Effect.logInfo("restart diagnostic execution marked completed", {
      sessionID,
      fence: current,
      lineage: identity.lineage,
      instance: identity.instance,
    })
    yield* checkQuiescent()
  })

  const beforeTurn = Effect.fn("RuntimeLifecycle.beforeTurn")(function* (sessionID: string) {
    const allowed = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (state.phase !== "running" || current?.mode !== "active") return [false, state] as const
        const row = yield* read(sessionID)
        if (
          row?.state !== "active" ||
          row.desired_active !== 1 ||
          row.owner_lineage !== identity.lineage ||
          row.owner_instance !== identity.instance ||
          row.fence !== current.fence
        ) {
          yield* Effect.logWarning("restart diagnostic beforeTurn rejected; durable ownership lost", {
            sessionID,
            expectedOwnerLineage: identity.lineage,
            expectedOwnerInstance: identity.instance,
            expectedFence: current.fence,
            currentPersistedRow: row ? rowFields(row) : undefined,
            currentRuntimeInstance: identity.instance,
          })
          return [false, state] as const
        }
        return [true, state] as const
      }),
    )
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    const phase = SynchronizedRef.getUnsafe(ref).phase
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
        yield* update({
          sessionID,
          operation: "retry",
          fence: current.fence,
          expectedState: current.mode === "retry_wait" ? "retry_wait" : "active",
          nextState: "retry_wait",
          retryAt,
        })
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
        yield* update({
          sessionID,
          operation: "resumeRetry",
          fence: current.fence,
          expectedState: "retry_wait",
          nextState: "active",
        })
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

  const quarantineStaleActive = Effect.fnUntraced(function* (row: Row, logDetails: boolean) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const quarantined = decodeRow(
      yield* database.db.get<Row>(sql`
        UPDATE runtime_execution
        SET state = ${"recovery_needed"}, fence = ${row.fence + 1}, retry_at = NULL, time_updated = ${Date.now()}
        WHERE session_id = ${row.session_id}
          AND owner_lineage = ${row.owner_lineage}
          AND owner_instance = ${row.owner_instance}
          AND fence = ${row.fence}
          AND state = ${"active"}
          AND desired_active = 1
        RETURNING *
      `),
    )
    if (quarantined) {
      if (logDetails)
        yield* Effect.logInfo("restart diagnostic stale active quarantined", {
          ...rowFields(row),
          newState: quarantined.state,
          newFence: quarantined.fence,
          currentRuntimeInstance: identity.instance,
        })
      return "quarantined" as const
    }

    const current = decodeRow(
      yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${row.session_id}`),
    )
    if (logDetails)
      yield* Effect.logWarning("restart diagnostic stale active quarantine conflict", {
        ...rowFields(row),
        current: current ? rowFields(current) : undefined,
        currentRuntimeInstance: identity.instance,
      })
    return "conflict" as const
  })

  const claimForRecovery = Effect.fnUntraced(function* (row: Row) {
    return yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        if (state.phase !== "running") return [undefined, state] as const
        const record = yield* claim(row)
        if (!record) return [undefined, state] as const
        const active = new Map(state.active)
        active.set(record.sessionID, {
          fence: record.fence,
          leases: 0,
          mode: record.state === "retry_wait" ? "retry_wait" : "active",
          retryAt: record.retryAt,
        })
        return [record, { ...state, active }] as const
      }),
    )
  })

  const markRecoveryNeeded = Effect.fnUntraced(function* (sessionID: string) {
    const transitioned = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const current = state.active.get(sessionID)
        if (!current) return [undefined, state] as const
        yield* update({
          sessionID,
          operation: "recovery_needed",
          fence: current.fence,
          expectedState: current.mode === "retry_wait" ? "retry_wait" : "active",
          nextState: "recovery_needed",
        })
        const active = new Map(state.active)
        active.delete(sessionID)
        return [current.fence, { ...state, active }] as const
      }),
    )
    if (transitioned !== undefined) yield* checkQuiescent()
    return transitioned
  })

  const recover = Effect.fn("RuntimeLifecycle.recover")(function* (
    run: (record: ExecutionRecord) => Effect.Effect<unknown, unknown>,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const candidates = yield* database.db.all<Row>(sql`
      SELECT * FROM runtime_execution
      WHERE desired_active = 1 AND state NOT IN ('completed', 'cancelled')
      ORDER BY time_updated ASC
    `)
    const staleActive = candidates.filter(
      (row) =>
        row.state === "active" && row.owner_lineage === identity.lineage && row.owner_instance !== identity.instance,
    )
    const quarantines = yield* Effect.forEach(
      staleActive.map((row, index) => ({ row, logDetails: index < 20 })),
      ({ row, logDetails }) => quarantineStaleActive(row, logDetails),
      { concurrency: "unbounded" },
    )
    const rows = yield* database.db.all<Row>(sql`
      SELECT * FROM runtime_execution
      WHERE desired_active = 1
        AND owner_lineage = ${identity.lineage}
        AND state IN ('parked', 'retry_wait')
      ORDER BY time_updated ASC
    `)
    const eligibleSessionIDs = new Set(rows.map((row) => row.session_id))
    const quarantined = quarantines.filter((result) => result === "quarantined").length
    const conflicts = quarantines.length - quarantined
    yield* Effect.logInfo("restart diagnostic stale active reconciliation summary", {
      staleActiveFound: staleActive.length,
      staleActiveQuarantined: quarantined,
      staleActiveCasConflicts: conflicts,
      staleActiveDiagnosticsOmitted: Math.max(0, staleActive.length - 20),
      currentLineage: identity.lineage,
      currentInstance: identity.instance,
    })
    const diagnosticRows = candidates.slice(0, 50)
    yield* Effect.forEach(
      diagnosticRows,
      (row) =>
        Effect.logInfo("restart diagnostic recovery candidate", {
          ...rowFields(row),
          ownerLineageMatches: row.owner_lineage === identity.lineage,
          eligibleForRecovery: eligibleSessionIDs.has(row.session_id),
          currentLineage: identity.lineage,
          currentInstance: identity.instance,
        }),
      { concurrency: "unbounded", discard: true },
    )
    if (candidates.length > diagnosticRows.length)
      yield* Effect.logInfo("restart diagnostic recovery candidates omitted", {
        omitted: candidates.length - diagnosticRows.length,
        currentLineage: identity.lineage,
        currentInstance: identity.instance,
      })
    yield* Effect.logInfo("restart diagnostic recovery scan summary", {
      totalNonterminalDesiredActive: candidates.length,
      sameLineageCandidates: candidates.filter((row) => row.owner_lineage === identity.lineage).length,
      eligibleParkedOrRetryWait: rows.length,
      staleActiveFound: staleActive.length,
      staleActiveQuarantined: quarantined,
      staleActiveCasConflicts: conflicts,
      currentLineage: identity.lineage,
      currentInstance: identity.instance,
    })
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const record = yield* claimForRecovery(row)
          if (!record) return
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
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const fence = yield* markRecoveryNeeded(record.sessionID).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                  yield* Effect.logWarning("restart diagnostic recovery interrupted", {
                    sessionID: record.sessionID,
                    rowTransitioned: fence !== undefined,
                    fence,
                    lineage: identity.lineage,
                    instance: identity.instance,
                  })
                }),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const fence = yield* markRecoveryNeeded(record.sessionID).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("restart diagnostic recovery transition failed", {
                      sessionID: record.sessionID,
                      causeType: typeof cause,
                      lineage: identity.lineage,
                      instance: identity.instance,
                    }).pipe(Effect.as(undefined)),
                  ),
                )
                if (fence !== undefined) {
                  yield* Effect.logWarning("restart diagnostic recovery row transitioned to recovery_needed", {
                    ...recordFields(record),
                    fence,
                    lineage: identity.lineage,
                    instance: identity.instance,
                  })
                }
                const error = Cause.squash(cause)
                yield* Effect.logError("restart diagnostic recovery failed", {
                  sessionID: record.sessionID,
                  errorType: error instanceof Error ? error.name : typeof error,
                  rowTransitioned: fence !== undefined,
                  lineage: identity.lineage,
                  instance: identity.instance,
                })
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
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
