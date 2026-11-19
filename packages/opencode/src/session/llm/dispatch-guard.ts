import type { JSONValue, LanguageModelV3 } from "@ai-sdk/provider"
import { types } from "node:util"
import { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { DispatchTransport, UnsupportedDispatch } from "@/provider/dispatch-transport"

export { UnsupportedDispatch } from "@/provider/dispatch-transport"

export type Selection = {
  readonly providerID: string
  readonly modelID: string
  readonly variant: string
}

export type DispatchSelection = Selection & {
  readonly apiModelID: string
  readonly reasoningEffort: string | null
  readonly adapter: "openai-compatible-chat" | "openai-responses" | "openai-chat"
  readonly phase: "prepared"
}

// Capture the approved mapping and private adapter before plugins see mutable metadata.
export async function prepare(
  model: Provider.Model,
  language: LanguageModelV3,
  expected: Selection,
  provider: Provider.Info,
  defaults: readonly unknown[] = [],
) {
  const { OpenAICompatibleChatLanguageModel } = await import("@ai-sdk/openai-compatible")
  const providerID = data(model, "providerID")
  const modelID = data(model, "id")
  const apiID = data(data(model, "api"), "id")
  const variantName = data(expected, "variant")
  const npm = data(data(model, "api"), "npm")
  const compatible = npm === "@ai-sdk/openai-compatible"
  if (
    typeof providerID !== "string" ||
    typeof modelID !== "string" ||
    typeof apiID !== "string" ||
    typeof variantName !== "string" ||
    (!compatible && npm !== "@ai-sdk/openai")
  )
    throw new UnsupportedDispatch()
  const variant = snapshot(mapping(model, variantName), compatible)
  const policy = snapshot(variantName === "default" ? Object.assign({}, ...defaults.map(plain)) : variant, compatible)
  const effort: unknown = policy.reasoningEffort
  if (effort !== undefined && typeof effort !== "string") throw new UnsupportedDispatch()
  const source = data(language, "config")
  const config = plain(source)
  const kind = compatible
    ? "openai-compatible-chat"
    : config.provider === `${providerID}.responses`
      ? "openai-responses"
      : "openai-chat"
  const path = kind === "openai-responses" ? "/responses" : "/chat/completions"
  const key = compatible ? providerID.split(".")[0] : "openai"
  const transport = Provider.dispatchTransport(config.fetch)
  if (
    data(expected, "providerID") !== providerID ||
    data(expected, "modelID") !== modelID ||
    data(data(provider, "options"), "fetch") !== transport?.source ||
    data(data(model, "options"), "fetch") !== undefined ||
    config.provider !== `${providerID}.${kind === "openai-responses" ? "responses" : "chat"}` ||
    data(language, "modelId") !== apiID ||
    !transport ||
    (transport.builtin !== "default" && (providerID !== "openai" || kind !== "openai-responses")) ||
    config.transformRequestBody !== undefined ||
    config.metadataExtractor !== undefined ||
    config.errorStructure !== undefined ||
    config.supportedUrls !== undefined ||
    config.generateId !== undefined ||
    (config.fileIdPrefixes !== undefined &&
      (!Array.isArray(config.fileIdPrefixes) ||
        config.fileIdPrefixes.length !== 1 ||
        config.fileIdPrefixes[0] !== "file-")) ||
    (config.includeUsage !== undefined && typeof config.includeUsage !== "boolean") ||
    (config.supportsStructuredOutputs !== undefined && typeof config.supportsStructuredOutputs !== "boolean") ||
    typeof config.url !== "function" ||
    typeof config.headers !== "function" ||
    (variantName === "default" && Object.keys(variant).length !== 0) ||
    (effort === undefined
      ? variantName !== "default"
      : !["none", "minimal", "low", "medium", "high", "xhigh", ...(!compatible ? ["max"] : [])].includes(effort))
  )
    throw new UnsupportedDispatch()

  const endpoint: unknown = config.url({ modelId: apiID, path })
  if (typeof endpoint !== "string") throw new UnsupportedDispatch()
  const headers = Object.fromEntries(
    Object.entries(plain(config.headers())).map(([key, value]) => {
      if (typeof value !== "string" && value !== undefined) throw new UnsupportedDispatch()
      return [key, value] as const
    }),
  )
  Object.setPrototypeOf(headers, null)
  Object.freeze(headers)
  const baseConfig = Object.freeze({
    provider: `${providerID}.${kind === "openai-responses" ? "responses" : "chat"}`,
    url: () => endpoint,
    headers: () => headers,
    includeUsage: config.includeUsage,
    supportsStructuredOutputs: config.supportsStructuredOutputs,
    fileIdPrefixes: config.fileIdPrefixes === undefined ? undefined : Object.freeze(["file-"]),
  })
  // The public and internal OpenAI bundles contain separate class identities.
  const { createOpenAI } = await import("@ai-sdk/openai")
  const make = (fetch: typeof globalThis.fetch) => {
    const privateConfig = Object.freeze({ ...baseConfig, fetch })
    const controlled = compatible
      ? new OpenAICompatibleChatLanguageModel(apiID, privateConfig)
      : createOpenAI({ name: providerID })[kind === "openai-responses" ? "responses" : "chat"](apiID)
    const prototype = Object.getPrototypeOf(controlled)
    if (Object.getPrototypeOf(language) !== prototype) throw new UnsupportedDispatch()
    Object.defineProperty(controlled, "config", { value: privateConfig })
    // Plugins can reach the cached adapter, but not this frozen per-attempt copy.
    Object.setPrototypeOf(controlled, Object.freeze(Object.create(null, Object.getOwnPropertyDescriptors(prototype))))
    return Object.freeze(controlled)
  }
  const selection = Object.freeze({
    providerID,
    modelID,
    variant: variantName,
    apiModelID: apiID,
    reasoningEffort: effort ?? null,
    adapter: kind,
    phase: "prepared",
  } satisfies DispatchSelection)
  const blocked = () => {
    throw new UnsupportedDispatch()
  }
  const template = make(
    transport.bind({ validateHttp: blocked, validateFrame: blocked, prepared: async () => blocked() }),
  )

  const validate = (options: unknown) => {
    const namespaces = plain(options)
    const normalized = snapshot(namespaces[key], compatible)
    const current = snapshot(mapping(model, variantName), compatible)
    if (
      data(model, "providerID") !== providerID ||
      data(model, "id") !== modelID ||
      data(data(model, "api"), "id") !== apiID ||
      data(data(model, "api"), "npm") !== npm ||
      data(data(provider, "options"), "fetch") !== transport?.source ||
      data(data(model, "options"), "fetch") !== undefined ||
      data(language, "modelId") !== apiID ||
      data(language, "config") !== source ||
      data(source, "fetch") !== config.fetch ||
      data(source, "provider") !== config.provider ||
      data(source, "transformRequestBody") !== undefined ||
      (variantName === "default" ? Object.keys(current).length !== 0 : current.reasoningEffort !== effort) ||
      Object.keys(namespaces).length !== 1 ||
      normalized.reasoningEffort !== effort ||
      (!compatible && effort !== undefined && normalized.forceReasoning !== true)
    )
      throw new UnsupportedDispatch()
    // Never hand plugin-owned objects to the adapter's asynchronous option parsing.
    const result = { [key]: Object.freeze(normalized) }
    Object.setPrototypeOf(result, null)
    return Object.freeze(result)
  }

  const serialized = (value: unknown, frame: boolean) => {
    if (typeof value !== "string") throw new UnsupportedDispatch()
    const body = plain(JSON.parse(value))
    if (
      body.model !== apiID ||
      (frame ? kind !== "openai-responses" || body.type !== "response.create" : body.type !== undefined) ||
      ["reasoningEffort", "reasoningMode", "reasoning_mode", "thinking", "enable_thinking"].some((key) =>
        Object.hasOwn(body, key),
      )
    )
      throw new UnsupportedDispatch()
    if (kind === "openai-responses") {
      const reasoning = body.reasoning === undefined ? {} : plain(body.reasoning)
      if (
        Object.hasOwn(body, "reasoning_effort") ||
        reasoning.effort !== effort ||
        Object.keys(reasoning).some((key) => key !== "effort" && key !== "summary") ||
        (frame && (body.stream !== undefined || body.background !== undefined))
      )
        throw new UnsupportedDispatch()
      return
    }
    if (body.reasoning_effort !== effort || body.reasoning !== undefined) throw new UnsupportedDispatch()
  }

  return {
    model: template,
    selection,
    attempt(options: unknown, onPrepared: () => Promise<void>, onUnsupported: (error: UnsupportedDispatch) => void) {
      const reject = (): never => {
        const error = new UnsupportedDispatch()
        onUnsupported(error)
        throw error
      }
      const providerOptions = (() => {
        try {
          return validate(options)
        } catch {
          return reject()
        }
      })()
      const state: { ready?: Promise<void> } = {}
      const boundary: DispatchTransport.Boundary = Object.freeze({
        validateHttp(value) {
          try {
            serialized(value, false)
          } catch {
            reject()
          }
        },
        validateFrame(value) {
          try {
            serialized(value, true)
          } catch {
            reject()
          }
        },
        prepared() {
          return (state.ready ??= Promise.resolve().then(onPrepared))
        },
      })
      const bound = transport.bind(boundary)
      const fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          try {
            return await bound(input, init)
          } catch (error) {
            if (error instanceof UnsupportedDispatch) onUnsupported(error)
            throw error
          }
        },
        { preconnect: bound.preconnect },
      )
      return { model: make(fetch), providerOptions }
    },
  }
}

