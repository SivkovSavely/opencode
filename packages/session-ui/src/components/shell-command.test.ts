import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatShellCommand, highlightShellCommand } from "./shell-command"

const reflectiveInvocations = [
  String.raw`a\lias`,
  "'alias'",
  '"alias"',
  "al''ias",
  String.raw`VALUE=value a\lias`,
  "VALUE+=value 'alias'",
  String.raw`builtin a\lias`,
  'command -- "alias"',
  "builtin command al''ias",
  String.raw`! a\lias`,
  String.raw`> artifact a\lias`,
]

const redirectedAssignments = [
  "VALUE=value>/dev/null",
  "VALUE=value>>/dev/null",
  "VALUE=value</dev/null",
  "VALUE=value<>/dev/null",
  "VALUE=value>|/dev/null",
  "VALUE=value> /dev/null",
  "VALUE=value>> /dev/null",
  "VALUE=value< /dev/null",
  "VALUE=value >/dev/null",
  "VALUE=value >>/dev/null",
  "VALUE=value </dev/null",
  "VALUE=value 2>/dev/null",
  "VALUE=value 2> /dev/null",
  "VALUE=value 2>>/dev/null",
  "VALUE=value 0</dev/null",
  "VALUE=value 3<>/dev/null",
  "VALUE=value 2>&1",
  "VALUE=value&>/dev/null",
  "VALUE+=value>/dev/null",
  "FIRST=one SECOND=two>/dev/null",
  'VALUE="two words">/dev/null',
  "VALUE='two words'>/dev/null",
]

