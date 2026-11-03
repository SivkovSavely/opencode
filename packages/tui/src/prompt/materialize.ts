import type { PromptInfo } from "./history"
import { displaySlice, promptOffsetWidth } from "./display"

export function materializePrompt(prompt: PromptInfo, caret = promptOffsetWidth(prompt.input)) {
  const replacements = prompt.parts
    .flatMap((part) => {
      if (part.type === "control") return [{ ...part.source, text: "" }]
      if (part.type === "text" && part.source) return [{ ...part.source.text, text: part.text }]
      return []
    })
    .filter((span) => displaySlice(prompt.input, span.start, span.end) === span.value)
    .sort((a, b) => a.start - b.start)
  const offset = (position: number) =>
    position +
    replacements.reduce(
      (delta, span) => delta + (span.end <= position ? promptOffsetWidth(span.text) - (span.end - span.start) : 0),
      0,
    )
  const input = replacements
    .toReversed()
    .reduce((text, span) => displaySlice(text, 0, span.start) + span.text + displaySlice(text, span.end), prompt.input)
  // Extmarks use display cells; protocol sources use JavaScript string indices.
  const sourceIndex = (position: number) => displaySlice(input, 0, offset(position)).length
  const parts = prompt.parts.flatMap((part) => {
    if (part.type === "control" || part.type === "text") return []
    if (part.type === "skill")
      return [
        {
          type: "file" as const,
          mime: "application/x-opencode-skill",
          filename: part.name,
          url: "skill:" + encodeURIComponent(part.name),
        },
      ]
    if (part.type === "agent" && part.source)
      return [
        {
          ...part,
          source: { ...part.source, start: sourceIndex(part.source.start), end: sourceIndex(part.source.end) },
        },
      ]
    if (part.type === "file" && part.source)
      return [
        {
          ...part,
          source: {
            ...part.source,
            text: {
              ...part.source.text,
              start: sourceIndex(part.source.text.start),
              end: sourceIndex(part.source.text.end),
            },
          },
        },
      ]
    return [part]
  })
  const controls = prompt.parts
    .filter((part) => part.type === "control")
    .filter((part) => replacements.some((span) => span.start === part.source.start && span.end === part.source.end))
  const model = controls.findLast((part) => part.kind === "model")
  const variant = controls.findLast((part) => part.kind === "variant")
  const sourceOffset = (position: number) => {
    let delta = 0
    for (const span of replacements) {
      if (span.start + delta > position) break
      delta += promptOffsetWidth(span.text) - (span.end - span.start)
    }
    return position - delta
  }
  return {
    input,
    parts,
    caret: offset(caret),
    sourceOffset,
    selection: {
      ...(model?.kind === "model" ? { model: model.model } : {}),
      ...(variant?.kind === "variant" ? { variant: variant.variant } : {}),
    },
  }
}
