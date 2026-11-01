import { Database } from "@opencode-ai/core/database/database"
import { HistoricalFence } from "@opencode-ai/core/historical-fence"
import { Config, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { HistoricalFenceAuthority } from "@/server/historical-fence-authority"
import { RuntimeLifecycle } from "@/server/runtime-lifecycle"
import { SessionRunState } from "@/session/run-state"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"
import { HistoricalFenceError } from "../groups/historical-fence"

export const historicalFenceHandlers = HttpApiBuilder.group(InstanceHttpApi, "historicalFence", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runtime = yield* RuntimeLifecycle.Service
    const runState = yield* SessionRunState.Service
    const sessionV2 = yield* SessionV2.Service
    const scope = yield* Effect.scope
    const publicKey = yield* Config.string("OPENCODE_HISTORICAL_FENCE_PUBLIC_KEY").pipe(Config.withDefault(""))
    const binding = Effect.gen(function* () {
      if (!publicKey) return yield* new HistoricalFence.Rejected({ reason: "maintenance_disabled" })
      const instance = yield* InstanceRef
      if (!instance) return yield* new HistoricalFence.Rejected({ reason: "missing_workspace_binding" })
      return {
        databaseID: yield* HistoricalFence.identity(database).pipe(Effect.orDie),
        projectID: instance.project.id,
        directory: instance.directory,
        workspaceID: (yield* WorkspaceRef) ?? null,
      }
    })
    const mapError = (error: HistoricalFence.Rejected) => new HistoricalFenceError({ reason: error.reason })
    return handlers
      .handle("identity", () => binding.pipe(Effect.mapError(mapError)))
      .handle("enroll", ({ payload }) =>
        Effect.gen(function* () {
          const context = yield* binding
          const signer = yield* HistoricalFenceAuthority.authorize(
            payload.attestation,
            payload.signature,
            context,
            publicKey,
          )
          const result = yield* HistoricalFence.enroll(database, payload.attestation, signer, payload.signature).pipe(
            Effect.catch((error) =>
              error instanceof HistoricalFence.Rejected ? Effect.fail(error) : Effect.die(error),
            ),
          )
          // Reuse the runtime's durable retirement path to notify locally owned work.
          const retired = yield* runtime.retireRoot(payload.attestation.rootSessionID).pipe(Effect.orDie)
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const ownsCancel = yield* runtime.cancel(payload.attestation.rootSessionID)
              yield* restore(
                Effect.forEach(
                  retired.sessionIDs,
                  (id) =>
                    Effect.all([runState.cancel(SessionID.make(id)), sessionV2.interrupt(SessionSchema.ID.make(id))], {
                      concurrency: "unbounded",
                      discard: true,
                    }),
                  { concurrency: "unbounded", discard: true },
                ),
              ).pipe(
                Effect.ensuring(ownsCancel ? runtime.finishCancel(payload.attestation.rootSessionID) : Effect.void),
              )
            }),
          ).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return {
            ...result,
            signer,
            rootSessionID: payload.attestation.rootSessionID,
            sessionIDs: payload.attestation.members.map((member) => member.sessionID),
            membershipCoverage: "attested-partial" as const,
            admissionFence: "permanent" as const,
            historicalCleanup: "unknown" as const,
            commandStatus: "unknown" as const,
          }
        }).pipe(Effect.mapError(mapError)),
      )
  }),
)