describe("shell command formatting", () => {
  test.each([
    ["echo hello", "echo hello"],
    ["echo one; echo two", "echo one;\necho two"],
    [
      'git status --short && git diff --stat; echo "Finished"',
      'git status --short \\\n  && git diff --stat;\necho "Finished"',
    ],
    ["false || echo fallback && printf x | wc -c", "false \\\n  || echo fallback \\\n  && printf x | wc -c"],
    ['echo "a; b && c || d"; echo next', 'echo "a; b && c || d";\necho next'],
    ["echo 'literal $(pwd); &&'; echo next", "echo 'literal $(pwd); &&';\necho next"],
    [String.raw`echo a\;b \&\& c; echo next`, "echo a\\;b \\&\\& c;\necho next"],
    [String.raw`printf '%s' "alias" 'set' a\lias; echo next`, "printf '%s' \"alias\" 'set' a\\lias;\necho next"],
    ["VALUE='a>b'; echo next", "VALUE='a>b';\necho next"],
    [String.raw`VALUE=a\>b; echo next`, "VALUE=a\\>b;\necho next"],
    [
      "printf first > artifact; cat < artifact; printf second >> artifact",
      "printf first > artifact;\ncat < artifact;\nprintf second >> artifact",
    ],
    ["", ""],
    [" \t ", " \t "],
  ])("formats only safe boundaries in %s", (source, display) => {
    expect(formatShellCommand(source, "/bin/bash")).toBe(display)
    expect(formatShellCommand(source, "/bin/sh")).toBe(display)
  })

  test.each([
    'echo "Files: $(find "$(pwd)" -type f | wc -l)"; echo next',
    'echo "${USER:-unknown}"; echo "$HOME"',
    "echo `printf 'a;b'`; echo next",
    "echo $((1 + 2)); echo next",
    "cat <(printf hi); echo next",
    "cat <<< 'a;b'; echo next",
    "echo hi # ; echo not-a-command",
    "cat <<EOF\na;b && c\nEOF\necho done",
    "cat <<'EOF'\n$(pwd); literal\nEOF\necho done",
    "case x in x) echo x;; y) echo y;& z) echo z;;& esac; echo next",
    "if true; then echo yes; else echo no; fi; echo next",
    "for x in a b; do echo $x; done; echo next",
    "while false; do echo x; done; echo next",
    "f() { echo hi; }; f",
    "echo one;\n  echo two",
    "printf '%s' 'one\ntwo'; echo next",
    'echo "unterminated; echo next',
    "echo trailing\\",
    "echo one;; echo two",
    "echo one; & echo two",
    "echo one &&",
    "echo one & echo two",
    "echo one\r; echo two",
    "set -v; printf first; printf second",
    "command set -o verbose; printf first; printf second",
    "printf before; command set",
    "declare -p; printf after",
    'printf "%s" "$BASH_EXECUTION_STRING"; printf after',
  ])("leaves ambiguous or already formatted syntax unchanged: %s", (source) => {
    expect(formatShellCommand(source, "bash")).toBe(source)
  })

  test.each(reflectiveInvocations)("does not reformat reflective invocation %s", (invocation) => {
    const source = `${invocation} opencode_shell_review_alias="printf HELLO"; opencode_shell_review_alias`
    expect(formatShellCommand(source, "bash")).toBe(source)
  })

  test.each([
    String.raw`VALUE=value s\et -v; printf first; printf second`,
    '"set" -v; printf first; printf second',
    "builtin 'set' -v; printf first; printf second",
    String.raw`command -- s\et -v; printf first; printf second`,
    String.raw`VALUE+=value s\et -v; printf first; printf second`,
    'BUILTIN=set; "$BUILTIN" -v; printf first; printf second',
  ])("preserves quoted, escaped, prefixed, and dynamic parser-changing invocations: %s", (source) => {
    expect(formatShellCommand(source, "bash")).toBe(source)
  })

  test.each(redirectedAssignments)("preserves all pre-command redirections after %s", (prefix) => {
    const source = String.raw`${prefix} sh\opt -s expand_aliases; ${prefix} a\lias hi="printf HELLO"; hi`
    expect(formatShellCommand(source, "bash")).toBe(source)
  })

  test.each([
    undefined,
    "",
    "pwsh",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "fish",
    "unknown",
  ])("does not assume a POSIX interpreter for %s", (shell) => {
    const source = 'echo "hello"; echo world && echo done'
    expect(formatShellCommand(source, shell)).toBe(source)
  })

  test("formats long chains without changing the original source", () => {
    const source = Array.from({ length: 500 }, () => "printf x").join("; ")
    const input = { command: source }
    const display = formatShellCommand(input.command, "bash")
    expect(display.split("\n")).toHaveLength(500)
    expect(input.command).toBe(source)
    expect(formatShellCommand(display, "bash")).toBe(display)
  })

  test.each([
    ...[
      "printf '%s\\n' one; printf '%s\\n' two",
      "false && printf bad || printf good; printf done",
      "printf '%s\\n' alpha beta | wc -l && printf yes",
      "printf '%s\\n' 'a; b && c' > artifact; cat artifact; printf err >&2; false",
      "VALUE=hello; printf '%s' \"$VALUE\" && printf '%s' 'literal $(pwd)'",
      String.raw`printf '%s' a\;b; printf '%s' \$HOME`,
      "printf '%s' a\\\t&& printf x",
      "printf first > artifact; cat < artifact; printf second >> artifact",
    ].map((source) => [source, true] as const),
    ...[
      String.raw`shopt -s expand_aliases; a\lias hi="printf HELLO"; hi`,
      ...reflectiveInvocations.map(
        (invocation) =>
          `shopt -s expand_aliases; ${invocation} opencode_shell_review_alias="printf HELLO"; opencode_shell_review_alias`,
      ),
      String.raw`VALUE=value s\et -v; printf first; printf second`,
      '"set" -v; printf first; printf second',
      "builtin 'set' -v; printf first; printf second",
      String.raw`command -- s\et -v; printf first; printf second`,
      String.raw`VALUE+=value s\et -v; printf first; printf second`,
      ...redirectedAssignments.map(
        (prefix) => String.raw`${prefix} sh\opt -s expand_aliases; ${prefix} a\lias hi="printf HELLO"; hi`,
      ),
    ].map((source) => [source, false] as const),
  ])("preserves syntax, output, exit status, and isolated side effects: %s", async (source, formatted) => {
    const display = formatShellCommand(source, "bash")
    const syntax = Bun.spawn(["bash", "--noprofile", "--norc", "-n", "-c", display], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    })
    expect(await new Response(syntax.stderr).text()).toBe("")
    expect(await syntax.exited).toBe(0)
    const dir = await mkdtemp(join(tmpdir(), "opencode-shell-format-"))
    try {
      const results = []
      for (const command of [source, display]) {
        const child = Bun.spawn(["bash", "--noprofile", "--norc", "-c", command], {
          cwd: dir,
          env: { PATH: "/usr/bin:/bin", HOME: dir, LC_ALL: "C" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 2000,
        })
        results.push({
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
          exit: await child.exited,
          files: await Promise.all(
            (await readdir(dir)).map(async (name) => [name, await readFile(join(dir, name), "utf8")]),
          ),
        })
        await Promise.all((await readdir(dir)).map((name) => rm(join(dir, name))))
      }
      expect(results[1]).toEqual(results[0])
      expect(display !== source).toBe(formatted)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("shell command highlighting", () => {
  test("distinguishes commands, options, positional arguments, strings, variables, and operators", async () => {
    const source = 'NAME=value git --verbose -a --output=file positional && echo "$HOME"'
    const tokens = await highlightShellCommand(source)
    const color = (text: string) => tokens.find((token) => token.text === text)?.color
    expect(tokens.map((token) => token.text).join("")).toBe(source)
    expect(color("git")).toBe("var(--syntax-primitive)")
    expect(color("--verbose")).toBe("var(--syntax-constant)")
    expect(color("-a")).toBe("var(--syntax-constant)")
    expect(color("positional")).toBe("var(--text-base)")
    expect(color("NAME")).toBe("var(--syntax-variable)")
    expect(color("&&")).toBe("var(--syntax-operator)")
    expect(color("$HOME")).toBe("var(--syntax-variable)")
  })

  test("recognizes nested command substitutions within double quotes", async () => {
    const source = 'echo "Files: $(find "$(pwd)" -type f | wc -l)"'
    const tokens = await highlightShellCommand(source)
    expect(tokens.map((token) => token.text).join("")).toBe(source)
    expect(
      tokens.filter((token) => ["echo", "find", "pwd", "wc"].includes(token.text)).map((token) => token.color),
    ).toEqual(Array(4).fill("var(--syntax-primitive)"))
    expect(tokens.filter((token) => token.text === "$(")).toHaveLength(2)
    expect(tokens.find((token) => token.text === "Files: ")?.color).toBe("var(--syntax-string)")
    expect(tokens.find((token) => token.text === "-type")?.color).toBe("var(--syntax-constant)")
  })

  test.each([
    'echo "$HOME"',
    'echo "${USER:-unknown}"',
    'echo "$(pwd)"',
    'echo "Branch: $(git branch --show-current)"',
    'echo "Files: $(find "$(pwd)" -type f | wc -l)"',
    String.raw`echo "Literal: \$HOME"`,
    "echo 'Literal: $(pwd)'",
    "echo `pwd` <(printf hi) $((1 + 2))",
    "if true; then echo yes; else echo no; fi # comment",
    "cat <<'EOF'\n$HOME $(pwd)\nEOF\n",
    'echo "<img src=x onerror=alert(1)>"\r\nprintf end\n',
  ])("reconstructs the exact text for %s", async (source) => {
    const tokens = await highlightShellCommand(source)
    expect(tokens.map((token) => token.text).join("")).toBe(source)
  })

  test("keeps single quotes and escaped dollar signs literal", async () => {
    const tokens = await highlightShellCommand(String.raw`echo 'Literal: $(pwd)' "Literal: \$HOME"`)
    expect(tokens.filter((token) => token.color === "var(--syntax-variable)")).toEqual([])
    expect(tokens.filter((token) => token.text === "pwd")).toEqual([])
    expect(tokens.find((token) => token.text.includes("Literal: $(pwd)"))?.color).toBe("var(--syntax-string)")
  })

  test("recognizes shell reserved words and comments", async () => {
    const tokens = await highlightShellCommand("if true; then echo yes; fi # comment")
    expect(tokens.filter((token) => ["if", "then", "fi"].includes(token.text)).map((token) => token.color)).toEqual(
      Array(3).fill("var(--syntax-keyword)"),
    )
    expect(tokens.find((token) => token.text.includes("comment"))?.color).toBe("var(--syntax-comment)")
  })

  test("rejects lossy tokenization so the renderer can restore the original command", async () => {
    await highlightShellCommand("echo ready")
    const { getSharedHighlighter } = await import("@pierre/diffs")
    const highlighter = await getSharedHighlighter({
      themes: ["OpenCode"],
      langs: ["shellscript"],
      preferredHighlighter: "shiki-wasm",
    })
    const spy = spyOn(highlighter, "codeToTokens").mockReturnValue({
      ...highlighter.codeToTokens("echo ready", { lang: "shellscript", theme: "OpenCode" }),
      tokens: [],
    })
    try {
      await expect(highlightShellCommand("echo one;\necho two")).rejects.toThrow("Shell tokenization changed text")
    } finally {
      spy.mockRestore()
    }
  })
})
