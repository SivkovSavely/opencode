import { catalog } from "./commands"
import { choices, inputOptions, scalar } from "./schema"
import { safeServer } from "./request"

const valueFlags = new Set([
  "--server",
  "--directory",
  "--workspace",
  "--username",
  "--password",
  "--timeout",
  "--header",
  "-H",
  "--body",
  "--data",
  "-d",
  "--body-file",
  "--output",
  "--param",
])
const flags = [
  "--server",
  "--standalone",
  "--directory",
  "--workspace",
  "--username",
  "--password",
  "--password-stdin",
  "--timeout",
  "--header",
  "--body",
  "--body-file",
  "--compact",
  "--raw",
  "--output",
  "--schema",
  "--help",
]

export async function complete(
  words: readonly string[],
  options: { server?: string; password?: string; directory?: string; workspace?: string } = {},
) {
  const prefix = words.at(-1) ?? ""
  const before = words.slice(0, -1)
  const positionals: string[] = []
  const inputs: Record<string, string> = {}
  const currentFlag = prefix.startsWith("--") && prefix.includes("=") ? prefix.slice(0, prefix.indexOf("=")) : undefined
  const currentValue = currentFlag ? prefix.slice(prefix.indexOf("=") + 1) : prefix
  let expecting: string | undefined
  for (const word of before) {
    if (expecting) {
      inputs[expecting] = word
      expecting = undefined
      continue
    }
    if (word.startsWith("-")) {
      const index = word.indexOf("=")
      if (index >= 0) {
        inputs[word.slice(0, index)] = word.slice(index + 1)
        continue
      }
      const operation = catalog.operations.find((operation) =>
        operation.command.every((part, index) => positionals[index] === part),
      )
      const option = operation && inputOptions(operation, catalog).find((option) => `--${option.flag}` === word)
      if (valueFlags.has(word) || (option && scalar(option.schema, catalog)?.type !== "boolean")) expecting = word
      continue
    }
    positionals.push(word)
  }
  const operation = catalog.operations.find((operation) =>
    operation.command.every((part, index) => positionals[index] === part),
  )
  const option =
    operation && inputOptions(operation, catalog).find((option) => `--${option.flag}` === (currentFlag ?? expecting))
  if (currentFlag || expecting) {
    if (["--password", "--header", "--body", "--data"].includes(currentFlag ?? expecting ?? "")) return []
    const values = option
      ? choices(scalar(option.schema, catalog)?.items ?? option.schema, catalog)
      : (currentFlag ?? expecting) === "--username"
        ? ["opencode"]
        : []
    return values
      .filter((value) => value.startsWith(currentValue))
      .map((value) => (currentFlag ? `${currentFlag}=${value}` : value))
  }
  if (prefix.startsWith("-"))
    return [
      ...new Set([
        ...flags,
        ...(operation ? inputOptions(operation, catalog).map((option) => `--${option.flag}`) : []),
      ]),
    ]
      .filter((flag) => flag.startsWith(prefix))
      .sort()
  const commands = [
    ...new Set([
      ...catalog.operations
        .filter((operation) => positionals.every((word, index) => operation.command[index] === word))
        .map((operation) => operation.command[positionals.length])
        .filter((word) => word !== undefined),
      ...(positionals.length ? [] : ["request", "spec", "catalog", "complete", "completion"]),
    ]),
  ]
    .filter((word) => word.startsWith(prefix))
    .sort()
  const server = options.server ?? inputs["--server"]
  if (commands.length || !operation || !server) return commands
  // Workspace dispatch is POST. Keep completion GET-only, never query the host's local identifiers instead.
  if (options.workspace !== undefined || inputs["--workspace"] !== undefined) return commands
  const param = operation.parameters.filter((param) => param.in === "path")[
    positionals.length - operation.command.length
  ]
  const lookup = (
    {
      sessionID: "/api/session?limit=50",
      projectID: "/api/project",
      ptyID: "/api/pty",
      providerID: "/api/provider",
      integrationID: "/api/integration",
    } as Record<string, string>
  )[param?.name ?? ""]
  if (!lookup) return commands
  // No service discovery, credential stores, mutation, pagination, or unbounded response buffering in completion.
  return (async () => {
    const url = new URL(lookup, safeServer(server))
    const directory = options.directory ?? inputs["--directory"]
    if (directory)
      url.searchParams.set(lookup.startsWith("/api/session?") ? "directory" : "location[directory]", directory)
    const password = options.password ?? inputs["--password"]
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(400),
      headers: password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {},
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return commands
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > 262144) return commands
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString())
    const items = Array.isArray(json)
      ? json
      : json && typeof json === "object"
        ? "data" in json && Array.isArray(json.data)
          ? json.data
          : "items" in json && Array.isArray(json.items)
            ? json.items
            : []
        : []
    return items
      .slice(0, 50)
      .flatMap((item: unknown) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        typeof item.id === "string" &&
        /^[\w.-]+$/.test(item.id) &&
        item.id.startsWith(prefix)
          ? [item.id]
          : [],
      )
  })().catch(() => commands)
}

export function zshWrapper() {
  return `# Source after native opencode --completions zsh. API-only dynamic enhancement.
if (( $+functions[_opencode] )); then
  functions -c _opencode _opencode_native
  _opencode() {
    local api_index=''
    local i
    for (( i=2; i<CURRENT; i++ )); do
      [[ $words[i-1] == --server || $words[i-1] == --log-level || $words[i-1] == --completions ]] && continue
      [[ $words[i-1] == --print-logs && ( $words[i] == true || $words[i] == false ) ]] && continue
      if [[ $words[i] == api ]]; then api_index=$i; break; fi
      [[ $words[i] != -* ]] && { _opencode_native "$@"; return; }
    done
    [[ -z $api_index ]] && { _opencode_native "$@"; return; }
    local -a candidates
    local current_word=$words[CURRENT]
    local previous_word=$words[CURRENT-1]
    case "$current_word:$previous_word" in
      --body-file=*:*|--output=*:*|--directory=*:*|*:--body-file|*:--output|*:--directory)
        [[ $current_word == --*=* ]] && compset -P '*='
        _files; return ;;
    esac
    candidates=("\${(@f)$(command "$words[1]" "\${words[@]:1:$((api_index-2))}" api complete -- "\${words[@]:$api_index:$((CURRENT-api_index))}")}")
    if (( \${#candidates} )); then
      [[ $current_word == --*=* ]] && { compset -P '*='; candidates=("\${candidates[@]#*=}"); }
      compadd -- "\${candidates[@]}"
      return
    fi
    _opencode_native "$@"
  }
fi
`
}
