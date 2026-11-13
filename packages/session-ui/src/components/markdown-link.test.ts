import { describe, expect, test } from "bun:test"
import { localLinkPath, resolveLocalLink } from "./markdown-link"

describe("local Markdown paths", () => {
  test.each([
    ["AmlService/docs/watchlist-report-email-preview.html", "AmlService/docs/watchlist-report-email-preview.html"],
    ["/tmp/opencode/aml-email-desktop.png", "/tmp/opencode/aml-email-desktop.png"],
    ["/tmp/opencode/aml-email-mobile-candidates.png", "/tmp/opencode/aml-email-mobile-candidates.png"],
    ["./docs/report%20%23%3F%25.html", "./docs/report #?%.html"],
    ["docs/literal%2520space.html", "docs/literal%20space.html"],
    ["docs/r%C3%A9sum%C3%A9.html", "docs/résumé.html"],
    ["docs/report.html?download=1#preview", "docs/report.html"],
    ["file:///tmp/a%20b%2520%23%3F.html", "/tmp/a b%20#?.html"],
    ["file://localhost/tmp/report.html", "/tmp/report.html"],
    ["file:///localhost/report.html", "/localhost/report.html"],
    ["file:///C:/Users/Alice/report.html", "C:/Users/Alice/report.html"],
    ["C:\\Users\\Alice\\report.html", "C:\\Users\\Alice\\report.html"],
    ["C:%5CUsers%5CAlice%5Creport.html", "C:\\Users\\Alice\\report.html"],
  ])("decodes %s once", (href, expected) => {
    expect(localLinkPath(href)).toBe(expected)
  })

  test.each([
    "https://example.com/a",
    "http://localhost:4096/tmp/report.html",
    "mailto:a@example.com",
    "tel:123",
    "ftp://example.com/a",
    "custom:abc",
    "javascript:alert(1)",
    "data:text/html,hello",
    "//example.com/a",
    "#section",
    "?query=1",
    "",
    "   ",
  ])("does not classify %s as local", (href) => {
    expect(localLinkPath(href)).toBeUndefined()
  })

  test.each([
    "%",
    "docs/%ZZ.html",
    "docs/%C0%AF.html",
    "docs/%00.html",
    "docs/\u0001.html",
    "file://remote/tmp/a",
    "file://localhost:123/tmp/a",
    "file:relative.html",
    "file:///tmp/%",
    "file://",
    "\\\\server\\share\\a",
    "%2F%2Fexample.com/a",
    "/\\example.com/a",
  ])("leaves malformed or unsupported local target %s inert", (href) => {
    expect(localLinkPath(href)).toBe("")
  })

  test.each([
    ["AmlService/docs/preview.html", "/home/user/projects", "/home/user/projects/AmlService/docs/preview.html"],
    ["./docs/preview.html", "/home/user/projects/", "/home/user/projects/docs/preview.html"],
    ["../shared/report.html", "/home/user/projects", "/home/user/shared/report.html"],
    ["../../../../a", "/home/user/projects", "/a"],
    ["/tmp/./opencode/../report.png", "/another/session", "/tmp/report.png"],
    ["docs/%20.html", "/home/user/100% projects", "/home/user/100% projects/docs/%20.html"],
    ["C:\\tmp\\a\\..\\report.html", "/home/user/projects", "C:/tmp/report.html"],
    ["..\\shared\\report.html", "D:\\work\\project", "D:/work/shared/report.html"],
    ["./docs/../preview.html", "D:/work/project", "D:/work/project/preview.html"],
    ["/tmp/report.png", "D:/work/project", "/tmp/report.png"],
  ])("resolves %s against its owning directory %s", (path, directory, expected) => {
    expect(resolveLocalLink(path, directory)).toBe(expected)
  })

  test("never substitutes a browser or unrelated directory when the base is missing", () => {
    expect(resolveLocalLink("docs/a.html")).toBeUndefined()
    expect(resolveLocalLink("docs/a.html", "relative/project")).toBeUndefined()
    expect(resolveLocalLink("/tmp/a.html")).toBe("/tmp/a.html")
    expect(resolveLocalLink("docs/a.html", "/session/a")).toBe("/session/a/docs/a.html")
    expect(resolveLocalLink("docs/a.html", "/session/b")).toBe("/session/b/docs/a.html")
  })
})
