import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { Schema } from "effect"

export class HandoffBadRequest extends Schema.ErrorClass<HandoffBadRequest>("HandoffBadRequest")(
  SessionHandoffV1.Error.fields,
  { httpApiStatus: 400 },
) {}
export class HandoffNotFound extends Schema.ErrorClass<HandoffNotFound>("HandoffNotFound")(
  SessionHandoffV1.Error.fields,
  { httpApiStatus: 404 },
) {}
export class HandoffConflict extends Schema.ErrorClass<HandoffConflict>("HandoffConflict")(
  SessionHandoffV1.Error.fields,
  { httpApiStatus: 409 },
) {}
export class HandoffUnsupported extends Schema.ErrorClass<HandoffUnsupported>("HandoffUnsupported")(
  SessionHandoffV1.Error.fields,
  { httpApiStatus: 422 },
) {}

export const HandoffErrors = [HandoffBadRequest, HandoffNotFound, HandoffConflict, HandoffUnsupported] as const

export function handoffError(error: SessionHandoffV1.Error) {
  switch (error.code) {
    case "invalid_request":
    case "incomplete_action_selector":
      return new HandoffBadRequest(error)
    case "not_found":
    case "history_unavailable":
      return new HandoffNotFound(error)
    case "unsupported_model":
    case "unsupported_variant":
    case "unsupported_dispatch":
      return new HandoffUnsupported(error)
    default:
      return new HandoffConflict(error)
  }
}
