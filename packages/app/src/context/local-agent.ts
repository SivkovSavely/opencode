export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}

export function resolveChildAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name)
}

export function resolveChildModel(model?: { id: string; providerID: string; variant?: string }) {
  if (!model) return
  return { providerID: model.providerID, modelID: model.id, variant: model.variant }
}
