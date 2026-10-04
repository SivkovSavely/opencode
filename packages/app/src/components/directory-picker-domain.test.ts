import { expect, test } from "bun:test"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerTreeEntries,
  pickerSearchEntries,
  pickerFileSearchQuery,
  pickerMode,
  preloadTreeDirectories,
  selectedTreePath,
  treeEntries,
  treePathWithin,
  currentPickerSuggestions,
  createDirectorySearch,
  createPriorityTaskQueue,
  displayPickerPath,
  pickerParent,
  pickerRoot,
  pickerAbsoluteInput,
  projectSearchRoots,
  MAX_PROJECT_SEARCH_ROOTS,
} from "./directory-picker-domain"

const SIBLING_TREE: Record<string, string[]> = {
  "/home/luke": ["Projects/", "ExternalProjects/", "notes/"],
  "/home/luke/Projects": ["opencode/", "foo/", "Android/"],
  "/home/luke/ExternalProjects": ["opencode-queue/", "space-bunny/"],
  "/home/luke/ExternalProjects/space-bunny": ["src/", "assets/"],
  "/home/luke/ExternalProjects/space-bunny/src": ["index.ts"],
  "/home/luke/ExternalProjects/opencode-queue": ["src/", "docs/"],
  "/home/luke/ExternalProjects/opencode-queue/src": ["main.ts"],
  "/home/luke/Projects/Android": ["app/"],
  "C:/Users/luke": ["repos/"],
  "C:/Users/luke/repos": ["opencode/", "space-bunny/"],
  "//Server/Share": ["opencode/", "space-bunny/"],
}

