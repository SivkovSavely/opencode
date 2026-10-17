/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { EditorContextProvider, editorSelectionKey, useEditorContext } from "../../src/context/editor"
import { TestTuiContexts } from "../fixture/tui-environment"

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("editor selection did not update")
    await Bun.sleep(5)
  }
}

test("queue acknowledgement marks only the captured editor selection as sent", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        socket.subscribe("selection")
      },
      message() {},
    },
  })
  const ready = Promise.withResolvers<ReturnType<typeof useEditorContext>>()
  function Capture() {
    const editor = useEditorContext()
    onMount(() => ready.resolve(editor))
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts directory="/tmp/editor-selection">
      <EditorContextProvider
        integration={{ connection: () => ({ url: `ws://127.0.0.1:${server.port}`, source: "test" }) }}
      >
        <Capture />
      </EditorContextProvider>
    </TestTuiContexts>
  ))
  try {
    const editor = await ready.promise
    await waitFor(editor.connected)
    const send = (text: string) =>
      server.publish(
        "selection",
        JSON.stringify({
          method: "selection_changed",
          params: {
            filePath: "/tmp/editor-selection/a.ts",
            ranges: [{ text, selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
          },
        }),
      )
    send("selection A")
    await waitFor(() => editor.selection()?.ranges[0]?.text === "selection A")
    const captured = editorSelectionKey(editor.selection())
    send("selection B")
    await waitFor(() => editor.selection()?.ranges[0]?.text === "selection B")
    editor.markSelectionSent(captured)
    expect(editor.labelState()).toBe("pending")
    editor.markSelectionSent(editorSelectionKey(editor.selection()))
    expect(editor.labelState()).toBe("sent")
  } finally {
    app.renderer.destroy()
    await server.stop(true)
  }
})
