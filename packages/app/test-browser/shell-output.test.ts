import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createComponent, render } from "solid-js/web"
import type { ToolProps } from "../../session-ui/src/components/message-part"
import { highlightShellCommand } from "../../session-ui/src/components/shell-command"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = require("@babel/core")
plugin({
  name: "shell-output-solid-dom",
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, ({ path }) => ({ path, namespace: "shell-test-worker-url" }))
    build.onLoad({ filter: /.*/, namespace: "shell-test-worker-url" }, () => ({
      contents: 'export default "test-worker.js"',
      loader: "js",
    }))
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: (
        await babel.transformAsync(await Bun.file(path).text(), {
          filename: path,
          presets: [[require.resolve("babel-preset-solid"), { generate: "dom" }]],
          parserOpts: { plugins: ["typescript", "jsx"] },
        })
      ).code,
      loader: "tsx",
    }))
  },
})

const { ShellOutput } = await import("../../session-ui/src/components/shell-output")
const { getTool } = await import("../../session-ui/src/components/message-part")
const { DataProvider } = await import("../../session-ui/src/context/data")
const commandModule = await import("../../session-ui/src/components/shell-command")
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

function registered(props: ToolProps, config?: () => { shell?: string } | undefined) {
  return createComponent(DataProvider, {
    data: {
      session: [],
      session_status: {},
      session_diff: {},
      message: {},
      part: {},
      get config() {
        return config?.()
      },
    },
    directory: "/repo",
    get children() {
      return createComponent(getTool(props.tool)!, props)
    },
  })
}

function setup(command = "echo hello; echo world", output = "hello\nworld\n", copied: string[] = []) {
  const [source, setSource] = createSignal(command)
  const [stdout, setStdout] = createSignal(output)
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(ShellOutput, {
        get command() {
          return source()
        },
        get output() {
          return stdout()
        },
        shell: "/bin/bash",
        async onCopy(text) {
          copied.push(text)
          return true
        },
      }),
    host,
  )
  cleanup.push(() => {
    dispose()
    host.remove()
  })
  return { host, setSource, setStdout, copied, dispose }
}

async function highlighted(host: HTMLElement) {
  if (host.querySelector('[data-slot="bash-command"] code span')) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      observer.disconnect()
      reject(new Error("Command was not highlighted"))
    }, 2000)
    const observer = new MutationObserver(() => {
      if (!host.querySelector('[data-slot="bash-command"] code span')) return
      clearTimeout(timer)
      observer.disconnect()
      resolve()
    })
    observer.observe(host, { childList: true, subtree: true })
  })
}

