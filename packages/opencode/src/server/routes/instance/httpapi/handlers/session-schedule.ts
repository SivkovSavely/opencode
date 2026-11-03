import path from "node:path"
import { Session } from "@/session/session"
import { SessionSchedule } from "@/session/schedule"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError } from "../errors"

export const sessionScheduleHandlers = HttpApiBuilder.group(InstanceHttpApi, "sessionSchedule", (handlers) =>
  Effect.gen(function* () {
    const schedules = yield* SessionSchedule.Service
    const sessions = yield* Session.Service

    const mapError = (sessionID: SessionID) => (error: SessionSchedule.ScheduleError) => {
      if (error.reason === "not_found") return new SessionNotFoundError({ sessionID, message: error.message })
      if (error.reason === "scope") return new ForbiddenError({ message: error.message })
      if (error.reason === "invalid") return new InvalidRequestError({ message: error.message })
      return new ConflictError({ resource: sessionID, message: error.message })
    }
    const scope = Effect.fnUntraced(function* (sessionID: SessionID, mutation = false) {
      yield* schedules.list(sessionID).pipe(Effect.mapError(mapError(sessionID)))
      const current = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const directory = yield* Effect.try({
        try: () =>
          url.searchParams.get("directory") ??
          (request.headers["x-opencode-directory"]
            ? decodeURIComponent(request.headers["x-opencode-directory"])
            : undefined),
        catch: () => new InvalidRequestError({ message: "Invalid directory encoding" }),
      })
      const workspace = url.searchParams.get("workspace") ?? request.headers["x-opencode-workspace"]
      if (
        (directory && path.resolve(directory) !== path.resolve(current.directory)) ||
        (workspace && workspace !== current.workspaceID)
      )
        return yield* new ForbiddenError({ message: "Session is outside the requested directory/workspace" })
      if (mutation && process.env.OPENCODE_MANAGED_PROFILE === "1" && current.parentID)
        return yield* new ConflictError({
          resource: sessionID,
          message: "Managed foreground children accept only their joined Task prompt",
        })
    })

    return handlers
      .handle("list", ({ params }) =>
        scope(params.sessionID).pipe(
          Effect.andThen(() => schedules.list(params.sessionID).pipe(Effect.mapError(mapError(params.sessionID)))),
        ),
      )
      .handle("get", ({ params }) =>
        scope(params.sessionID).pipe(
          Effect.andThen(() =>
            schedules.get(params.sessionID, params.scheduleID).pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("create", ({ params, payload }) =>
        scope(params.sessionID, true).pipe(
          Effect.andThen(() =>
            schedules.create(params.sessionID, payload).pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("update", ({ params, payload }) =>
        scope(params.sessionID, true).pipe(
          Effect.andThen(() =>
            schedules
              .update(params.sessionID, params.scheduleID, payload)
              .pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("pause", ({ params, payload }) =>
        scope(params.sessionID, true).pipe(
          Effect.andThen(() =>
            schedules
              .pause(params.sessionID, params.scheduleID, payload.paused)
              .pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("remove", ({ params }) =>
        scope(params.sessionID, true).pipe(
          Effect.andThen(() =>
            schedules
              .remove(params.sessionID, params.scheduleID)
              .pipe(Effect.as(true), Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("history", ({ params, query }) =>
        scope(params.sessionID).pipe(
          Effect.andThen(() =>
            schedules
              .history(params.sessionID, params.scheduleID, query.cursor)
              .pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
      .handle("preview", ({ params, payload }) =>
        scope(params.sessionID).pipe(
          Effect.andThen(() =>
            schedules.preview(params.sessionID, payload).pipe(Effect.mapError(mapError(params.sessionID))),
          ),
        ),
      )
  }),
)
