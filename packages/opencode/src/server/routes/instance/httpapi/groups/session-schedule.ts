import { SessionScheduleV1 } from "@opencode-ai/schema/v1/session-schedule"
import { optional } from "@opencode-ai/schema/schema"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError } from "../errors"

const root = "/session/:sessionID/schedule"
const params = { sessionID: SessionID }
const item = { ...params, scheduleID: Schema.String }
const error = [SessionNotFoundError, ForbiddenError, ConflictError, InvalidRequestError]
const annotation = (name: string, summary: string) =>
  OpenApi.annotations({ identifier: `sessionSchedule.${name}`, summary })

export const SessionScheduleApi = HttpApi.make("session-schedule").add(
  HttpApiGroup.make("sessionSchedule")
    .add(
      HttpApiEndpoint.get("list", root, {
        params,
        query: WorkspaceRoutingQuery,
        success: Schema.Array(SessionScheduleV1.Info),
        error,
      }).annotateMerge(annotation("list", "List session schedules")),
      HttpApiEndpoint.post("create", root, {
        params,
        query: WorkspaceRoutingQuery,
        payload: SessionScheduleV1.Input,
        success: SessionScheduleV1.Info,
        error,
      }).annotateMerge(annotation("create", "Create session schedule")),
      HttpApiEndpoint.post("preview", `${root}/preview`, {
        params,
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ spec: SessionScheduleV1.Spec, scheduleID: optional(Schema.String) }),
        success: SessionScheduleV1.Preview,
        error,
      }).annotateMerge(annotation("preview", "Preview session schedule")),
      HttpApiEndpoint.get("get", `${root}/:scheduleID`, {
        params: item,
        query: WorkspaceRoutingQuery,
        success: SessionScheduleV1.Info,
        error,
      }).annotateMerge(annotation("get", "Get session schedule")),
      HttpApiEndpoint.put("update", `${root}/:scheduleID`, {
        params: item,
        query: WorkspaceRoutingQuery,
        payload: SessionScheduleV1.Input,
        success: SessionScheduleV1.Info,
        error,
      }).annotateMerge(annotation("update", "Update session schedule")),
      HttpApiEndpoint.delete("remove", `${root}/:scheduleID`, {
        params: item,
        query: WorkspaceRoutingQuery,
        success: Schema.Boolean,
        error,
      }).annotateMerge(annotation("remove", "Delete session schedule")),
      HttpApiEndpoint.post("pause", `${root}/:scheduleID/pause`, {
        params: item,
        query: WorkspaceRoutingQuery,
        payload: Schema.Struct({ paused: Schema.Boolean }),
        success: SessionScheduleV1.Info,
        error,
      }).annotateMerge(annotation("pause", "Pause or resume session schedule")),
      HttpApiEndpoint.get("history", `${root}/:scheduleID/history`, {
        params: item,
        query: Schema.Struct({
          ...WorkspaceRoutingQueryFields,
          cursor: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
        }),
        success: SessionScheduleV1.History,
        error,
      }).annotateMerge(annotation("history", "Get session schedule history")),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
