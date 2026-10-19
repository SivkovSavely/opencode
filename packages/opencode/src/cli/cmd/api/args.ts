const valueOptions = new Set([
  "--log-level",
  "--url",
  "--directory",
  "--workspace",
  "--username",
  "--password",
  "--timeout",
  "--header",
  "--output",
  "--body",
  "--body-file",
  "--event-format",
])
const booleanOptions = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--print-logs",
  "--pure",
  "--compact",
  "--raw",
  "--password-stdin",
  "--schema",
  "--remote",
])

export function normalizeApiArgs(input: string[]) {
  let command = 0
  while (command < input.length) {
    const argument = input[command]
    if (argument === "--") return { args: input, api: false }
    if (argument.startsWith("-")) {
      if (!argument.includes("=") && valueOptions.has(argument)) command++
      else if (!argument.includes("=") && booleanOptions.has(argument) && ["true", "false"].includes(input[command + 1])) command++
      command++
      continue
    }
    if (argument !== "api") return { args: input, api: false }
    const terminator = input.indexOf("--", command + 1)
    return {
      api: true,
      args: input.flatMap((value, index) => {
        if (terminator >= 0 && index >= terminator) return [value]
        if (booleanOptions.has(value) && ["true", "false"].includes(input[index + 1])) return [`${value}=${input[index + 1]}`]
        if (booleanOptions.has(input[index - 1]) && ["true", "false"].includes(value)) return []
        if (value === "--body-file" && input[index + 1] === "-") return ["--body-file=-"]
        if (value === "-" && input[index - 1] === "--body-file") return []
        return [value]
      }),
    }
  }
  return { args: input, api: false }
}
