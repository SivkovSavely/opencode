import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { sql } from "drizzle-orm"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect"
import { randomUUID } from "node:crypto"
import { readFileSync, readlinkSync } from "node:fs"
import { hostname } from "node:os"

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
  parentMode?: "foreground" | "background"
  parentNotificationState?: "pending" | "delivering" | "delivered"
  recoveryAttempts: number
}

export type AdmissionResult = { manualRecovery: boolean }

export type Interface = {
  readonly identity: {
    readonly lineage: string
    readonly instance: string
    readonly restartSupported: boolean
  }
  readonly bindDatabase: (database: Database.Interface) => void
  readonly finishStartupRecovery: () => Effect.Effect<void>
  readonly recoveryPrepared: (sessionID: string) => Effect.Effect<void>
  readonly admit: (input: AdmissionInput) => Effect.Effect<AdmissionResult, RuntimeDrainingError>
  readonly cancel: (sessionID: string) => Effect.Effect<boolean>
  readonly waitCancel: (sessionID: string) => Effect.Effect<void>
  readonly finishCancel: (sessionID: string) => Effect.Effect<void>
  readonly verifyOwner: (sessionID: string) => Effect.Effect<"live" | "dead" | "unknown">
  readonly reconstructChild: (input: ReconstructedChildInput) => Effect.Effect<boolean>
  readonly setParentMode: (sessionID: string, mode: "foreground" | "background") => Effect.Effect<void>
  readonly claimParentNotification: (sessionID: string, parentCallID?: string) => Effect.Effect<boolean>
  readonly releaseParentNotificationClaim: (sessionID: string, parentCallID?: string) => Effect.Effect<void>
  readonly acknowledgeParentNotification: (sessionID: string, parentCallID?: string) => Effect.Effect<void>
  readonly scheduleNotification: (parentSessionID: string, effect: Effect.Effect<void>) => Effect.Effect<void>
  readonly progress: (sessionID: string) => Effect.Effect<void>
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
  parent_mode: "foreground" | "background" | null
  parent_notification_state: "pending" | "delivering" | "delivered" | null
  owner_host: string | null
  owner_machine_id: string | null
  owner_boot_id: string | null
  owner_pid_namespace: string | null
  owner_pid: number | null
  owner_start_time: string | null
  recovery_attempts: number
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
  startupPending: Map<string, Deferred.Deferred<boolean>>
  cancelling: Map<string, { deferred: Deferred.Deferred<boolean>; rootSessionID: string }>
  parentModeOverrides: Map<string, "foreground" | "background">
  notificationReady: Map<string, Deferred.Deferred<void>>
}

type AdmissionInput = {
  sessionID: string
  directory: string
  parentSessionID?: string
  parentMessageID?: string
  parentCallID?: string
  parentMode?: "foreground" | "background"
  rejectCancelled?: boolean
  rejectRecoveryNeeded?: boolean
  manualRecovery?: boolean
}

type AdmissionDecision =
  | { _tag: "wait"; deferred: Deferred.Deferred<boolean> }
  | { _tag: "admitted"; result: AdmissionResult }

type ReconstructedChildInput = {
  sessionID: string
  directory: string
  parentSessionID: string
  parentMessageID: string
  parentCallID: string
  parentMode: "foreground" | "background"
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
  startupRecovery?: boolean
}

type ProcessIdentity = {
  host: string
  machineID: string
  bootID: string
  pidNamespace: string
  pid: number
  startTime: string
}

function processIdentity(): ProcessIdentity | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8")
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)
    const startTime = fields[19]
    const machineID = readFileSync("/etc/machine-id", "utf8").trim()
    const bootID = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    const pidNamespace = readlinkSync(`/proc/${process.pid}/ns/pid`)
    if (!startTime || !machineID || !bootID || !pidNamespace) return undefined
    return { host: hostname(), machineID, bootID, pidNamespace, pid: process.pid, startTime }
  } catch {
    return undefined
  }
}

function ownerLiveness(row: Row, owner: ProcessIdentity | undefined): "live" | "dead" | "unknown" {
  if (
    !owner ||
    row.owner_host !== owner.host ||
    row.owner_machine_id !== owner.machineID ||
    row.owner_boot_id !== owner.bootID ||
    row.owner_pid_namespace !== owner.pidNamespace ||
    row.owner_pid === null ||
    row.owner_start_time === null
  )
    return "unknown"
  try {
    const stat = readFileSync(`/proc/${row.owner_pid}/stat`, "utf8")
    const rest = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)
    const state = rest[0]
    const startTime = rest[19]
    if (!state || !startTime) return "unknown"
    if (state === "Z" || state === "X") return "dead"
    return startTime === row.owner_start_time ? "live" : "dead"
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try {
        process.kill(row.owner_pid, 0)
        return "unknown"
      } catch (probeError) {
        if (probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH") return "dead"
      }
    }
    return "unknown"
  }
}

let active: Interface | undefined

export function setCurrent(runtime: Interface) {
  active = runtime
}

export function current() {
  return active
}