function snapshot(value: unknown, compatible: boolean): Record<string, JSONValue | undefined> {
  const result = Object.fromEntries(
    Object.entries(plain(value)).map(([key, value]): [string, JSONValue | undefined] => {
      if (key === "reasoningEffort" && (value === undefined || typeof value === "string")) return [key, value]
      if (!compatible) {
        if (key === "forceReasoning" && value === true) return [key, value]
        if (key === "store" && typeof value === "boolean") return [key, value]
        if (["promptCacheKey", "instructions", "previousResponseId"].includes(key) && typeof value === "string")
          return [key, value]
        if (key === "reasoningSummary" && typeof value === "string" && ["auto", "concise", "detailed"].includes(value))
          return [key, value]
        if (key === "textVerbosity" && typeof value === "string" && ["low", "medium", "high"].includes(value))
          return [key, value]
        if (key === "include" && Array.isArray(value) && !types.isProxy(value) && value.length === 1) {
          const item = Object.getOwnPropertyDescriptor(value, "0")
          if (!item || !("value" in item) || item.value !== "reasoning.encrypted_content")
            throw new UnsupportedDispatch()
          const include = ["reasoning.encrypted_content"]
          Object.freeze(include)
          return [key, include]
        }
      }
      throw new UnsupportedDispatch()
    }),
  )
  Object.setPrototypeOf(result, null)
  return result
}

function mapping(model: Provider.Model, variant: string) {
  const variants = data(model, "variants")
  const selected = variants === undefined ? undefined : data(variants, variant)
  if (variant === "default" && selected === undefined) return {}
  return plain(selected)
}

function data(value: unknown, key: PropertyKey): unknown {
  if (!isRecord(value) || types.isProxy(value)) throw new UnsupportedDispatch()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) throw new UnsupportedDispatch()
  return descriptor.value
}

function plain(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || types.isProxy(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new UnsupportedDispatch()
  const result = Object.fromEntries(
    Reflect.ownKeys(value).map((key) => {
      if (typeof key !== "string") throw new UnsupportedDispatch()
      return [key, data(value, key)]
    }),
  )
  Object.setPrototypeOf(result, null)
  return result
}

export * as LLMDispatchGuard from "./dispatch-guard"
