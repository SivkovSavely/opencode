import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export function parse(input: string, variant?: string) {
  const [value, suffix, ...rest] = input.split("#")
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1 || suffix === "" || rest.length > 0)
    throw new Error(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  if (variant === "") throw new Error("Model variant must not be empty")
  return {
    providerID: ProviderV2.ID.make(value.slice(0, slash)),
    modelID: ModelV2.ID.make(value.slice(slash + 1)),
    variant: variant ?? suffix,
  }
}

export function validateVariant(model: { variants?: Record<string, unknown> }, variant?: string) {
  if (variant === "") throw new Error("Model variant must not be empty")
  if (variant === undefined || variant === "default" || Object.hasOwn(model.variants ?? {}, variant)) return
  const variants = Object.keys(model.variants ?? {})
  throw new Error(
    variants.length === 0
      ? "Model has no variants. Omit the variant."
      : `Variant "${variant}" is not available. Available: ${variants
          .slice(0, 20)
          .map((name) => name.slice(0, 128))
          .join(", ")}.`,
  )
}

export * as ModelReference from "./model-reference"
