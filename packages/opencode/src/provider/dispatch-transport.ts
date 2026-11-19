import { Schema } from "effect"

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type Boundary = Readonly<{
  validateHttp: (serialized: unknown) => void
  validateFrame: (serialized: string) => void
  prepared: () => Promise<void>
}>

export class UnsupportedDispatch extends Schema.TaggedErrorClass<UnsupportedDispatch>()("UnsupportedDispatch", {}) {
  override get message() {
    return "unsupported_dispatch: controlled model/effort could not be verified"
  }
}

export class CallbackFailure extends Error {
  constructor() {
    super("dispatch_callback_failed")
  }
}

export function isFailure(error: unknown) {
  return error instanceof UnsupportedDispatch || error instanceof CallbackFailure
}

export * as DispatchTransport from "./dispatch-transport"
