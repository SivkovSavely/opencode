export const METADATA_KEY = "opencode.mcp.activated.v1"
const LEGACY_METADATA_KEY = "opencode.mcp.activated"

export function names(metadata?: Record<string, unknown>) {
  const value = metadata?.[METADATA_KEY]
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
}

export function without(metadata?: Record<string, unknown>) {
  if (!metadata || (!Object.hasOwn(metadata, METADATA_KEY) && !Object.hasOwn(metadata, LEGACY_METADATA_KEY)))
    return metadata
  const result = { ...metadata }
  delete result[METADATA_KEY]
  delete result[LEGACY_METADATA_KEY]
  return Object.keys(result).length > 0 ? result : undefined
}

export * as McpActivation from "./mcp-activation"
