export function formatRawToolString(value: string): { format: "json" | "xml"; value: string } | undefined {
  const trimmed = value.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const formatted = formatJSON(value)
    if (formatted !== undefined && formatted !== value) return { format: "json", value: formatted }
    return
  }
  if (!trimmed.startsWith("<")) return
  const formatted = formatXML(value)
  if (formatted !== undefined && formatted !== value) return { format: "xml", value: formatted }
}

function formatJSON(value: string) {
  if (value.length > 1_000_000) return
  try {
    JSON.parse(value)
  } catch {
    return
  }
  // Validation is separate from layout: parsing and reserializing loses duplicate keys and numeric tokens.
  const output: string[] = []
  const containers: boolean[] = []
  let length = 0
  let depth = 0
  let string = false
  let escaped = false
  const append = (text: string) => {
    if (length + text.length > 1_000_000) return false
    output.push(text)
    length += text.length
    return true
  }
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (string) {
      if (!append(character)) return
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') string = false
      continue
    }
    if (character === '"') {
      string = true
      if (!append(character)) return
      continue
    }
    if (/\s/.test(character)) continue
    if (character === "{" || character === "[") {
      let next = index + 1
      while (/\s/.test(value[next] ?? "")) next++
      const multiline = value[next] !== (character === "{" ? "}" : "]")
      containers.push(multiline)
      if (containers.length > 100) return
      if (multiline) depth++
      if (!append(character + (multiline ? `\n${"  ".repeat(depth)}` : ""))) return
      continue
    }
    if (character === "}" || character === "]") {
      if (containers.pop() && !append(`\n${"  ".repeat(--depth)}`)) return
      if (!append(character)) return
      continue
    }
    if (character === ",") {
      if (!append(`,\n${"  ".repeat(depth)}`)) return
      continue
    }
    if (!append(character === ":" ? ": " : character)) return
  }
  return output.join("")
}

function validationSource(source: string) {
  // Authored parsererror elements must not be mistaken for browser-generated diagnostics.
  return source.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)((?:[^:/\s<>]+:)?parsererror)(?=[\s/>])/g,
    (match, close: string | undefined, name: string | undefined) =>
      close === undefined || name === undefined
        ? match
        : `<${close}${name.replace(/parsererror$/, "opencode-parsererror")}`,
  )
}

function parseError(root: Element) {
  if (root.localName === "parsererror" && root.namespaceURI === "http://www.mozilla.org/newlayout/xml/parsererror.xml")
    return true
  // Chromium inserts its diagnostic before any authored children, including on a partially parsed root.
  const error = root.firstElementChild
  return error?.localName === "parsererror" && error.namespaceURI === "http://www.w3.org/1999/xhtml"
}

function safeXML(element: Element): boolean {
  if (element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space") === "preserve") return true
  const children = Array.from(element.childNodes)
  if (children.some((child) => child.nodeType === Node.ELEMENT_NODE)) {
    if (element.namespaceURI === "http://www.w3.org/1999/xhtml" && element.localName !== "parsererror") return false
    if (
      element.namespaceURI === "http://www.w3.org/2000/svg" &&
      ["text", "tspan", "textPath"].includes(element.localName)
    )
      return false
    if (children.some((child) => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE))
      return false
  }
  return Array.from(element.children).every(safeXML)
}

function formatXMLNode(node: Node, depth: number, serializer: XMLSerializer, doctype?: string): string {
  const indent = "  ".repeat(depth)
  if (node.nodeType === Node.DOCUMENT_TYPE_NODE) return indent + (doctype ?? serializer.serializeToString(node))
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) return ""
    return indent + serializer.serializeToString(node)
  }
  const element = node as Element
  if (
    element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space") === "preserve" ||
    !element.children.length
  ) {
    return indent + serializer.serializeToString(element)
  }
  const serialized = serializer.serializeToString(element.cloneNode(false))
  const opening = `${serialized.slice(0, serialized.indexOf(">")).replace(/\/$/, "")}>`
  return `${indent}${opening}\n${Array.from(element.childNodes)
    .map((child) => formatXMLNode(child, depth + 1, serializer))
    .filter(Boolean)
    .join("\n")}\n${indent}</${element.tagName}>`
}

function xmlDoctype(value: string) {
  let index = value.charCodeAt(0) === 0xfeff ? 1 : 0
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index++
    const ending = value.startsWith("<?", index) ? "?>" : value.startsWith("<!--", index) ? "-->" : undefined
    if (ending) {
      const end = value.indexOf(ending, index + 2)
      if (end < 0) return
      index = end + ending.length
      continue
    }
    if (!value.startsWith("<!DOCTYPE", index)) return
    const start = index
    let brackets = 0
    let quote = ""
    index += 9
    while (index < value.length) {
      const ending =
        !quote && value.startsWith("<!--", index) ? "-->" : !quote && value.startsWith("<?", index) ? "?>" : undefined
      if (ending) {
        const end = value.indexOf(ending, index + 2)
        if (end < 0) return
        index = end + ending.length
        continue
      }
      const character = value[index]
      if (quote) {
        if (character === quote) quote = ""
      } else if (character === "'" || character === '"') quote = character
      else if (character === "[") brackets++
      else if (character === "]") brackets--
      else if (character === ">" && brackets === 0) return value.slice(start, index + 1)
      index++
    }
    return
  }
}

function formatXML(value: string) {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined" || typeof Node === "undefined") return
  try {
    const validated = validationSource(value)
    const validation = new DOMParser().parseFromString(validated, "application/xml")
    if (!validation.documentElement || parseError(validation.documentElement)) return
    const document = validated === value ? validation : new DOMParser().parseFromString(value, "application/xml")
    if (!document.documentElement || !safeXML(document.documentElement)) return
    const serializer = new XMLSerializer()
    const declaration = value.match(/^\uFEFF?<\?xml\s[^?]*\?>/)?.[0]
    const formatted = Array.from(document.childNodes)
      .map((node) => formatXMLNode(node, 0, serializer, xmlDoctype(value)))
      .filter(Boolean)
      .join("\n")
    const output = declaration ? `${declaration}\n${formatted}` : formatted
    const result = new DOMParser().parseFromString(validationSource(output), "application/xml")
    if (!result.documentElement || parseError(result.documentElement)) return
    return output
  } catch {
    return
  }
}
