export function diagnosticErrorFields(error: unknown) {
  try {
    const errorType = diagnosticText(
      error instanceof Error ? (diagnosticErrorField(error, "name") ?? "Error") : typeof error,
      80,
    )
    const message =
      error instanceof Error
        ? (diagnosticErrorField(error, "message") ??
          (errorType === "ResolveMessage"
            ? "Module resolution failed; check custom tool imports and dependencies (message accessor omitted)"
            : "Error message unavailable (accessor omitted)"))
        : "Non-Error failure (payload omitted)"
    // Preserve module-linking context without rendering arbitrary quoted error payloads.
    const missing = /^Export named ['"]([\w$]{1,80})['"] not found in module ['"]([^'"\r\n]{1,2048})['"]\.?$/.exec(
      message.slice(0, 4096),
    )
    const unresolved = /^Cannot find (package|module) ['"]([^'"\r\n]{1,2048})['"]/.exec(message.slice(0, 4096))
    return {
      errorType,
      errorMessage: diagnosticText(
        missing
          ? `Missing export ${missing[1]}; check tool/plugin API versions. Module: ${missing[2]}`
          : unresolved
            ? `Cannot find ${unresolved[1]} ${unresolved[2]}; check custom tool dependencies`
            : errorType === "SyntaxError"
              ? message
                  .slice(0, 4096)
                  .replace(
                    /\b((?:unexpected|invalid|unrecognized)\s+(?:token|identifier|character))\b.*/i,
                    "$1 [redacted data]",
                  )
              : message,
        512,
      ),
    }
  } catch {
    return { errorType: "Unknown", errorMessage: "Error details unavailable" }
  }
}

export function diagnosticErrorField(error: Error, key: "name" | "message" | "stack") {
  let current: object | null = error
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      // Accessors can render sensitive payloads or throw before truncation.
      const value: unknown = descriptor.value
      return typeof value === "string" ? value : undefined
    }
    current = Object.getPrototypeOf(current)
  }
}

export function diagnosticText(value: string, limit: number) {
  return (value.slice(0, 4096).split(/[\r\n]/, 1)[0] ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:https?|wss?):\/\/[^\s)]+/gi, "[redacted URL]")
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[redacted credential]")
    .replace(/\b(?:authorization|api[-_]?key|token|password|secret)\s*[:=]\s*\S+/gi, "[redacted credential]")
    .replace(/\b(?:prompt|output|arguments?|payload|request(?: body)?|body|input)\s*[:=].*/gi, "[redacted data]")
    .replace(/["'`\[{<].*$/, "[redacted data]")
    .slice(0, limit)
}