function treeSdk(calls: string[] = []) {
  const entries = (directory: string) => SIBLING_TREE[directory] ?? []
  return {
    api: {
      file: {
        list: (input: { location?: { directory?: string } }) => {
          const directory = input.location?.directory ?? ""
          calls.push(`list:${directory}`)
          return Promise.resolve({
            data: entries(directory).map((path) => ({ path, type: "directory" as const })),
          })
        },
        find: (input: { location?: { directory?: string }; query: string }) => {
          const directory = input.location?.directory ?? ""
          calls.push(`find:${directory}`)
          const query = input.query.toLowerCase()
          return Promise.resolve({
            data: entries(directory)
              .filter((name) => name.toLowerCase().includes(query))
              .map((path) => ({ path })),
          })
        },
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
}

const SIBLING_PROJECTS = [
  "/home/luke/Projects/opencode",
  "/home/luke/Projects/foo",
  "/home/luke/ExternalProjects/opencode-queue",
]

test("maps server directory entries into Pierre paths", () => {
  expect(
    treeEntries("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
    ]),
  ).toEqual(["src/components/", "src/index.ts"])
})

test("maps Pierre paths back to the selected server root", () => {
  expect(absoluteTreePath("C:/Users/luke", "src/components/")).toBe("C:/Users/luke/src/components")
  expect(absoluteTreePath("C:/", "")).toBe("C:/")
  expect(absoluteTreePath("C:/", "README.md")).toBe("C:/README.md")
  expect(absoluteTreePath("/home/luke", "README.md")).toBe("/home/luke/README.md")
})

test("includes files only when the picker selects files", () => {
  const nodes = [
    { name: "components", type: "directory" as const },
    { name: "index.ts", type: "file" as const },
  ]
  expect(pickerTreeEntries("", nodes, "directory")).toEqual(["components/"])
  expect(pickerTreeEntries("", nodes, "file")).toEqual(["components/", "index.ts"])
})

test("includes files in file autocomplete while preserving directory navigation", () => {
  const nodes = [
    { name: "src", absolute: "/repo/src", type: "directory" as const },
    { name: "README.md", absolute: "/repo/README.md", type: "file" as const },
  ]
  expect(pickerSearchEntries(nodes, "directory")).toEqual([nodes[0]])
  expect(pickerSearchEntries(nodes, "file")).toEqual(nodes)
})

test("centralizes file and directory selection policy", () => {
  const file = pickerMode("file", "/repo")
  expect(file.includeFiles).toBeTrue()
  expect(file.selection("/repo/src", "index.ts")).toBe("src/index.ts")
  expect(file.selection("/repo", "src/")).toBeUndefined()
  expect(file.result("/repo", "src/index.ts")).toBe("src/index.ts")
  expect(file.selection("/tmp", "example.txt")).toBeUndefined()
  expect(file.navigation("/repo/src")).toBe("/repo/src")
  expect(file.navigation("/tmp")).toBeUndefined()

  const directory = pickerMode("directory")
  expect(directory.includeFiles).toBeFalse()
  expect(directory.selection("/repo", "src/")).toBe("/repo/src")
  expect(directory.selection("C:/Users/luke", "repos/")).toBe("C:\\Users\\luke\\repos")
  expect(directory.selection("//Server/Share", "repo/")).toBe("\\\\Server\\Share\\repo")
  expect(directory.navigation("/tmp")).toBe("/tmp")
  expect(directory.result("/repo", "")).toBe("/repo")
  expect(directory.result("C:/Users/luke", "")).toBe("C:\\Users\\luke")
  expect(directory.result("//Server/Share/repo", "")).toBe("\\\\Server\\Share\\repo")
  expect(directory.result("/repo", "", false)).toBeUndefined()
})

test("accepts mutations only from the active navigation", () => {
  expect(activeTreeNavigation(3, 3)).toBeTrue()
  expect(activeTreeNavigation(2, 3)).toBeFalse()
})

test("preserves POSIX case while matching Windows drives case-insensitively", () => {
  expect(treePathWithin("/repo", "/Repo")).toBeFalse()
  expect(treePathWithin("C:/Repo", "c:/repo/src")).toBeTrue()
  expect(treePathWithin("//Server/Share/Repo", "//server/share/repo/src")).toBeTrue()
  expect(pickerMode("file", "//Server/Share/Repo").selection("//server/share/repo/src", "file.ts")).toBe("src/file.ts")
  expect(treePathWithin("/repo", "/repo/../tmp")).toBeFalse()
  expect(treePathWithin("/", "/src")).toBeTrue()
  expect(pickerMode("file", "C:/Repo").selection("c:/repo/src", "file.ts")).toBe("src/file.ts")
  expect(pickerMode("file", "C:/").selection("C:/", "file.ts")).toBe("file.ts")
})

test("displays paths using the selected server path format", () => {
  expect(displayPickerPath("C:/Users/luke/repos", "C:/Users/luke/repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("C:/Users/luke/repos", "C:\\Users\\luke\\repos", "C:/Users/luke")).toBe(
    "C:\\Users\\luke\\repos",
  )
  expect(displayPickerPath("/home/luke/repos", "repos", "/home/luke")).toBe("~/repos")
  expect(displayPickerPath("/home/luke/repos", "~/repos", "/home/luke")).toBe("~/repos")
})

test("treats the server share prefix as the UNC root", () => {
  expect(pickerRoot("//Server/Share/repo/src")).toBe("//Server/Share")
  expect(pickerRoot("\\\\Server\\Share\\repo\\src")).toBe("//Server/Share")
  expect(pickerParent("//Server/Share")).toBe("//Server/Share")
  expect(pickerParent("//Server/Share/repo")).toBe("//Server/Share")
})

test("resolves relative input against the current picker root", () => {
  expect(pickerAbsoluteInput("src", "/home/luke", "/home/luke/repo")).toBe("/home/luke/repo/src")
  expect(pickerAbsoluteInput("../other", "/home/luke", "/home/luke/repo")).toBe("/home/luke/other")
  expect(pickerAbsoluteInput("~/.config", "/home/luke", "/home/luke/repo")).toBe("/home/luke/.config")
  expect(pickerAbsoluteInput("src", "C:/Users/luke", "C:/Users/luke/repo")).toBe("C:/Users/luke/repo/src")
})

test("exposes autocomplete results only for their source query", () => {
  const result = { query: "/repo/src", items: ["/repo/src/index.ts"] }
  expect(currentPickerSuggestions(result, "/repo/src")).toEqual(result.items)
  expect(currentPickerSuggestions(result, "/repo/test")).toEqual([])
})

test("scopes file autocomplete to the current browser root", () => {
  expect(pickerFileSearchQuery("/home/luke/repos", "/home/luke/repos/src/in", "/home/luke")).toBe("src/in")
  expect(pickerFileSearchQuery("/home/luke", "~/repos/op", "/home/luke")).toBe("repos/op")
})

test("resolves directory autocomplete from the current browser root", async () => {
  const directories: string[] = []
  const sdk = {
    api: {
      file: {
        find: (input: { location?: { directory?: string } }) => {
          directories.push(input.location?.directory ?? "")
          return Promise.resolve({ data: [] })
        },
        list: () => Promise.resolve({ data: [] }),
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
  let base = "/repo"
  const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => base })

  await search("components")
  base = "/repo/src"
  await search("components")

  expect(directories).toEqual(["/repo", "/repo/src"])
})

test("keeps indexed directory results for servers that support empty search", async () => {
  const sdk = {
    api: {
      file: {
        find: () => Promise.resolve({ data: [{ path: "projects/", type: "directory" }] }),
        list: () => Promise.reject(new Error("listing should not run when search returns results")),
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
  const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => "/home/luke" })

  expect(await search("")).toEqual(["/home/luke/projects"])
})

test("lists the default directory when empty search is unsupported", async () => {
  const calls: string[] = []
  const directories = Array.from({ length: 60 }, (_, index) => ({
    path: `project-${index}/`,
    type: "directory" as const,
  }))
  const sdk = {
    api: {
      file: {
        find: () => Promise.resolve({ data: [] }),
        list: (input: { location?: { directory?: string } }) => {
          calls.push(input.location?.directory ?? "")
          return Promise.resolve({
            data: [...directories, { path: "README.md", type: "file" }],
          })
        },
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
  const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => "/home/luke" })

  const results = await search("")
  expect(results).toHaveLength(60)
  expect(results.at(-1)).toBe("/home/luke/project-59")
  expect(calls).toEqual(["/home/luke"])
})

test("matches the default directory listing when typed search is unsupported", async () => {
  const sdk = {
    api: {
      file: {
        find: () => Promise.resolve({ data: [] }),
        list: () =>
          Promise.resolve({
            data: [
              { path: "Documents/", type: "directory" },
              { path: "Downloads/", type: "directory" },
            ],
          }),
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
  const search = createDirectorySearch({ sdk, home: () => "/home/luke", base: () => "/home/luke" })

  expect(await search("documents")).toEqual(["/home/luke/Documents"])
})

test("searches from an absolute root without a default base", async () => {
  const directories: string[] = []
  const sdk = {
    api: {
      file: {
        list: (input: { location?: { directory?: string } }) => {
          directories.push(input.location?.directory ?? "")
          return Promise.resolve({
            data: [
              { path: "Users/", type: "directory" },
              { path: "tmp/", type: "directory" },
            ],
          })
        },
      },
    },
  } as unknown as Parameters<typeof createDirectorySearch>[0]["sdk"]
  const search = createDirectorySearch({ sdk, home: () => "", base: () => undefined })

  expect(await search("/")).toEqual(["/Users", "/tmp"])
  expect(directories).toEqual(["/"])
})

test("identifies the next directory level to preload", () => {
  expect(
    preloadTreeDirectories("src/", [
      { name: "components", type: "directory" },
      { name: "index.ts", type: "file" },
      { name: "utils", type: "directory" },
    ]),
  ).toEqual(["src/components/", "src/utils/"])
})

test("advances preloading once for every expanded directory", () => {
  const advanced = new Set<string>()
  expect(advanceTreePreload(advanced, "")).toBeTrue()
  expect(advanceTreePreload(advanced, "")).toBeFalse()
  expect(advanceTreePreload(advanced, "repos/")).toBeTrue()
})

test("limits background tasks and prioritizes newly requested work", async () => {
  const queue = createPriorityTaskQueue<void>(2)
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const started: string[] = []
  let active = 0
  let maximum = 0
  const task = (name: string, blocker?: Promise<void>) => async () => {
    started.push(name)
    active++
    maximum = Math.max(maximum, active)
    await blocker
    active--
  }

  const running = [
    queue.schedule("first", "background", task("first", first.promise)),
    queue.schedule("second", "background", task("second", second.promise)),
    queue.schedule("preload", "background", task("preload")),
    queue.schedule("opened", "user", task("opened")),
  ]
  await Promise.resolve()
  expect(started).toEqual(["first", "second"])

  first.resolve()
  await running[0]
  await Promise.resolve()
  expect(started).toEqual(["first", "second", "opened"])

  second.resolve()
  await Promise.all(running)
  expect(started).toEqual(["first", "second", "opened", "preload"])
  expect(maximum).toBe(2)
})

test("clamps bridged tree wheel scrolling", () => {
  expect(nextTreeScrollTop(100, 40, 500, 200)).toBe(140)
  expect(nextTreeScrollTop(10, -40, 500, 200)).toBe(0)
  expect(nextTreeScrollTop(290, 40, 500, 200)).toBe(300)
})

test("wraps autocomplete keyboard navigation", () => {
  expect(nextSuggestionIndex(-1, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(3, 1, 4)).toBe(0)
  expect(nextSuggestionIndex(0, -1, 4)).toBe(3)
  expect(nextSuggestionIndex(0, 1, 0)).toBe(-1)
})

test("returns absolute directories and relative files", () => {
  expect(selectedTreePath("/home/luke/repo", "src/", "directory")).toBe("/home/luke/repo/src")
  expect(selectedTreePath("/home/luke/repo", "src/index.ts", "file")).toBe("src/index.ts")
  expect(selectedTreePath("/home/luke/repo/src", "index.ts", "file", "/home/luke/repo")).toBe("src/index.ts")
  expect(selectedTreePath("/home/luke/repo", "src/", "file")).toBeUndefined()
})

test("derives one search root per added project parent", () => {
  expect(projectSearchRoots(SIBLING_PROJECTS)).toEqual(["/home/luke/Projects", "/home/luke/ExternalProjects"])
  expect(projectSearchRoots(["C:\\repos\\alpha", "C:/repos/beta", "//Server/Share/gamma", "/solo"])).toEqual([
    "C:/repos",
    "//Server/Share",
    "/",
  ])
  expect(projectSearchRoots(Array.from({ length: 30 }, (_, index) => `/parent-${index}/project`))).toHaveLength(
    MAX_PROJECT_SEARCH_ROOTS,
  )
})

test("finds a bare fuzzy name among the added projects' siblings", async () => {
  const calls: string[] = []
  const search = createDirectorySearch({
    sdk: treeSdk(calls),
    home: () => "/home/luke",
    base: () => "/home/luke",
    extraRoots: () => projectSearchRoots(SIBLING_PROJECTS),
  })

  expect(await search("andr")).toEqual(["/home/luke/Projects/Android"])
  expect(calls).toContain("find:/home/luke/Projects")
  expect(calls).toContain("find:/home/luke/ExternalProjects")
})

test("searches a shared project parent only once", async () => {
  const calls: string[] = []
  const search = createDirectorySearch({
    sdk: treeSdk(calls),
    home: () => "/home/luke",
    base: () => "/home/luke",
    extraRoots: () => projectSearchRoots(["/home/luke/Projects/alpha", "/home/luke/Projects/beta"]),
  })

  await search("android")

  expect(calls.filter((call) => call === "find:/home/luke/Projects")).toHaveLength(1)
})

test("resolves multi-segment relative input from the project parents", async () => {
  const search = createDirectorySearch({
    sdk: treeSdk(),
    home: () => "/home/luke",
    base: () => "/home/luke",
    extraRoots: () => projectSearchRoots([...SIBLING_PROJECTS, "/home/luke/ExternalProjects/space-bunny"]),
  })

  expect(await search("space/src")).toContain("/home/luke/ExternalProjects/space-bunny/src")
  expect(await search("queue/src")).toContain("/home/luke/ExternalProjects/opencode-queue/src")
})

test("keeps explicit path input on the normal base", async () => {
  for (const filter of [
    "~/Projects",
    "/home/luke/Projects",
    "C:/Users/luke",
    "//Server/Share",
    "./android",
    "../android",
  ]) {
    const calls: string[] = []
    const search = createDirectorySearch({
      sdk: treeSdk(calls),
      home: () => "/home/luke",
      base: () => "/home/luke",
      extraRoots: () => projectSearchRoots(SIBLING_PROJECTS),
    })

    await search(filter)

    expect(calls).not.toContain("find:/home/luke/Projects")
    expect(calls).not.toContain("find:/home/luke/ExternalProjects")
  }
})

test("deduplicates results shared by the normal base and the project parents", async () => {
  const search = createDirectorySearch({
    sdk: treeSdk(),
    home: () => "/home/luke",
    base: () => "/home/luke",
    // A project directly under the home directory makes the extra root identical to the base.
    extraRoots: () => projectSearchRoots(["/home/luke/alpha"]),
  })

  const results = await search("projects")

  expect(results).toContain("/home/luke/Projects")
  expect(results.filter((path) => path === "/home/luke/Projects")).toHaveLength(1)
})
