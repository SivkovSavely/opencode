import { describe, expect, test } from "bun:test"
import { ModelReference } from "@/provider/model-reference"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

describe("model references", () => {
  test("preserves nested model IDs and explicit variant precedence", () => {
    expect(ModelReference.parse("provider/org/model#low", "high")).toEqual({
      providerID: ProviderV2.ID.make("provider"),
      modelID: ModelV2.ID.make("org/model"),
      variant: "high",
    })
    expect(ModelReference.parse("provider/org/model#low").variant).toBe("low")
    expect(ModelReference.parse("provider/org/model").variant).toBeUndefined()
  })

  for (const value of ["", "model", "/model", "provider/", "provider/model#", "provider/model#low#high"]) {
    test(`rejects malformed reference ${JSON.stringify(value)} even with an override`, () => {
      expect(() => ModelReference.parse(value, "high")).toThrow("Invalid model")
    })
  }

  test("validates only the effective variant and keeps default semantics", () => {
    const model = { variants: { high: { reasoningEffort: "high" } } }
    expect(() =>
      ModelReference.validateVariant(model, ModelReference.parse("p/m#unsupported", "high").variant),
    ).not.toThrow()
    expect(() => ModelReference.parse("p/m#high", "")).toThrow("empty")
    expect(() => ModelReference.validateVariant(model, "")).toThrow("empty")
    expect(() => ModelReference.validateVariant(model, "low")).toThrow('Variant "low"')
    expect(() => ModelReference.validateVariant(model, "toString")).toThrow('Variant "toString"')
    expect(() => ModelReference.validateVariant(model, "default")).not.toThrow()
    expect(() => ModelReference.validateVariant({}, undefined)).not.toThrow()
  })
})
