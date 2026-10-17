/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { usePromptMove } from "../../src/component/prompt/move"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { HomeSessionDestinationProvider, useHomeSessionDestination } from "../../src/routes/home/session-destination"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

test("failed queue admission clears move progress without changing the retry destination", async () => {
  const calls = createFetch((url) => {
    if (url.pathname.endsWith("/generate-name")) return json({ name: "queued-copy" })
    if (url.pathname.endsWith("/copy")) return json({ directory: "/tmp/opencode/queued-copy" })
  })
  const events = createEventSource()
  const ready = Promise.withResolvers<{
    move: ReturnType<typeof usePromptMove>
    destination: NonNullable<ReturnType<typeof useHomeSessionDestination>>
  }>()
  function Probe() {
    const move = usePromptMove({ projectID: () => "proj_test", sessionID: () => undefined })
    const destination = useHomeSessionDestination()
    if (!destination) throw new Error("Missing Home destination provider")
    onMount(() => ready.resolve({ move, destination }))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <ArgsProvider>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <ToastProvider>
                              <DialogProvider>
                                <HomeSessionDestinationProvider>
                                  <Probe />
                                </HomeSessionDestinationProvider>
                              </DialogProvider>
                            </ToastProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </ThemeProvider>
              </KVProvider>
            </ArgsProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />)
  try {
    const ctx = await ready.promise
    ctx.destination.setDestination({ type: "new" })
    expect(await ctx.move.getDirectory("/queue hello")).toBe("/tmp/opencode/queued-copy")
    ctx.move.startSubmit()
    expect(ctx.move.progress()).toBe("Submitting prompt")
    ctx.move.finishSubmit({ preserveDestination: true })
    expect(ctx.move.creating()).toBe(false)
    expect(ctx.move.progress()).toBeUndefined()
    expect(ctx.move.destination()).toEqual({ type: "new" })
    ctx.move.finishSubmit()
    expect(ctx.move.destination()).toEqual({ type: "directory", directory, subdirectory: false })
  } finally {
    app.renderer.destroy()
  }
})
