// Undefined keeps ordinary URLs unchanged; an empty path disables an invalid local target.
export function localLinkPath(href: string) {
  const value = href.trim()
  if (!value || /^[#?]/.test(value) || value.startsWith("//")) return
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^file:/i.test(value) && !/^[a-z]:(?:[/\\]|%5c|%2f)/i.test(value)) return

  try {
    const url = /^file:/i.test(value) ? new URL(value) : undefined
    if (url && (!/^file:\/\//i.test(value) || url.hostname || !/^file:\/\/[^/]*\//i.test(value))) return ""
    const path = decodeURIComponent(url ? url.pathname : value.split(/[?#]/, 1)[0]!)
    if (!path || /[\u0000-\u001f\u007f]/.test(path) || /^[\/\\]{2}/.test(path)) return ""
    return url ? path.replace(/^\/([a-z]:[/\\])/i, "$1") : path
  } catch {
    return ""
  }
}

export function resolveLocalLink(path: string, directory?: string) {
  const absolute = /^(?:\/|[a-z]:[/\\])/i.test(path)
  if (!absolute && (!directory || !/^(?:\/|[a-z]:[/\\])/i.test(directory))) return
  const windows = /^[a-z]:[/\\]/i.test(absolute ? path : directory!)
  const value = absolute ? path : `${directory}/${path}`
  const normalized = windows ? value.replaceAll("\\", "/") : value
  const prefix = windows ? normalized.slice(0, 3) : "/"
  const segments = normalized
    .slice(prefix.length)
    .split("/")
    .reduce<string[]>((result, segment) => {
      if (!segment || segment === ".") return result
      if (segment === "..") result.pop()
      else result.push(segment)
      return result
    }, [])
  return prefix + segments.join("/")
}
