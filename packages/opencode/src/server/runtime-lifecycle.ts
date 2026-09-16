import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { sql } from "drizzle-orm"
import { Context, Deferred, Duration, Effect, Layer, Schema, Scope, SynchronizedRef } from "effect"
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
}

type LocalState = {
  phase: Phase
  action?: Action
  drainStarted: boolean
  active: Map<string, LocalExecution>
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
    const result = yield* database.db.run(sql`
      UPDATE runtime_execution
      SET owner_instance = ${identity.instance}, fence = ${nextFence}, state = ${"active"}, retry_at = NULL,
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
    if (!current) return undefined
    return {
      ...toExecutionRecord(record),
      ownerInstance: identity.instance,
      fence: nextFence,
      state: "active" as const,
    }
  })

  const checkQuiescent = Effect.fnUntraced(function* () {
    const shouldStop = SynchronizedRef.modify(ref, (state) => {
      if (state.phase !== "draining" || state.active.size > 0) return [false, state] as const
      return [true, { ...state, phase: "quiescent" }] as const
    })
    if (!shouldStop) return
    yield* Deferred.succeed(drained, undefined).pipe(Effect.ignore)
    yield* SynchronizedRef.update(ref, (state) => ({ ...state, phase: "stopping" as const }))
    yield* Deferred.succeed(stopped, { action: SynchronizedRef.getUnsafe(ref).action! }).pipe(Effect.ignore)
    yield* Effect.logInfo("runtime quiescent", { lineage: identity.lineage, instance: identity.instance })
  })

  const parkRetrying = Effect.fnUntraced(function* () {
    const ids = [...SynchronizedRef.getUnsafe(ref).active.entries()]
      .filter(([, execution]) => execution.mode === "retry_wait")
      .map(([sessionID]) => sessionID)
    yield* Effect.forEach(ids, park, { concurrency: "unbounded", discard: true })
  })

  const request = Effect.fn("RuntimeLifecycle.request")(function* (action: Action) {
    const result = yield* SynchronizedRef.modify(
      ref,
      (state): readonly [{ accepted: boolean; action?: Action }, LocalState] => {
        if (state.phase === "running") {
          return [
            { accepted: true, action },
            { ...state, phase: "draining", action, drainStarted: true },
          ] as const
        }
        if (state.action === action) return [{ accepted: true, action }, state] as const
        return [{ accepted: false, action: state.action }, state] as const
      },
    )
    if (result.accepted) {
      yield* Deferred.succeed(draining, undefined).pipe(Effect.ignore)
      yield* Effect.logInfo("runtime draining requested", {
        action,
        lineage: identity.lineage,
        instance: identity.instance,
      })
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
    const action = SynchronizedRef.modify(ref, (state) => {
      const current = state.active.get(sessionID)
      if (!current) return [Effect.void, state] as const
      if (current.leases > 1) {
        const active = new Map(state.active)
        active.set(sessionID, { ...current, leases: current.leases - 1 })
        return [Effect.void, { ...state, active }] as const
      }
      const active = new Map(state.active)
      active.delete(sessionID)
      const nextState = state.phase === "draining" ? "parked" : "completed"
      const operation = update(sessionID, current.fence, nextState).pipe(
        Effect.tap(() =>
          Effect.logInfo(nextState === "parked" ? "execution parked" : "execution completed", {
            sessionID,
            lineage: identity.lineage,
            instance: identity.instance,
          }),
        ),
        Effect.tap(() => checkQuiescent()),
      )
      return [operation, { ...state, active }] as const
    })
    yield* action
  })

  const park = Effect.fn("RuntimeLifecycle.park")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    if (!current) return
    yield* update(sessionID, current.fence, "parked")
    yield* Effect.logInfo("execution parked", { sessionID, lineage: identity.lineage, instance: identity.instance })
    yield* SynchronizedRef.update(ref, (state) => {
      const active = new Map(state.active)
      active.delete(sessionID)
      return { ...state, active }
    })
    yield* checkQuiescent()
  })

  const complete = Effect.fn("RuntimeLifecycle.complete")(function* (sessionID: string) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    if (!current) return
    yield* update(sessionID, current.fence, "completed")
    yield* SynchronizedRef.update(ref, (state) => {
      const active = new Map(state.active)
      active.delete(sessionID)
      return { ...state, active }
    })
    yield* checkQuiescent()
  })

  const beforeTurn = Effect.fn("RuntimeLifecycle.beforeTurn")(function* (sessionID: string) {
    return SynchronizedRef.getUnsafe(ref).phase === "running" && SynchronizedRef.getUnsafe(ref).active.has(sessionID)
  })

  const checkpoint = Effect.fn("RuntimeLifecycle.checkpoint")(function* (sessionID: string) {
    if (SynchronizedRef.getUnsafe(ref).phase === "running") return true
    yield* park(sessionID)
    return false
  })

  const retry = Effect.fn("RuntimeLifecycle.retry")(function* (sessionID: string, retryAt: number) {
    const current = SynchronizedRef.getUnsafe(ref).active.get(sessionID)
    if (!current) return
    yield* update(sessionID, current.fence, "retry_wait", retryAt)
    yield* SynchronizedRef.update(ref, (state) => {
      const active = new Map(state.active)
      active.set(sessionID, { ...current, mode: "retry_wait" })
      return { ...state, active }
    })
  })

  const awaitDraining = Deferred.await(draining)
  const awaitDrain = Deferred.await(drained)
  const awaitStop = Deferred.await(stopped)

  const recover = Effect.fn("RuntimeLifecycle.recover")(function* (
    run: (record: ExecutionRecord) => Effect.Effect<unknown>,
  ) {
    const database = databaseRef.current ?? (yield* Database.Service)
    const rows = yield* database.db.all<Row>(sql`
      SELECT * FROM runtime_execution
      WHERE owner_lineage = ${identity.lineage} AND desired_active = 1 AND state IN ('parked', 'retry_wait')
      ORDER BY time_updated ASC
    `)
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const record = yield* claim(row)
          if (!record) return
          yield* Effect.logInfo("execution recovery started", {
            sessionID: record.sessionID,
            lineage: identity.lineage,
          })
          yield* SynchronizedRef.update(ref, (state) => {
            const active = new Map(state.active)
            active.set(record.sessionID, {
              fence: record.fence,
              leases: 0,
              mode: row.state === "retry_wait" ? "retry_wait" : "active",
            })
            return { ...state, active }
          })
          if (row.retry_at && row.retry_at > Date.now()) {
            yield* Effect.sleep(Duration.millis(row.retry_at - Date.now())).pipe(Effect.raceFirst(awaitDraining))
            if (!SynchronizedRef.getUnsafe(ref).active.has(record.sessionID)) return
            yield* SynchronizedRef.update(ref, (state) => {
              const active = new Map(state.active)
              const current = active.get(record.sessionID)
              if (current) active.set(record.sessionID, { ...current, mode: "active" })
              return { ...state, active }
            })
          }
          yield* run(record).pipe(
            Effect.tap(() => Effect.logInfo("execution recovery completed", { sessionID: record.sessionID })),
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
                }
                yield* Effect.logError("execution recovery failed", { sessionID: record.sessionID, error })
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