export function make(input: MakeInput, scope: Scope.Scope, database?: Database.Interface): Interface {
  const owner = processIdentity()
  const identity = {
    lineage: input.lineage,
    instance: input.instance ?? randomUUID(),
    restartSupported: input.restartSupported ?? false,
  }
  const startupReady = input.startupRecovery ? Deferred.makeUnsafe<void>() : undefined
  const ref = SynchronizedRef.makeUnsafe<LocalState>({
    phase: "running",
    drainStarted: false,
    active: new Map(),
    startupPending: new Map(),
    cancelling: new Map(),
    parentModeOverrides: new Map(),
    notificationReady: new Map(),
  })
  const drained = Deferred.makeUnsafe<void>()
  const draining = Deferred.makeUnsafe<void>()
  const stopped = Deferred.makeUnsafe<{ action: Action }>()
  const recoveryPermits = Semaphore.makeUnsafe(2)
  const notificationClaims = new Set<string>()
  const databaseRef: { current?: Database.Interface } = { current: database }

  const read = Effect.fnUntraced(function* (sessionID: string) {
    const database = databaseRef.current ?? (yield* Database.Service)
    return decodeRow(yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${sessionID}`))
  })

  const waitForParentIdle = Effect.fnUntraced(function* (sessionID: string) {
    while (true) {
      const deferred = yield* SynchronizedRef.modify(ref, (state) => {
        const current = state.notificationReady.get(sessionID)
        if (current) return [current, state] as const
        const notificationReady = new Map(state.notificationReady)
        const created = Deferred.makeUnsafe<void>()
        notificationReady.set(sessionID, created)
        return [created, { ...state, notificationReady }] as const
      })
      const parent = yield* read(sessionID)
      if (parent?.state === "cancelled") {
        yield* notifyParentIdle(sessionID)
        return false
      }
      if (!parent || parent.state === "completed") {
        yield* notifyParentIdle(sessionID)
        return true
      }
      if (
        parent.state === "active" &&
        parent.owner_instance !== identity.instance &&
        ownerLiveness(parent, owner) !== "dead"
      ) {
        yield* notifyParentIdle(sessionID)
        return false
      }
      yield* Deferred.await(deferred)
    }
  })

  const notifyParentIdle = Effect.fnUntraced(function* (sessionID: string) {
    const deferred = yield* SynchronizedRef.modify(ref, (state) => {
      const deferred = state.notificationReady.get(sessionID)
      if (!deferred) return [undefined, state] as const
      const notificationReady = new Map(state.notificationReady)
      notificationReady.delete(sessionID)
      return [deferred, { ...state, notificationReady }] as const
    })
    if (deferred) yield* Deferred.succeed(deferred, undefined).pipe(Effect.ignore)
  })

  const settleStartupPending = Effect.fnUntraced(function* (sessionID: string, prepared: boolean) {
    const pending = yield* SynchronizedRef.modify(ref, (state) => {
      const deferred = state.startupPending.get(sessionID)
      if (!deferred) return [undefined, state] as const
      const startupPending = new Map(state.startupPending)
      startupPending.delete(sessionID)
      return [deferred, { ...state, startupPending }] as const
    })
    if (pending) yield* Deferred.succeed(pending, prepared).pipe(Effect.ignore)
  })

  const update = Effect.fnUntraced(function* (input: FencedTransitionInput) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const updated = decodeRow(
      yield* database.db.get<Row>(sql`
      UPDATE runtime_execution
       SET state = ${input.nextState}, retry_at = ${input.retryAt ?? null},
           parent_notification_state = CASE
             WHEN ${input.nextState} = 'completed' AND parent_mode = 'background'
               THEN COALESCE(parent_notification_state, 'pending')
             ELSE parent_notification_state
           END,
           time_updated = ${Date.now()}
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
      SET owner_instance = ${identity.instance}, owner_host = ${owner?.host ?? null},
          owner_machine_id = ${owner?.machineID ?? null}, owner_boot_id = ${owner?.bootID ?? null},
          owner_pid_namespace = ${owner?.pidNamespace ?? null}, owner_pid = ${owner?.pid ?? null},
          owner_start_time = ${owner?.startTime ?? null}, fence = ${nextFence},
           state = ${record.state === "active" || record.state === "waiting_child" || record.retry_at === null ? "active" : "retry_wait"},
           retry_at = ${record.state === "active" ? null : record.retry_at},
           recovery_attempts = ${record.recovery_attempts + (["active", "waiting_child"].includes(record.state) ? 1 : 0)},
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
      recoveryAttempts: result.recoveryAttempts,
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
      processIdentityAvailable: owner !== undefined,
    })

    if (!row) {
      const inserted = decodeRow(
        yield* database.db.get<Row>(sql`
          INSERT INTO runtime_execution
            (id, session_id, directory, owner_lineage, owner_instance, owner_host, owner_machine_id, owner_boot_id,
             owner_pid_namespace, owner_pid, owner_start_time, fence, state, desired_active, retry_at,
             parent_session_id, parent_message_id, parent_call_id, parent_mode, recovery_attempts,
             time_created, time_updated)
            SELECT
              ${input.sessionID}, ${input.sessionID}, ${input.directory}, ${identity.lineage}, ${identity.instance},
              ${owner?.host ?? null}, ${owner?.machineID ?? null}, ${owner?.bootID ?? null},
              ${owner?.pidNamespace ?? null}, ${owner?.pid ?? null}, ${owner?.startTime ?? null},
             0, ${"active"}, 1, NULL, ${input.parentSessionID ?? null}, ${input.parentMessageID ?? null},
              ${input.parentCallID ?? null}, ${input.parentMode ?? null}, 0, ${Date.now()}, ${Date.now()}
            WHERE ${input.parentCallID === undefined ? 1 : 0} = 1
              OR NOT EXISTS (
                SELECT 1 FROM runtime_execution
                WHERE session_id = ${input.parentSessionID ?? null} AND state = ${"cancelled"}
              )
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
      return { row: inserted, manualRecovery: false }
    }

    const unverifiedTakeover =
      row.state === "active" &&
      row.owner_instance !== identity.instance &&
      input.manualRecovery === true &&
      ownerLiveness(row, owner) !== "live"
    const manualRecovery = unverifiedTakeover || (input.manualRecovery === true && row.state === "recovery_needed")
    if (
      row.state === "active" &&
      (row.owner_lineage !== identity.lineage || row.owner_instance !== identity.instance)
    ) {
      if (row.owner_lineage !== identity.lineage || !unverifiedTakeover)
        return yield* rejectAdmission(input, "Session is owned by another runtime", row)
    }
    if (input.rejectCancelled && row.state === "cancelled")
      return yield* rejectAdmission(input, "Session was cancelled before background notification delivery", row)
    if (input.rejectRecoveryNeeded && row.state === "recovery_needed")
      return yield* rejectAdmission(
        input,
        "Session requires manual continuation before background notification delivery",
        row,
      )
    if (row.state === "parked") return yield* rejectAdmission(input, "Session is parked for recovery", row)
    if (row.state === "retry_wait") return yield* rejectAdmission(input, "Session is waiting for retry", row)
    if (row.state === "recovery_needed" && row.owner_lineage !== identity.lineage) {
      return yield* rejectAdmission(input, "Session requires recovery by its owning server identity", row)
    }
    if (!(["active", "completed", "cancelled", "recovery_needed"] as ExecutionState[]).includes(row.state)) {
      return yield* rejectAdmission(input, `Session cannot be admitted from state ${row.state}`, row)
    }

    const takeover = row.state !== "active" || unverifiedTakeover
    const nextFence = takeover ? row.fence + 1 : row.fence
    const parentSessionID =
      row.state === "active" ? row.parent_session_id : (input.parentSessionID ?? row.parent_session_id)
    const parentMessageID =
      row.state === "active" ? row.parent_message_id : (input.parentMessageID ?? row.parent_message_id)
    const parentCallID = row.state === "active" ? row.parent_call_id : (input.parentCallID ?? row.parent_call_id)
    const parentMode =
      row.state === "active" && row.parent_mode === "background" ? "background" : (input.parentMode ?? row.parent_mode)
    const claimed = decodeRow(
      yield* database.db.get<Row>(sql`
        UPDATE runtime_execution
        SET directory = ${input.directory}, owner_lineage = ${identity.lineage}, owner_instance = ${identity.instance},
            owner_host = ${owner?.host ?? null}, owner_machine_id = ${owner?.machineID ?? null},
            owner_boot_id = ${owner?.bootID ?? null}, owner_pid_namespace = ${owner?.pidNamespace ?? null},
            owner_pid = ${owner?.pid ?? null}, owner_start_time = ${owner?.startTime ?? null},
            fence = ${nextFence}, state = ${"active"}, desired_active = 1, retry_at = NULL,
            recovery_attempts = ${takeover && !manualRecovery ? 0 : row.recovery_attempts},
            parent_session_id = ${parentSessionID},
            parent_message_id = ${parentMessageID},
            parent_call_id = ${parentCallID},
            parent_mode = ${parentMode},
            parent_notification_state = CASE
              WHEN ${parentCallID} IS NOT ${row.parent_call_id} THEN NULL
              ELSE parent_notification_state
            END,
            time_updated = ${Date.now()}
        WHERE session_id = ${row.session_id}
          AND owner_lineage = ${row.owner_lineage}
          AND owner_instance = ${row.owner_instance}
          AND fence = ${row.fence}
          AND state = ${row.state}
          AND desired_active = ${row.desired_active}
           AND (${input.rejectCancelled ? 0 : 1} = 1 OR state <> ${"cancelled"})
           AND (${input.rejectRecoveryNeeded ? 0 : 1} = 1 OR state <> ${"recovery_needed"})
           AND (
             ${input.parentCallID === undefined ? 1 : 0} = 1
             OR NOT EXISTS (
               SELECT 1 FROM runtime_execution parent
               WHERE parent.session_id = ${input.parentSessionID ?? null} AND parent.state = ${"cancelled"}
             )
           )
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
    if (manualRecovery)
      yield* Effect.logWarning("session explicitly continued despite unverifiable prior owner", {
        sessionID: input.sessionID,
        previousOwnerInstance: row.owner_instance,
        previousOwnerPID: row.owner_pid,
        newFence: claimed.fence,
        note: "Uncertain tools are reconciled before the new model turn; verify state because the prior process may still be running.",
      })
    yield* Effect.logInfo("restart diagnostic admission durable claim succeeded", {
      ...rowFields(claimed),
      takeover,
      previousOwnerInstance: row.owner_instance,
      currentRuntimeInstance: identity.instance,
      manualRecovery,
    })
    return { row: claimed, manualRecovery }
  })

  const finishStartupRecovery = Effect.fn("RuntimeLifecycle.finishStartupRecovery")(function* () {
    if (startupReady) yield* Deferred.succeed(startupReady, undefined).pipe(Effect.ignore)
  })

  const recoveryPrepared = Effect.fn("RuntimeLifecycle.recoveryPrepared")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    const row = yield* read(sessionID)
    yield* settleStartupPending(
      sessionID,
      !!current &&
        row?.state === "active" &&
        row.owner_lineage === identity.lineage &&
        row.owner_instance === identity.instance &&
        row.fence === current.fence,
    )
  })

  const admit = Effect.fn("RuntimeLifecycle.admit")(function* (input: AdmissionInput) {
    if (startupReady) yield* Deferred.await(startupReady)
    while (true) {
      const wait = yield* SynchronizedRef.modifyEffect(
        ref,
        Effect.fnUntraced(function* (state) {
          const cancelling = state.cancelling.get(input.sessionID)
          if (cancelling)
            return [{ _tag: "wait" as const, deferred: cancelling.deferred } as AdmissionDecision, state] as const
          const recovering = state.startupPending.get(input.sessionID)
          if (recovering) return [{ _tag: "wait" as const, deferred: recovering } as AdmissionDecision, state] as const
          if (state.phase !== "running") {
            return yield* new RuntimeDrainingError({ message: "Runtime is draining" })
          }

          const parentMode = state.parentModeOverrides.get(input.sessionID)
          const admissionInput = parentMode ? { ...input, parentMode } : input
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
              return yield* rejectAdmission(admissionInput, "Session is no longer owned by this runtime", row)
            }
            const claimed = yield* admitDurably(admissionInput, row)
            const active = new Map(state.active)
            active.set(input.sessionID, { fence: claimed.row.fence, leases: local.leases + 1, mode: "active" })
            const parentModeOverrides = new Map(state.parentModeOverrides)
            parentModeOverrides.delete(input.sessionID)
            return [
              { _tag: "admitted" as const, result: { manualRecovery: claimed.manualRecovery } } as AdmissionDecision,
              { ...state, active, parentModeOverrides },
            ] as const
          }

          const claimed = yield* admitDurably(admissionInput, row)
          const active = new Map(state.active)
          active.set(input.sessionID, { fence: claimed.row.fence, leases: 1, mode: "active" })
          const parentModeOverrides = new Map(state.parentModeOverrides)
          parentModeOverrides.delete(input.sessionID)
          return [
            { _tag: "admitted" as const, result: { manualRecovery: claimed.manualRecovery } } as AdmissionDecision,
            { ...state, active, parentModeOverrides },
          ] as const
        }),
      )
      if (wait._tag === "admitted") return wait.result
      if (!(yield* Deferred.await(wait.deferred)))
        return yield* rejectAdmission(
          input,
          "Automatic session recovery could not safely prepare the existing execution",
        )
    }
  })

  const cancel = Effect.fn("RuntimeLifecycle.cancel")(function* (sessionID: string) {
    const decision = yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        if (state.cancelling.has(sessionID))
          return [{ owner: false as boolean, cancelled: [] as string[] }, state] as const
        const cancelling = new Map(state.cancelling)
        cancelling.set(sessionID, { deferred: Deferred.makeUnsafe<boolean>(), rootSessionID: sessionID })
        const row = yield* read(sessionID)
        if (!row || row.owner_lineage !== identity.lineage)
          return [
            { owner: true as boolean, cancelled: [] as string[] },
            { ...state, cancelling },
          ] as const
        if (
          !["active", "retry_wait", "parked", "waiting_child", "completed", "cancelled", "recovery_needed"].includes(
            row.state,
          )
        )
          return [
            { owner: true as boolean, cancelled: [] as string[] },
            { ...state, cancelling },
          ] as const

        const database = databaseRef.current ?? (yield* Database.Service)
        const updated = yield* database.db.all<{ session_id: string }>(sql`
          WITH RECURSIVE descendants(session_id) AS (
            SELECT ${sessionID}
            UNION
            SELECT child.session_id
            FROM runtime_execution child
            JOIN descendants parent ON child.parent_session_id = parent.session_id
          )
          UPDATE runtime_execution
          SET state = ${"cancelled"}, desired_active = 0, fence = fence + 1, retry_at = NULL,
              time_updated = ${Date.now()}
          WHERE session_id IN (SELECT session_id FROM descendants)
            AND owner_lineage = ${identity.lineage}
            AND (
              state IN ('active', 'retry_wait', 'parked', 'waiting_child')
              OR (session_id = ${sessionID} AND state = ${"completed"})
              OR (session_id = ${sessionID} AND state = ${"recovery_needed"})
            )
            AND desired_active = 1
            AND (
              session_id <> ${sessionID}
              OR (owner_instance = ${row.owner_instance} AND fence = ${row.fence}
                  AND state = ${row.state} AND desired_active = ${row.desired_active})
            )
          RETURNING session_id
        `)
        const active = new Map(state.active)
        const startupPending = new Map(state.startupPending)
        const parentModeOverrides = new Map(state.parentModeOverrides)
        for (const item of updated) {
          active.delete(item.session_id)
          parentModeOverrides.delete(item.session_id)
          if (!cancelling.has(item.session_id))
            cancelling.set(item.session_id, { deferred: Deferred.makeUnsafe<boolean>(), rootSessionID: sessionID })
          const recovering = startupPending.get(item.session_id)
          if (recovering) yield* Deferred.succeed(recovering, false).pipe(Effect.ignore)
          startupPending.delete(item.session_id)
        }
        if (updated.length > 0)
          yield* Effect.logInfo("runtime execution cancelled by user", {
            sessionID,
            previousState: row.state,
            cancelledExecutions: updated.length,
            lineage: identity.lineage,
            instance: identity.instance,
          })
        return [
          { owner: true as boolean, cancelled: updated.map((item) => item.session_id) },
          { ...state, active, cancelling, startupPending, parentModeOverrides },
        ] as const
      }),
    )
    if (!decision.owner) return false
    yield* Effect.forEach([sessionID, ...decision.cancelled], notifyParentIdle, {
      concurrency: "unbounded",
      discard: true,
    })
    if (decision.cancelled.length > 0) yield* checkQuiescent()
    return true
  })

  const waitCancel = Effect.fn("RuntimeLifecycle.waitCancel")(function* (sessionID: string) {
    const marker = SynchronizedRef.getUnsafe(ref).cancelling.get(sessionID)
    if (marker) yield* Deferred.await(marker.deferred)
  })

  const finishCancel = Effect.fn("RuntimeLifecycle.finishCancel")(function* (sessionID: string) {
    const deferreds = yield* SynchronizedRef.modify(ref, (state) => {
      const cancelling = new Map(state.cancelling)
      const deferreds = [] as Deferred.Deferred<boolean>[]
      for (const [id, marker] of cancelling) {
        if (id !== sessionID && marker.rootSessionID !== sessionID) continue
        cancelling.delete(id)
        deferreds.push(marker.deferred)
      }
      return [deferreds, { ...state, cancelling }] as const
    })
    yield* Effect.forEach(deferreds, (deferred) => Deferred.succeed(deferred, true), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  const verifyOwner = Effect.fn("RuntimeLifecycle.verifyOwner")(function* (sessionID: string) {
    const row = yield* read(sessionID)
    if (!row || row.owner_lineage !== identity.lineage) return "unknown" as const
    return ownerLiveness(row, owner)
  })

  const reconstructChild = Effect.fn("RuntimeLifecycle.reconstructChild")(function* (input: ReconstructedChildInput) {
    const parent = yield* read(input.parentSessionID)
    if (
      !parent ||
      parent.owner_lineage !== identity.lineage ||
      !["active", "waiting_child", "completed"].includes(parent.state) ||
      parent.desired_active !== 1 ||
      ownerLiveness(parent, owner) !== "dead"
    )
      return false

    const database = databaseRef.current ?? (yield* Database.Service)
    const now = Date.now()
    const inserted = decodeRow(
      yield* database.db.get<Row>(sql`
        INSERT INTO runtime_execution
          (id, session_id, directory, owner_lineage, owner_instance, owner_host, owner_machine_id, owner_boot_id,
           owner_pid_namespace, owner_pid, owner_start_time, fence, state, desired_active, retry_at,
           parent_session_id, parent_message_id, parent_call_id, parent_mode, recovery_attempts,
           time_created, time_updated)
        SELECT
          ${input.sessionID}, ${input.sessionID}, ${input.directory}, parent.owner_lineage, parent.owner_instance,
          parent.owner_host, parent.owner_machine_id, parent.owner_boot_id, parent.owner_pid_namespace,
          parent.owner_pid, parent.owner_start_time, 0, ${"active"}, 1, NULL, parent.session_id,
          ${input.parentMessageID}, ${input.parentCallID}, ${input.parentMode}, 0, ${now}, ${now}
        FROM runtime_execution parent
        WHERE parent.session_id = ${input.parentSessionID}
          AND parent.directory = ${input.directory}
          AND parent.owner_lineage = ${parent.owner_lineage}
          AND parent.owner_instance = ${parent.owner_instance}
          AND parent.fence = ${parent.fence}
          AND parent.state = ${parent.state}
          AND parent.desired_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM runtime_execution child WHERE child.session_id = ${input.sessionID}
          )
        RETURNING *
      `),
    )
    if (inserted) {
      yield* Effect.logWarning("runtime recovery reconstructed a missing Task child execution", {
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        parentMessageID: input.parentMessageID,
        parentCallID: input.parentCallID,
        parentMode: input.parentMode,
        ownerInstance: inserted.owner_instance,
      })
      return true
    }
    return false
  })

  const progress = Effect.fn("RuntimeLifecycle.progress")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    if (!current) return
    const database = databaseRef.current ?? (yield* Database.Service)
    yield* database.db.get(sql`
      UPDATE runtime_execution
      SET recovery_attempts = 0, time_updated = ${Date.now()}
      WHERE session_id = ${sessionID}
        AND owner_lineage = ${identity.lineage}
        AND owner_instance = ${identity.instance}
        AND fence = ${current.fence}
        AND state = ${"active"}
      RETURNING session_id
    `)
  })

  const setParentMode = Effect.fn("RuntimeLifecycle.setParentMode")(function* (
    sessionID: string,
    mode: "foreground" | "background",
  ) {
    yield* SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (state) {
        const row = yield* read(sessionID)
        if (
          !row ||
          row.owner_lineage !== identity.lineage ||
          !["active", "completed", "parked", "retry_wait", "waiting_child"].includes(row.state) ||
          (row.owner_instance !== identity.instance && ownerLiveness(row, owner) !== "dead")
        ) {
          const parentModeOverrides = new Map(state.parentModeOverrides)
          parentModeOverrides.set(sessionID, mode)
          return [undefined, { ...state, parentModeOverrides }] as const
        }
        const database = databaseRef.current ?? (yield* Database.Service)
        const updated = yield* database.db.get(sql`
          UPDATE runtime_execution
          SET parent_mode = ${mode},
              parent_notification_state = CASE
                WHEN ${mode} = 'background' AND state = 'completed'
                  THEN COALESCE(parent_notification_state, 'pending')
                ELSE parent_notification_state
              END,
              time_updated = ${Date.now()}
          WHERE session_id = ${sessionID}
            AND owner_lineage = ${row.owner_lineage}
            AND owner_instance = ${row.owner_instance}
            AND fence = ${row.fence}
            AND state = ${row.state}
            AND desired_active = ${row.desired_active}
          RETURNING session_id
        `)
        if (!updated) {
          const parentModeOverrides = new Map(state.parentModeOverrides)
          parentModeOverrides.set(sessionID, mode)
          return [undefined, { ...state, parentModeOverrides }] as const
        }
        const parentModeOverrides = new Map(state.parentModeOverrides)
        parentModeOverrides.delete(sessionID)
        return [undefined, { ...state, parentModeOverrides }] as const
      }),
    )
  })

  const acknowledgeParentNotification = Effect.fn("RuntimeLifecycle.acknowledgeParentNotification")(function* (
    sessionID: string,
    parentCallID?: string,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    const row = yield* read(sessionID)
    if (!row || row.owner_instance !== identity.instance || (parentCallID && row.parent_call_id !== parentCallID))
      return
    const acknowledged = yield* database.db.get(sql`
      UPDATE runtime_execution
      SET parent_notification_state = ${"delivered"}, time_updated = ${Date.now()}
        WHERE session_id = ${sessionID}
          AND owner_lineage = ${identity.lineage}
          AND owner_instance = ${identity.instance}
          AND fence = ${row.fence}
          AND parent_mode = ${"background"}
          AND parent_call_id IS ${parentCallID ?? row.parent_call_id}
          AND parent_notification_state = ${"delivering"}
          AND (state = ${"completed"} OR (state = ${"active"} AND fence = ${current?.fence ?? -1}))
      RETURNING session_id
    `)
    if (acknowledged) notificationClaims.delete(`${sessionID}:${parentCallID ?? row.parent_call_id ?? ""}`)
  })

  const claimParentNotification = Effect.fn("RuntimeLifecycle.claimParentNotification")(function* (
    sessionID: string,
    parentCallID?: string,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    const row = yield* read(sessionID)
    if (
      !row ||
      row.parent_mode !== "background" ||
      row.parent_notification_state === "delivered" ||
      (parentCallID && row.parent_call_id !== parentCallID)
    )
      return false
    const claimID = `${sessionID}:${parentCallID ?? row.parent_call_id ?? ""}`
    if (notificationClaims.has(claimID)) return false
    notificationClaims.add(claimID)
    const completed = row.state === "completed"
    const recovering =
      row.state === "active" && current?.fence === row.fence && row.owner_instance === identity.instance
    const staleDelivery =
      row.parent_notification_state === "delivering" &&
      (row.owner_instance === identity.instance || ownerLiveness(row, owner) === "dead")
    const completedOwnerAvailable = row.owner_instance === identity.instance || ownerLiveness(row, owner) === "dead"
    if (!completed && !recovering) {
      notificationClaims.delete(claimID)
      return false
    }
    if (completed && !completedOwnerAvailable) {
      notificationClaims.delete(claimID)
      return false
    }
    if (row.parent_notification_state === "delivering" && !staleDelivery && !recovering) {
      notificationClaims.delete(claimID)
      return false
    }
    const claimed = decodeRow(
      yield* database.db.get<Row>(sql`
        UPDATE runtime_execution
        SET parent_notification_state = ${"delivering"},
            owner_instance = ${completed ? identity.instance : row.owner_instance},
            owner_host = ${completed ? (owner?.host ?? null) : row.owner_host},
            owner_machine_id = ${completed ? (owner?.machineID ?? null) : row.owner_machine_id},
            owner_boot_id = ${completed ? (owner?.bootID ?? null) : row.owner_boot_id},
            owner_pid_namespace = ${completed ? (owner?.pidNamespace ?? null) : row.owner_pid_namespace},
            owner_pid = ${completed ? (owner?.pid ?? null) : row.owner_pid},
            owner_start_time = ${completed ? (owner?.startTime ?? null) : row.owner_start_time},
            fence = ${completed ? row.fence + 1 : row.fence},
            time_updated = ${Date.now()}
        WHERE session_id = ${sessionID}
          AND owner_lineage = ${identity.lineage}
          AND owner_instance = ${row.owner_instance}
          AND fence = ${row.fence}
          AND state = ${row.state}
          AND parent_mode = ${"background"}
          AND parent_call_id IS ${parentCallID ?? row.parent_call_id}
          AND parent_notification_state IS ${row.parent_notification_state}
          AND NOT EXISTS (
            SELECT 1 FROM runtime_execution parent
            WHERE parent.session_id = runtime_execution.parent_session_id AND parent.state = ${"cancelled"}
          )
        RETURNING session_id
      `),
    )
    if (claimed) return true
    notificationClaims.delete(claimID)
    return false
  })

  const releaseParentNotificationClaim = Effect.fn("RuntimeLifecycle.releaseParentNotificationClaim")(function* (
    sessionID: string,
    parentCallID?: string,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const row = yield* read(sessionID)
    const callID = parentCallID ?? row?.parent_call_id ?? ""
    if (
      row?.owner_instance === identity.instance &&
      row.parent_mode === "background" &&
      row.parent_notification_state === "delivering"
    ) {
      yield* database.db.get(sql`
        UPDATE runtime_execution
        SET parent_notification_state = ${"pending"}, time_updated = ${Date.now()}
        WHERE session_id = ${sessionID}
          AND owner_lineage = ${identity.lineage}
          AND owner_instance = ${identity.instance}
          AND fence = ${row.fence}
          AND parent_mode = ${"background"}
          AND parent_call_id IS ${parentCallID ?? row.parent_call_id}
          AND parent_notification_state = ${"delivering"}
          AND (state = ${"completed"} OR state = ${"active"})
        RETURNING session_id
      `)
    }
    notificationClaims.delete(`${sessionID}:${callID}`)
  })

  const scheduleNotification = Effect.fn("RuntimeLifecycle.scheduleNotification")(function* (
    parentSessionID: string,
    effect: Effect.Effect<void>,
  ) {
    yield* Effect.gen(function* () {
      const pending = SynchronizedRef.getUnsafe(ref).startupPending.get(parentSessionID)
      if (pending) yield* Deferred.await(pending)
      if (!(yield* waitForParentIdle(parentSessionID))) return
      yield* recoveryPermits.withPermit(effect)
    }).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
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
    if (result.nextState === "completed") yield* notifyParentIdle(sessionID)
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
    yield* notifyParentIdle(sessionID)
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

  const quarantineExhaustedRecovery = Effect.fnUntraced(function* (row: Row) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const quarantined = decodeRow(
      yield* database.db.get<Row>(sql`
        UPDATE runtime_execution
        SET state = ${"recovery_needed"}, fence = ${row.fence + 1}, retry_at = NULL, time_updated = ${Date.now()}
        WHERE session_id = ${row.session_id}
          AND owner_lineage = ${row.owner_lineage}
          AND owner_instance = ${row.owner_instance}
          AND fence = ${row.fence}
          AND state = ${row.state}
          AND desired_active = 1
        RETURNING *
      `),
    )
    if (quarantined) {
      yield* Effect.logWarning("automatic recovery budget exhausted; execution quarantined", {
        sessionID: row.session_id,
        attempts: row.recovery_attempts,
        newFence: quarantined.fence,
        currentRuntimeInstance: identity.instance,
      })
      return "quarantined" as const
    }

    const current = decodeRow(
      yield* database.db.get(sql`SELECT * FROM runtime_execution WHERE session_id = ${row.session_id}`),
    )
    yield* Effect.logWarning("automatic recovery quarantine compare-and-set failed", {
      sessionID: row.session_id,
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
      WITH RECURSIVE cancelled(session_id) AS (
        SELECT session_id FROM runtime_execution WHERE state = ${"cancelled"}
        UNION
        SELECT child.session_id
        FROM runtime_execution child
        JOIN cancelled parent ON child.parent_session_id = parent.session_id
      )
      SELECT * FROM runtime_execution
      WHERE desired_active = 1 AND state NOT IN ('completed', 'cancelled')
        AND session_id NOT IN (SELECT session_id FROM cancelled)
      ORDER BY time_updated ASC
    `)
    const activeOwnedElsewhere = candidates.filter(
      (row) =>
        (row.state === "active" || row.state === "waiting_child") &&
        row.owner_lineage === identity.lineage &&
        row.owner_instance !== identity.instance,
    )
    const ownership = activeOwnedElsewhere.map((row) => ({ row, liveness: ownerLiveness(row, owner) }))
    const deadOwners = ownership.filter((item) => item.liveness === "dead").map((item) => item.row)
    const unknownOwners = ownership.filter((item) => item.liveness === "unknown")
    const exhausted = deadOwners.filter((row) => row.recovery_attempts >= 3)
    const quarantines = yield* Effect.forEach(exhausted, quarantineExhaustedRecovery, {
      concurrency: 2,
    })
    yield* Effect.forEach(
      ownership.slice(0, 20),
      ({ row, liveness }) =>
        liveness === "unknown"
          ? Effect.logWarning("runtime recovery rejected because owner death could not be established", {
              sessionID: row.session_id,
              ownerInstance: row.owner_instance,
              reason: "Process identity is unavailable, foreign, inaccessible, or ambiguous; use explicit recovery.",
            })
          : Effect.logInfo("runtime recovery owner liveness verified", {
              sessionID: row.session_id,
              ownerInstance: row.owner_instance,
              ownerPID: row.owner_pid,
              liveness,
              automaticTakeover: liveness === "dead" && row.recovery_attempts < 3,
            }),
      { concurrency: 2, discard: true },
    )
    if (ownership.length > 20)
      yield* Effect.logInfo("runtime recovery owner diagnostics omitted", { omitted: ownership.length - 20 })
    const rows = candidates.filter(
      (row) =>
        row.owner_lineage === identity.lineage &&
        (((row.state === "active" || row.state === "waiting_child") &&
          deadOwners.includes(row) &&
          row.recovery_attempts < 3) ||
          ((row.state === "parked" || row.state === "retry_wait") && row.owner_instance !== identity.instance)),
    )
    const eligibleSessionIDs = new Set(rows.map((row) => row.session_id))
    const quarantined = quarantines.filter((result) => result === "quarantined").length
    const conflicts = quarantines.length - quarantined
    yield* Effect.logInfo("runtime recovery ownership scan summary", {
      activeOtherOwner: activeOwnedElsewhere.length,
      deadOwner: deadOwners.length,
      unknownOwner: unknownOwners.length,
      exhaustedQuarantined: quarantined,
      quarantineConflicts: conflicts,
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
          ownerLiveness: ownership.find((item) => item.row.session_id === row.session_id)?.liveness,
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
      eligibleExecutions: rows.length,
      staleActiveFound: activeOwnedElsewhere.length,
      deadOwner: deadOwners.length,
      unknownOwner: unknownOwners.length,
      recoveryBudgetExhausted: exhausted.length,
      processIdentityAvailable: owner !== undefined,
      currentLineage: identity.lineage,
      currentInstance: identity.instance,
    })
    const relatedChildren = yield* database.db.all<Row>(sql`
      SELECT * FROM runtime_execution
      WHERE parent_session_id IS NOT NULL AND parent_mode = ${"foreground"}
    `)
    const unresolvedChildren = relatedChildren.filter((child) =>
      ["active", "parked", "retry_wait", "waiting_child", "recovery_needed"].includes(child.state),
    )
    const dependencies = new Map<string, string[]>()
    for (const child of unresolvedChildren) {
      if (!child.parent_session_id) continue
      dependencies.set(child.parent_session_id, [
        ...(dependencies.get(child.parent_session_id) ?? []),
        child.session_id,
      ])
    }
    const cycleIDs = recoveryDependencyCycles(dependencies)
    const results = new Map(rows.map((row) => [row.session_id, Deferred.makeUnsafe<boolean>()]))
    const startupClaims = startupReady
      ? yield* SynchronizedRef.modify(ref, (state) => {
          const pending = new Map(state.startupPending)
          const claims = new Map<string, Deferred.Deferred<boolean>>()
          for (const row of rows) {
            const deferred = pending.get(row.session_id) ?? Deferred.makeUnsafe<boolean>()
            pending.set(row.session_id, deferred)
            claims.set(row.session_id, deferred)
          }
          return [claims, { ...state, startupPending: pending }] as const
        })
      : new Map<string, Deferred.Deferred<boolean>>()

    const settleStartupClaim = Effect.fnUntraced(function* (sessionID: string, prepared: boolean) {
      const deferred = startupClaims.get(sessionID)
      if (!deferred) return
      const current = SynchronizedRef.getUnsafe(ref).startupPending.get(sessionID)
      if (current !== deferred) return
      yield* settleStartupPending(sessionID, prepared)
    })

    const quarantineDependency = Effect.fnUntraced(function* (row: Row, reason: string) {
      const quarantined = decodeRow(
        yield* database.db.get<Row>(sql`
          UPDATE runtime_execution
          SET state = ${"recovery_needed"}, fence = ${row.fence + 1}, retry_at = NULL, time_updated = ${Date.now()}
          WHERE session_id = ${row.session_id}
            AND owner_lineage = ${row.owner_lineage}
            AND owner_instance = ${row.owner_instance}
            AND fence = ${row.fence}
            AND state = ${row.state}
            AND desired_active = ${row.desired_active}
          RETURNING *
        `),
      )
      yield* Effect.logWarning("runtime recovery parent dependency quarantined", {
        sessionID: row.session_id,
        reason,
        transitioned: quarantined !== undefined,
        fence: quarantined?.fence,
      })
    })

    const runClaimed = Effect.fnUntraced(function* (record: ExecutionRecord, permitHeld: boolean) {
      return yield* Effect.gen(function* () {
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
        }
        if (record.state === "retry_wait") {
          const resumed = yield* resumeRetry(record.sessionID)
          if (!resumed) {
            yield* Effect.logWarning("restart diagnostic recovery exited without running", {
              ...recordFields(record),
              reason: SynchronizedRef.getUnsafe(ref).phase === "running" ? "resumeRetry_failed" : "runtime_drain",
              lineage: identity.lineage,
              instance: identity.instance,
            })
            return false
          }
        }
        const recoveryRecord = { ...record, state: "active" as const, retryAt: undefined }
        yield* Effect.logInfo("restart diagnostic recovery run started", {
          ...recordFields(recoveryRecord),
          recoveryRecord,
        })
        const work = run(recoveryRecord).pipe(
          Effect.tap(() =>
            Effect.logInfo("runtime recovery continuation returned successfully", {
              ...recordFields(recoveryRecord),
            }),
          ),
          Effect.tap(() => complete(record.sessionID)),
        )
        yield* permitHeld ? work : recoveryPermits.withPermit(work)
        if (record.parentMode === "background" && record.parentSessionID)
          yield* scheduleNotification(
            record.parentSessionID,
            run({ ...recoveryRecord, state: "completed", parentNotificationState: "pending" }).pipe(
              Effect.catchCause((cause) => {
                const error = Cause.squash(cause)
                return Effect.logWarning("background task recovery notification remains pending", {
                  sessionID: record.sessionID,
                  parentSessionID: record.parentSessionID,
                  errorType: error instanceof Error ? error.name : typeof error,
                })
              }),
            ),
          )
        return true
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
              Effect.catchCause((failure) =>
                Effect.logError("restart diagnostic recovery transition failed", {
                  sessionID: record.sessionID,
                  causeType: typeof failure,
                  lineage: identity.lineage,
                  instance: identity.instance,
                }).pipe(Effect.as(undefined)),
              ),
            )
            const error = Cause.squash(cause)
            yield* Effect.logError("restart diagnostic recovery failed", {
              sessionID: record.sessionID,
              errorType: error instanceof Error ? error.name : typeof error,
              rowTransitioned: fence !== undefined,
              lineage: identity.lineage,
              instance: identity.instance,
            })
            return false
          }),
        ),
      )
    })

    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const completion = results.get(row.session_id)!
          const process = Effect.gen(function* () {
            if (cycleIDs.has(row.session_id)) {
              yield* quarantineDependency(row, "foreground Task dependency cycle")
              return false
            }
            const linked = unresolvedChildren.filter((child) => child.parent_session_id === row.session_id)
            const unavailable = linked.filter((child) => !results.has(child.session_id))
            if (unavailable.length > 0) {
              const unrecoverable = unavailable.some((child) => child.state === "recovery_needed")
              const reason = unrecoverable
                ? "foreground child is already quarantined"
                : "foreground child owner cannot be safely claimed"
              if (unrecoverable) yield* quarantineDependency(row, reason)
              else
                yield* Effect.logWarning("runtime recovery parent deferred for unresolved child", {
                  sessionID: row.session_id,
                  children: unavailable.map((child) => child.session_id),
                  reason,
                })
              return false
            }
            const childResults = yield* Effect.forEach(linked, (child) =>
              Deferred.await(results.get(child.session_id)!),
            )
            if (childResults.some((success) => !success)) {
              const failedChildren = linked.filter((_, index) => childResults[index] === false)
              const latestChildren = yield* Effect.forEach(failedChildren, (child) => read(child.session_id))
              if (latestChildren.some((child) => child?.state === "recovery_needed"))
                yield* quarantineDependency(row, "foreground child recovery did not complete")
              else
                yield* Effect.logWarning("runtime recovery parent deferred after another child claim", {
                  sessionID: row.session_id,
                  children: failedChildren.map((child) => child.session_id),
                })
              return false
            }

            if (row.state === "active" || row.state === "waiting_child")
              return yield* recoveryPermits.withPermit(
                Effect.gen(function* () {
                  const record = yield* claimForRecovery(row)
                  if (!record) return false
                  return yield* runClaimed(record, true)
                }),
              )
            const record = yield* claimForRecovery(row)
            if (!record) return false
            return yield* runClaimed(record, false)
          })
          yield* process.pipe(
            Effect.tap((success) => Deferred.succeed(completion, success)),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("runtime recovery dependency scheduler failed", {
                  sessionID: row.session_id,
                  causeType: typeof cause,
                })
                yield* Deferred.succeed(completion, false)
              }),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Deferred.succeed(completion, false)
                yield* settleStartupClaim(row.session_id, false)
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }),
      { concurrency: "unbounded", discard: true },
    )

    const notificationCandidates = yield* database.db.all<Row>(sql`
      WITH RECURSIVE cancelled(session_id) AS (
        SELECT session_id FROM runtime_execution WHERE state = ${"cancelled"}
        UNION
        SELECT child.session_id
        FROM runtime_execution child
        JOIN cancelled parent ON child.parent_session_id = parent.session_id
      )
      SELECT * FROM runtime_execution
      WHERE desired_active = 1 AND state = ${"completed"}
        AND owner_lineage = ${identity.lineage}
        AND parent_mode = ${"background"}
        AND parent_notification_state IN ('pending', 'delivering')
        AND session_id NOT IN (SELECT session_id FROM cancelled)
    `)
    const notifications = notificationCandidates.filter(
      (row) => row.owner_instance === identity.instance || ownerLiveness(row, owner) === "dead",
    )
    if (notifications.length < notificationCandidates.length)
      yield* Effect.logWarning("background notifications deferred because owner liveness was not established", {
        count: notificationCandidates.length - notifications.length,
      })
    yield* Effect.forEach(
      notifications,
      (row) => {
        if (!row.parent_session_id) return Effect.void
        return scheduleNotification(
          row.parent_session_id,
          run(toExecutionRecord(row)).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              return Effect.logWarning("background task recovery notification remains pending", {
                sessionID: row.session_id,
                parentSessionID: row.parent_session_id,
                errorType: error instanceof Error ? error.name : typeof error,
              })
            }),
          ),
        )
      },
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
    finishStartupRecovery,
    recoveryPrepared,
    admit,
    cancel,
    waitCancel,
    finishCancel,
    verifyOwner,
    reconstructChild,
    setParentMode,
    claimParentNotification,
    releaseParentNotificationClaim,
    acknowledgeParentNotification,
    scheduleNotification,
    progress,
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
    finishStartupRecovery: () => Effect.void,
    recoveryPrepared: () => Effect.void,
    admit: () => Effect.succeed({ manualRecovery: false }),
    cancel: () => Effect.succeed(true),
    waitCancel: () => Effect.void,
    finishCancel: () => Effect.void,
    verifyOwner: () => Effect.succeed("unknown"),
    reconstructChild: () => Effect.succeed(false),
    setParentMode: () => Effect.void,
    claimParentNotification: () => Effect.succeed(false),
    releaseParentNotificationClaim: () => Effect.void,
    acknowledgeParentNotification: () => Effect.void,
    scheduleNotification: () => Effect.void,
    progress: () => Effect.void,
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
    ownerPID: row.owner_pid,
    fence: row.fence,
    parentSessionID: row.parent_session_id,
    parentMessageID: row.parent_message_id,
    parentCallID: row.parent_call_id,
    parentMode: row.parent_mode ?? undefined,
    parentNotificationState: row.parent_notification_state ?? undefined,
    recoveryAttempts: row.recovery_attempts,
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
    parentMode: record.parentMode,
    parentNotificationState: record.parentNotificationState,
    recoveryAttempts: record.recoveryAttempts,
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
    parentMode: row.parent_mode ?? undefined,
    parentNotificationState: row.parent_notification_state ?? undefined,
    recoveryAttempts: row.recovery_attempts,
  }
}

function recoveryDependencyCycles(dependencies: Map<string, string[]>) {
  const visiting: string[] = []
  const visited = new Set<string>()
  const cycles = new Set<string>()
  const visit = (sessionID: string) => {
    const cycleStart = visiting.indexOf(sessionID)
    if (cycleStart >= 0) {
      for (const item of visiting.slice(cycleStart)) cycles.add(item)
      return
    }
    if (visited.has(sessionID)) return
    visiting.push(sessionID)
    for (const child of dependencies.get(sessionID) ?? []) visit(child)
    visiting.pop()
    visited.add(sessionID)
  }
  for (const sessionID of dependencies.keys()) visit(sessionID)
  return cycles
}

const defaultLayer = Layer.succeed(Service)(unavailable())

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [Database.node] })

export * as RuntimeLifecycle from "./runtime-lifecycle"