describe("shell output renderer", () => {
  test.each(["bash", "shell"])(
    "the registered %s renderer is lazy, normalizes output, and survives completion and collapse",
    async (tool) => {
      const spy = spyOn(commandModule, "highlightShellCommand")
      const formatting = spyOn(commandModule, "formatShellCommand")
      cleanup.push(() => spy.mockRestore())
      cleanup.push(() => formatting.mockRestore())
      const [open, setOpen] = createSignal(false)
      const [status, setStatus] = createSignal("running")
      const [output, setOutput] = createSignal("\u001b[31mfirst\u001b[0m\r\n")
      const [metadata, setMetadata] = createSignal({ shell: "/bin/bash", output: "" })
      const host = document.createElement("div")
      document.body.append(host)
      cleanup.push(() => host.remove())
      cleanup.push(
        render(
          () =>
            registered(
              {
                tool,
                input: { command: "echo first; echo second" },
                get metadata() {
                  return metadata()
                },
                get output() {
                  return output()
                },
                get status() {
                  return status()
                },
                get open() {
                  return open()
                },
                onOpenChange: setOpen,
              },
              () => ({ shell: "bash" }),
            ),
          host,
        ),
      )
      expect(host.querySelector('[data-component="bash-output"]')).toBeNull()
      expect(spy).not.toHaveBeenCalled()
      setOpen(true)
      await highlighted(host)
      expect(host.querySelector('[data-slot="bash-command"] code')?.textContent).toBe("echo first; \\\necho second")
      expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("first\n")
      setOutput("\u001b[32mdone\u001b[0m\r\n\rfinal")
      setMetadata({ shell: "/bin/bash", output: "done\n\nfinal" })
      setStatus("completed")
      expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("done\n\nfinal")
      expect(spy).toHaveBeenCalledTimes(1)
      expect(formatting).toHaveBeenCalledTimes(1)
      setOpen(false)
      expect(host.querySelector('[data-component="bash-output"]')).toBeNull()
      setOpen(true)
      await highlighted(host)
      expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("done\n\nfinal")
      expect(spy).toHaveBeenCalledTimes(2)
    },
  )

  test.each(["bash", "shell"])(
    "historical %s calls require recorded interpreter metadata, independent of later server/directory config",
    async (tool) => {
      const [target, setTarget] = createStore({ server: "one", directory: "/repo" })
      const [configs, setConfigs] = createStore<Record<string, Record<string, { shell?: string }>>>({
        one: { "/repo": { shell: "/bin/bash" }, "/worktree": { shell: "pwsh" } },
        two: { "/repo": { shell: "powershell.exe" }, "/worktree": { shell: "/bin/sh" } },
      })
      const [metadata, setMetadata] = createStore<{ shell?: unknown }>({})
      const input = { command: "echo first; echo second" }
      const host = document.createElement("div")
      cleanup.push(
        render(
          () =>
            registered(
              {
                tool,
                input,
                metadata,
                output: "plain output",
                status: "completed",
                open: true,
              },
              () => configs[target.server]?.[target.directory],
            ),
          host,
        ),
      )
      await highlighted(host)
      const text = () => host.querySelector('[data-slot="bash-command"] code')?.textContent
      expect(text()).toBe(input.command)
      setTarget("server", "two")
      expect(text()).toBe(input.command)
      setTarget("directory", "/worktree")
      expect(text()).toBe(input.command)
      setTarget("server", "one")
      expect(text()).toBe(input.command)
      setConfigs("one", "/worktree", "shell", "/bin/bash")
      expect(text()).toBe(input.command)
      setConfigs("one", "/worktree", "shell", undefined)
      expect(text()).toBe(input.command)
      setMetadata("shell", "/bin/bash")
      expect(text()).toBe("echo first; \\\necho second")
      setConfigs("one", "/worktree", "shell", "pwsh")
      expect(text()).toBe("echo first; \\\necho second")
      setMetadata("shell", "pwsh")
      setConfigs("one", "/worktree", "shell", "/bin/bash")
      expect(text()).toBe(input.command)
      setMetadata("shell", { invalid: true })
      expect(text()).toBe(input.command)
      setMetadata("shell", "")
      expect(text()).toBe(input.command)
      expect(input.command).toBe("echo first; echo second")
      expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("plain output")
    },
  )

  test("separates highlighted command and plain output without decorative text", async () => {
    const source = 'printf "%s" "<img src=x onerror=alert(1)>"; echo "$HOME"'
    const output = "<script>alert(1)</script>\n  echo --flag\n\n"
    const { host } = setup(source, output)
    await highlighted(host)
    expect(host.querySelector('[data-slot="bash-command"] code')?.textContent).toBe(source.replace("; ", "; \\\n"))
    expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe(output)
    expect(host.querySelectorAll('[data-slot="bash-result"] code span')).toHaveLength(0)
    expect(host.querySelectorAll("img, script")).toHaveLength(0)
    expect(host.querySelector('[data-slot="bash-command"] pre')?.getAttribute("dir")).toBe("ltr")
    expect(host.querySelector('[data-slot="bash-scroll"]')?.getAttribute("tabindex")).toBe("0")
    expect(host.textContent).not.toContain("$ printf")
  })

  test.each([
    String.raw`shopt -s expand_aliases; a\lias hi="printf HELLO"; hi`,
    String.raw`VALUE=value>/dev/null sh\opt -s expand_aliases; VALUE=value>/dev/null a\lias hi="printf HELLO"; hi`,
  ])(
    "reflective invocations retain their exact source while remaining highlighted and independently copyable: %s",
    async (source) => {
      const { host, copied } = setup(source, "plain output")
      await highlighted(host)
      expect(host.querySelector('[data-slot="bash-command"] code')?.textContent).toBe(source)
      expect(host.querySelectorAll('[data-slot="bash-command"] code span').length).toBeGreaterThan(0)
      host.querySelector<HTMLButtonElement>('[data-slot="bash-command"] button')!.click()
      await Promise.resolve()
      expect(copied).toEqual([source])
      expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("plain output")
    },
  )

  test("unrecognized interpreter metadata preserves the source without breaking the registered renderer", async () => {
    const host = document.createElement("div")
    cleanup.push(
      render(
        () =>
          registered({
            tool: "shell",
            input: { command: "echo first; echo second" },
            metadata: { shell: { executable: "bash" } },
            status: "completed",
            open: true,
          }),
        host,
      ),
    )
    await highlighted(host)
    expect(host.querySelector('[data-slot="bash-command"] code')?.textContent).toBe("echo first; echo second")
  })

  test.each([
    ["echo hi", "", 1, 0],
    ["", "only output\n", 0, 1],
    ["", "", 0, 0],
  ])("handles command-only, output-only, and empty content", async (command, output, commands, outputs) => {
    const { host } = setup(command, output)
    expect(host.querySelectorAll('[data-slot="bash-command"]')).toHaveLength(commands)
    expect(host.querySelectorAll('[data-slot="bash-result"]')).toHaveLength(outputs)
    if (commands) await highlighted(host)
    if (!commands && outputs) expect(host.querySelector('[data-slot="bash-result"]')?.previousElementSibling).toBeNull()
  })

  test("independent keyboard-accessible copy controls preserve the original source and output", async () => {
    const source = "  printf '%s' a\\;b;  echo \"$(pwd)\"\n"
    const output = "\tresult\n\n"
    const { host, copied } = setup(source, output)
    const command = host.querySelector<HTMLButtonElement>('[data-slot="bash-command"] button')!
    const result = host.querySelector<HTMLButtonElement>('[data-slot="bash-result"] button')!
    expect(command.getAttribute("aria-label")).toBe("Copy")
    expect(result.getAttribute("aria-label")).toBe("Copy response")
    command.focus()
    expect(document.activeElement).toBe(command)
    command.click()
    await Promise.resolve()
    expect(copied).toHaveLength(1)
    result.click()
    await Promise.resolve()
    expect(copied).toHaveLength(2)
    expect(copied).toEqual([source, output])
    expect(command.getAttribute("aria-label")).toBe("Copied")
  })

  test("streaming output leaves the command DOM and tokens untouched", async () => {
    const spy = spyOn(commandModule, "highlightShellCommand")
    cleanup.push(() => spy.mockRestore())
    const { host, setStdout } = setup('echo "$HOME"; echo done', "first")
    await highlighted(host)
    const code = host.querySelector('[data-slot="bash-command"] code')!
    const spans = Array.from(code.childNodes)
    for (let index = 0; index < 30; index++) setStdout(`first\n${index}`)
    expect(host.querySelector('[data-slot="bash-command"] code')).toBe(code)
    expect(Array.from(code.childNodes)).toEqual(spans)
    expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("first\n29")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  test("late asynchronous highlighting cannot replace a newer command or a remount", async () => {
    const first = await highlightShellCommand("echo first")
    const second = await highlightShellCommand("echo second")
    const pending: ((tokens: typeof first) => void)[] = []
    const spy = spyOn(commandModule, "highlightShellCommand").mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    )
    cleanup.push(() => spy.mockRestore())
    const old = setup("echo first", "")
    old.setSource("echo second")
    expect(pending).toHaveLength(2)
    pending[1]!(second)
    await highlighted(old.host)
    pending[0]!(first)
    await Promise.resolve()
    expect(old.host.querySelector("code")?.textContent).toBe("echo second")
    old.setSource("echo first")
    old.dispose()
    const next = setup("echo second", "")
    expect(pending).toHaveLength(4)
    pending[3]!(second)
    await highlighted(next.host)
    pending[2]!(first)
    await Promise.resolve()
    expect(next.host.querySelector("code")?.textContent).toBe("echo second")
  })

  test("highlighter and clipboard failures keep the original command and the card usable", async () => {
    const spy = spyOn(commandModule, "highlightShellCommand").mockRejectedValue(new Error("unavailable"))
    cleanup.push(() => spy.mockRestore())
    const host = document.createElement("div")
    cleanup.push(
      render(
        () =>
          createComponent(ShellOutput, {
            command: "echo one; echo two",
            output: "still visible",
            shell: "bash",
            onCopy: () => Promise.reject(new Error("clipboard denied")),
          }),
        host,
      ),
    )
    await Promise.resolve()
    expect(host.querySelector('[data-slot="bash-command"] code')?.textContent).toBe("echo one; echo two")
    const button = host.querySelector<HTMLButtonElement>("button")!
    button.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(button.getAttribute("aria-label")).toBe("Copy")
    expect(host.querySelector('[data-slot="bash-result"] code')?.textContent).toBe("still visible")
  })
})
