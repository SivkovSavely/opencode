import { describe, expect, test } from "bun:test"
import {
  copyEditorSelection,
  createTextFragment,
  editorPlainText,
  getCursorPosition,
  getNodeLength,
  getTextLength,
  setCursorPosition,
} from "./editor-dom"

describe("prompt-input editor dom", () => {
  test.each([false, true])("copy/cut preserves consecutive and terminal newlines (cut=%s)", (cut) => {
    const editor = document.createElement("div")
    editor.append(createTextFragment("one\n\ntwo\n"), document.createTextNode("\u200B"))
    document.body.append(editor)
    const range = document.createRange()
    range.selectNodeContents(editor)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const clipboardData = new DataTransfer()
    let prevented = false
    expect(
      copyEditorSelection(
        editor,
        {
          clipboardData,
          preventDefault: () => {
            prevented = true
          },
        },
        cut,
      ),
    ).toBe(true)
    expect(prevented).toBe(true)
    expect(clipboardData.getData("text/plain")).toBe("one\n\ntwo\n")
    expect(clipboardData.getData("application/x-opencode-prompt")).toContain("one<br><br>two<br>")
    expect(editorPlainText(editor)).toBe(cut ? "" : "one\n\ntwo\n")
    editor.remove()
  })

  test.each([false, true])("partial copy/cut serializes only the selected text and breaks (cut=%s)", (cut) => {
    const editor = document.createElement("div")
    editor.append(createTextFragment("one\n\ntwo\n"))
    document.body.append(editor)
    const range = document.createRange()
    range.setStart(editor.childNodes[0]!, 1)
    range.setEnd(editor.childNodes[3]!, 2)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const clipboardData = new DataTransfer()
    expect(copyEditorSelection(editor, { clipboardData, preventDefault: () => {} }, cut)).toBe(true)
    expect(clipboardData.getData("text/plain")).toBe("ne\n\ntw")
    expect(clipboardData.getData("application/x-opencode-prompt")).toBe("ne<br><br>tw")
    expect(editorPlainText(editor)).toBe(cut ? "oo\n" : "one\n\ntwo\n")
    editor.remove()
  })

  test("clipboard keeps structured chip attributes alongside newline-preserving plain text", () => {
    const editor = document.createElement("div")
    const chip = document.createElement("span")
    chip.dataset.type = "model"
    chip.dataset.providerId = "p"
    chip.dataset.modelId = "canonical"
    chip.textContent = "@model:Friendly Name"
    editor.append(createTextFragment("one\n\n"), chip, createTextFragment("\ntwo\n"))
    document.body.append(editor)
    const range = document.createRange()
    range.selectNodeContents(editor)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const clipboardData = new DataTransfer()
    expect(copyEditorSelection(editor, { clipboardData, preventDefault: () => {} })).toBe(true)
    expect(clipboardData.getData("text/plain")).toBe("one\n\n@model:Friendly Name\ntwo\n")
    const template = document.createElement("template")
    template.innerHTML = clipboardData.getData("application/x-opencode-prompt")
    expect(template.content.querySelector("[data-type=model]")?.getAttribute("data-model-id")).toBe("canonical")
    expect(editorPlainText(template.content)).toBe(clipboardData.getData("text/plain"))
    editor.remove()
  })
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })
})
