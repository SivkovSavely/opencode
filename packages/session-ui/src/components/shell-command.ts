export type ShellToken = { text: string; color?: string }

export function formatShellCommand(source: string, shell?: string): string {
  if (!shell || !/^(?:ba|da|a|k|z)?sh$/.test(shell.split(/[/\\]/).pop() ?? "")) return source
  if (/[\r\n]/.test(source) || /LINENO|BASH_EXECUTION_STRING/.test(source)) return source

  const boundaries: { start: number; end: number; text: string }[] = []
  const unsupported =
    /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|coproc|time|in|\[\[|\]\])$/
  const reflective = /^(?:alias|unalias|eval|source|set|declare|typeset|shopt|builtin|command|exec|env|!|\.)$/
  let quote = ""
  let word = ""
  let command = false
  let checked = false

  // Only simple one-line lists are reformatted. Compound syntax, expansions with their own
  // grammar, comments and here-documents deliberately fall back to the original display.
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    // Keep ambiguous command heads and leading redirects verbatim, including after assignments.
    // Quotes and escapes in ordinary arguments remain eligible for formatting.
    if (!checked && !quote && /[<>]/.test(char)) return source
    if (!checked && !word.includes("=") && /[\\'"$*?~\[]/.test(char)) return source
    if (quote === "'") {
      if (char === "'") quote = ""
      continue
    }
    if (char === "\\") {
      if (++index >= source.length) return source
      word += "\\"
      command = true
      continue
    }
    if (char === "`" || (char === "$" && /[({'"]/.test(source[index + 1] ?? ""))) return source
    if (quote === '"') {
      if (char === '"') quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      word += char
      command = true
      continue
    }
    if (/[{}()#]/.test(char) || source.slice(index, index + 2) === "<<") return source
    if (/\s/.test(char) || /[;&|<>]/.test(char)) {
      if ((!checked && unsupported.test(word)) || reflective.test(word)) return source
      if (word && !word.includes("=")) checked = true
      word = ""
    } else {
      word += char
      command = true
    }
    if (char !== ";" && char !== "&" && char !== "|") continue
    const pair = source.slice(index, index + 2)
    if (char === "&" && source[index - 1] === ">") continue
    if (char === "|" && pair !== "||") {
      if (!command || source[index + 1] === "&") return source
      command = false
      checked = false
      continue
    }
    if (!command || (char === "&" && pair !== "&&")) return source
    const end = index + (pair === "&&" || pair === "||" ? 2 : 1)
    const next = source.slice(end).match(/^[ \t]*/)?.[0].length ?? 0
    if (/[;&|]/.test(source[end + next] ?? "")) return source
    if (end + next === source.length) {
      if (char !== ";") return source
      continue
    }
    boundaries.push({
      start: index,
      end: end + next,
      text: char === ";" ? ";\n" : `${/[ \t]/.test(source[index - 1] ?? "") ? "" : " "}\\\n  ${pair} `,
    })
    command = false
    checked = false
    index = end + next - 1
  }
  if (quote || (!checked && unsupported.test(word)) || reflective.test(word) || !command) return source
  let offset = 0
  return (
    boundaries
      .map((boundary) => {
        const text = source.slice(offset, boundary.start) + boundary.text
        offset = boundary.end
        return text
      })
      .join("") + source.slice(offset)
  )
}

export async function highlightShellCommand(source: string): Promise<ShellToken[]> {
  // Reuse the diff/Markdown singleton and theme, but do not initialize either for collapsed tools.
  const { getSharedHighlighter } = await import("@pierre/diffs")
  const { registerOpenCodeTheme } = await import("@opencode-ai/ui/context/marked-theme-register")
  registerOpenCodeTheme()
  const highlighter = await getSharedHighlighter({
    themes: ["OpenCode"],
    langs: ["shellscript"],
    preferredHighlighter: "shiki-wasm",
  })
  const lines = highlighter.codeToTokens(source, {
    lang: "shellscript",
    theme: "OpenCode",
    includeExplanation: true,
  }).tokens
  const tokens: ShellToken[] = []
  let offset = 0
  for (const line of lines) {
    for (const token of line) {
      // Shiki merges adjacent colors, not scopes. Explanations retain the grammar boundaries
      // needed for substitution delimiters, options, and unquoted positional arguments.
      for (const part of token.explanation ?? [{ content: token.content, scopes: [] }]) {
        const scopes = part.scopes.map((scope) => scope.scopeName)
        const inner = scopes.at(-1) ?? ""
        const color = /entity.name.command|support.function.builtin/.test(inner)
          ? "var(--syntax-primitive)"
          : /constant.other.option/.test(inner)
            ? "var(--syntax-constant)"
            : /punctuation.definition.variable|variable\./.test(inner)
              ? "var(--syntax-variable)"
              : /punctuation.(?:definition.subshell|separator.statement|terminator.statement)|keyword.operator/.test(
                    inner,
                  )
                ? "var(--syntax-operator)"
                : /string.unquoted.argument/.test(inner)
                  ? "var(--text-base)"
                  : /constant.character.escape/.test(inner)
                    ? "var(--syntax-regexp)"
                    : token.color
        if (!part.content) continue
        const previous = tokens.at(-1)
        if (previous && previous.color === color && !/\s/.test(previous.text + part.content))
          previous.text += part.content
        else tokens.push({ text: part.content, color })
        offset += part.content.length
      }
    }
    const newline = source.slice(offset).match(/^(?:\r\n|\r|\n)/)?.[0]
    if (newline) {
      tokens.push({ text: newline })
      offset += newline.length
    }
  }
  // The renderer catches failures and restores the original, unformatted command.
  if (tokens.map((token) => token.text).join("") !== source) throw new Error("Shell tokenization changed text")
  return tokens
}
