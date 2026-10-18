import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { ContextItem, ImageAttachmentPart, Prompt, PromptScope, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import { ServerScope } from "@/utils/server-scope"
import { Worktree as WorktreeState } from "@/utils/worktree"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateCallers: string[] = []
const shellCallers: string[] = []
const commandCallers: string[] = []
const createdWorktrees: unknown[] = []
const removedWorktrees: unknown[] = []
const navigated: string[] = []
const toasts: unknown[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const queuedInputs: unknown[] = []
const queueMutations: unknown[] = []
const queueItems: unknown[] = []
const statusWrites: unknown[] = []
let queueGate: Promise<void> | undefined
let queueError: Error | undefined
let invalidQueueResponse = false
let queueStarted = () => {}
const interrupted: string[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let parentID: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let createWorktreeGate: Promise<void> | undefined
let promptGate: Promise<void> | undefined
let promptError: Error | undefined
let promptErrorDirectory: string | undefined
let sessionCreateError: Error | undefined
let sessionIDOverride: string | undefined
let worktreeCreateError: Error | undefined
let worktreeCreateReady: boolean | undefined
let onPromptStarted: () => void = () => undefined
let onImageEncodingStarted: () => void = () => undefined
let imageGate: Promise<void> | undefined
let promptGateDirectory: string | undefined
let newWorktreeDirectory = "/repo/main/new"
let promptResets = 0
let currentPathname = "/repo/main/session"
let promptContextItems: (ContextItem & { key: string })[] = []
let sessionContextItems: (ContextItem & { key: string })[] = []

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
let sessionPromptValue: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const contextFor = (items: (ContextItem & { key: string })[]) => ({
  items: () => items,
  add: (item: ContextItem) => {
    const key = `${item.path}:${item.commentID ?? ""}`
    if (items.some((current) => current.key === key)) return
    items.push({ key, ...item })
  },
  remove: (key: string) => {
    const index = items.findIndex((item) => item.key === key)
    if (index !== -1) items.splice(index, 1)
  },
  removeComment: (path: string, commentID: string) => {
    const index = items.findIndex((item) => item.type === "file" && item.path === path && item.commentID === commentID)
    if (index !== -1) items.splice(index, 1)
  },
  updateComment: (path: string, commentID: string, next: Partial<ContextItem> & { comment?: string }) => {
    const index = items.findIndex((item) => item.type === "file" && item.path === path && item.commentID === commentID)
    if (index === -1) return
    items[index] = { ...items[index]!, ...next, key: items[index]!.key } as ContextItem & { key: string }
  },
  replaceComments: (values: ContextItem[]) => {
    items.splice(0, items.length, ...values.map((item) => ({ key: `${item.path}:${item.commentID ?? ""}`, ...item })))
  },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => {
    promptResets++
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
  },
  set: (value: Prompt) => {
    promptValue = value
  },
  context: contextFor(promptContextItems),
  capture: (scope?: PromptScope) => (scope && "id" in scope && scope.id ? (sessionPrompt ?? prompt) : prompt),
}

let sessionPrompt: typeof prompt | undefined
sessionPrompt = {
  ...prompt,
  context: contextFor(sessionContextItems),
  current: () => sessionPromptValue,
  cursor: () => sessionPromptValue.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  reset: () => {
    sessionPromptValue = [{ type: "text", content: "", start: 0, end: 0 }]
  },
  set: (value: Prompt) => {
    sessionPromptValue = value
  },
  capture: () => sessionPrompt ?? prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          if (sessionCreateError) throw sessionCreateError
          const location = input.location?.directory ?? directory
          sessionCreateCallers.push(directory)
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: sessionIDOverride ?? `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          onPromptStarted()
          if (!promptGateDirectory || promptGateDirectory === directory) await promptGate
          if (promptError && (!promptErrorDirectory || promptErrorDirectory === directory)) throw promptError
          return { data: undefined }
        },
        command: async (input: unknown) => {
          commandCallers.push(directory)
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          shellCallers.push(directory)
          sentShell.push(input)
        },
        interrupt: async (input: { sessionID: string }) => {
          interrupted.push(input.sessionID)
        },
      },
    },
    session: {
      queueSubmit: async (input: { sessionID: string }) => {
        queuedInputs.push(input)
        queueStarted()
        await queueGate
        if (queueError) throw queueError
        if (invalidQueueResponse) return { data: {} }
        return { data: { sessionID: input.sessionID, revision: 1, paused: false, blocked: false, items: [] } }
      },
      queueList: async () => ({
        data: { sessionID: params.id, revision: 2, paused: false, blocked: false, items: queueItems },
      }),
      queueUpdate: async (input: unknown) => {
        queueMutations.push(input)
        return {
          data: { sessionID: params.id, revision: 2 + queueMutations.length, paused: true, blocked: false, items: [] },
        }
      },
      queueFlush: async (input: unknown) => {
        queueMutations.push(input)
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async (input: unknown) => {
        createdWorktrees.push(input)
        await createWorktreeGate
        if (worktreeCreateError) throw worktreeCreateError
        return {
          data: {
            directory: newWorktreeDirectory,
            ...(worktreeCreateReady === undefined ? {} : { ready: worktreeCreateReady }),
          },
        }
      },
      remove: async (input: unknown) => {
        removedWorktrees.push(input)
        return { data: true }
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (value: string) => {
      navigated.push(value)
      currentPathname = value
    },
    useParams: () => params,
    useLocation: () => ({
      get pathname() {
        return currentPathname
      },
    }),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@/utils/toast", () => ({
    showToast: (value: unknown) => {
      toasts.push(value)
      return 0
    },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/utils/draft-store", () => ({
    blobDataUrl: async () => {
      onImageEncodingStarted()
      await imageGate
      return "data:text/plain;base64,YQ=="
    },
  }))

  mock.module("@/utils/draft-store", () => ({
    blobDataUrl: async () => {
      onImageEncodingStarted()
      await imageGate
      return "data:text/plain;base64,YQ=="
    },
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        apiForDirectory: (directory: string) => clientFor(directory).api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        get: () => (parentID ? { parentID } : undefined),
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: (...args: unknown[]) => {
          statusWrites.push(args)
        },
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
      plural: (key: string, count: number) => `${key}:${count}`,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  queuedInputs.length = 0
  queueMutations.length = 0
  queueItems.length = 0
  statusWrites.length = 0
  queueGate = undefined
  queueError = undefined
  invalidQueueResponse = false
  sessionIDOverride = undefined
  queueStarted = () => {}
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateCallers.length = 0
  shellCallers.length = 0
  commandCallers.length = 0
  createdWorktrees.length = 0
  navigated.length = 0
  toasts.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  parentID = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  createWorktreeGate = undefined
  promptGate = undefined
  promptError = undefined
  promptErrorDirectory = undefined
  sessionCreateError = undefined
  worktreeCreateError = undefined
  worktreeCreateReady = true
  onPromptStarted = () => undefined
  onImageEncodingStarted = () => undefined
  imageGate = undefined
  promptGateDirectory = undefined
  promptContextItems.length = 0
  sessionContextItems.length = 0
  newWorktreeDirectory = `/tmp/opencode-submit-${crypto.randomUUID()}`
  currentPathname = "/repo/main/session"
  promptResets = 0
  sessionPromptValue = [{ type: "text", content: "", start: 0, end: 0 }]
  serverSessionSyncs = 0
  removedWorktrees.length = 0
  interrupted.length = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

const createSubmit = (options: Partial<Parameters<typeof createPromptSubmit>[0]> = {}) =>
  createPromptSubmit({
    prompt,
    info: () => (params.id ? { id: params.id } : undefined),
    imageAttachments: () => [],
    commentCount: () => 0,
    autoAccept: () => false,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    newSessionWorktree: () => selected,
    onNewSessionWorktreeReset: () => undefined,
    onSubmit: () => undefined,
    ...options,
  })

describe("native queue submission", () => {
  test("preserves an explicit default variant when queueing in a child session", async () => {
    params.id = "ses_child"
    parentID = "ses_parent"
    await createSubmit().handleSubmit(new Event("submit"), "queue")
    expect(queuedInputs[0]).toMatchObject({ payload: { variant: "default" } })
  })
  test("captures model and variant before awaiting initial session creation", async () => {
    selected = "main"
    variant = "captured"
    const current = { id: "model", provider: { id: "provider" } }
    const release = Promise.withResolvers<void>()
    createSessionGate = release.promise
    const submit = createSubmit({
      model: { current: () => current, variant: { current: () => variant } } as unknown as ModelSelection,
    })
    const request = submit.handleSubmit(new Event("submit"), "queue")
    current.id = "edited-model"
    current.provider.id = "edited-provider"
    variant = "edited"
    release.resolve()
    await request
    expect(queuedInputs[0]).toMatchObject({
      payload: { model: { modelID: "model", providerID: "provider" }, variant: "captured" },
    })
  })
  test("awaits admission, guards double submission, and adds no optimistic busy or message", async () => {
    params.id = "ses_queue"
    const preparing: boolean[] = []
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    queueGate = release.promise
    queueStarted = () => started.resolve()
    const submit = createSubmit({ working: () => true, onPreparing: (value) => preparing.push(value) })
    const request = submit.handleSubmit(new Event("submit"), "queue")
    await started.promise
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(queuedInputs).toHaveLength(1)
    expect(promptResets).toBe(0)
    expect(optimistic).toHaveLength(0)
    expect(preparing).not.toContain(true)
    expect(statusWrites).toHaveLength(0)
    expect(toasts).toHaveLength(0)
    release.resolve()
    await request
    expect(promptResets).toBe(1)
    expect(sentPrompts).toHaveLength(0)
    expect(toasts).toEqual([{ title: "queue.queued", variant: "success", duration: 3000 }])
    expect(queuedInputs[0]).toMatchObject({
      sessionID: "ses_queue",
      payload: { kind: "prompt", agent: "agent", model: { modelID: "model", providerID: "provider" } },
    })
  })
  test("preserves the composer on queue failure", async () => {
    params.id = "ses_queue"
    queueError = new Error("offline")
    const submit = createSubmit()
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(promptResets).toBe(0)
    expect(promptValue[0]).toMatchObject({ content: "ls" })
    expect(toasts).toContainEqual(expect.objectContaining({ description: "offline" }))
    expect(toasts).not.toContainEqual(expect.objectContaining({ variant: "success" }))
    queueError = undefined
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(queuedInputs[1]).toEqual(queuedInputs[0])
  })
  test("rejects an invalid queue response without confirmation or clearing and preserves retry identity", async () => {
    params.id = "ses_queue"
    invalidQueueResponse = true
    const submit = createSubmit()
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(promptResets).toBe(0)
    expect(promptValue[0]).toMatchObject({ content: "ls" })
    expect(toasts).toContainEqual(expect.objectContaining({ title: "common.requestFailed" }))
    expect(toasts).not.toContainEqual(expect.objectContaining({ variant: "success" }))
    invalidQueueResponse = false
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(queuedInputs[1]).toEqual(queuedInputs[0])
    expect(toasts.filter((toast) => (toast as { variant?: string }).variant === "success")).toHaveLength(1)
  })
  test("keeps a new-session queue failure on the original draft and reuses its session on retry", async () => {
    selected = "main"
    sessionIDOverride = "ses_new_queue"
    promptValue = [{ type: "text", content: "/queue first draft", start: 0, end: 18 }]
    queueError = new Error("offline")
    const submit = createSubmit()
    await submit.handleSubmit(new Event("submit"))
    expect(navigated).toHaveLength(0)
    expect(promptResets).toBe(0)
    expect(createdSessions).toHaveLength(1)
    expect(toasts).not.toContainEqual(expect.objectContaining({ variant: "success" }))
    queueError = undefined
    await submit.handleSubmit(new Event("submit"))
    expect(createdSessions).toHaveLength(1)
    expect(navigated).toHaveLength(1)
    expect(queuedInputs[1]).toEqual(queuedInputs[0])
    expect(navigated[0]).toEndWith("/session/ses_new_queue")
    expect(optimistic).toHaveLength(0)
    expect(toasts.filter((toast) => (toast as { variant?: string }).variant === "success")).toEqual([
      { title: "queue.queued", variant: "success", duration: 3000 },
    ])
  })
  test("preserves edits made while native admission is in flight", async () => {
    params.id = "ses_queue"
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    queueGate = release.promise
    queueStarted = () => started.resolve()
    const request = createSubmit().handleSubmit(new Event("submit"), "queue")
    await started.promise
    promptValue = [{ type: "text", content: "next draft", start: 0, end: 10 }]
    release.resolve()
    await request
    expect(promptResets).toBe(0)
    expect(promptValue[0]).toMatchObject({ content: "next draft" })
  })
  test("preserves edits during a new-session queue handoff", async () => {
    selected = "main"
    sessionIDOverride = "ses_new_queue"
    promptValue = [{ type: "text", content: "/queue first draft", start: 0, end: 18 }]
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    queueGate = release.promise
    queueStarted = () => started.resolve()
    const request = createSubmit().handleSubmit(new Event("submit"))
    await started.promise
    expect(toasts).toHaveLength(0)
    promptValue = [{ type: "text", content: "next draft", start: 0, end: 10 }]
    release.resolve()
    await request
    expect(sessionPromptValue[0]).toMatchObject({ content: "next draft" })
    expect(optimistic).toHaveLength(0)
    expect(toasts).toEqual([{ title: "queue.queued", variant: "success", duration: 3000 }])
  })
  test("does not promote another draft sharing the new-session pathname during queue admission", async () => {
    selected = "main"
    currentPathname = "/new-session"
    search.draftId = "draft-a"
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    queueGate = release.promise
    queueStarted = () => started.resolve()
    const request = createSubmit().handleSubmit(new Event("submit"), "queue")
    await started.promise
    search.draftId = "draft-b"
    promptValue = [{ type: "text", content: "draft b remains here", start: 0, end: 20 }]
    release.resolve()
    await request
    expect(promotedDrafts).toEqual([])
    expect(navigated).toEqual([])
    expect(promptValue[0]).toMatchObject({ content: "draft b remains here" })
    expect(sessionPromptValue[0]).toMatchObject({ content: "" })
  })
  test("does not reuse another draft's prepared session after failed admission", async () => {
    selected = "main"
    currentPathname = "/new-session"
    search.draftId = "draft-a"
    sessionIDOverride = "session-a"
    queueError = new Error("offline")
    const submit = createSubmit()
    await submit.handleSubmit(new Event("submit"), "queue")
    search.draftId = "draft-b"
    sessionIDOverride = "session-b"
    queueError = undefined
    await submit.handleSubmit(new Event("submit"), "queue")
    expect(createdSessions).toHaveLength(2)
    expect(queuedInputs[0]).toMatchObject({ sessionID: "session-a" })
    expect(queuedInputs[1]).toMatchObject({ sessionID: "session-b" })
    expect(promotedDrafts).toEqual([{ draftID: "draft-b", server: "project-server", sessionId: "session-b" }])
  })
  test("captures context immutably and preserves in-place edits during admission", async () => {
    params.id = "ses_queue"
    promptContextItems.push({ key: "comment", type: "file", path: "a.ts", comment: "captured comment" })
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    queueGate = release.promise
    queueStarted = () => started.resolve()
    const request = createSubmit().handleSubmit(new Event("submit"), "queue")
    await started.promise
    promptContextItems[0]!.comment = "edited comment"
    release.resolve()
    await request
    expect(promptResets).toBe(0)
    expect(promptContextItems[0]?.comment).toBe("edited comment")
    expect(queuedInputs[0]).toMatchObject({
      payload: {
        parts: [
          { type: "text", text: "ls" },
          { type: "text", text: expect.stringContaining("captured comment") },
          { type: "file", filename: "a.ts" },
        ],
      },
    })
  })
  test("intercepts /queue text before a custom command named queue", async () => {
    params.id = "ses_queue"
    commands.push({ name: "queue" })
    promptValue = [{ type: "text", content: "/queue abc", start: 0, end: 10 }]
    await createSubmit().handleSubmit(new Event("submit"))
    expect(queuedInputs[0]).toMatchObject({ payload: { kind: "prompt", parts: [{ type: "text", text: "abc" }] } })
    expect(sentCommands).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(toasts).toEqual([{ title: "queue.queued", variant: "success", duration: 3000 }])
  })
  test.each(["/queue stop", "/queue start", "/queue flush", "/queue clear"])(
    "%s is a management operation, not a prompt",
    async (text) => {
      params.id = "ses_queue"
      promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
      const preparing: boolean[] = []
      await createSubmit({ onPreparing: (value) => preparing.push(value) }).handleSubmit(new Event("submit"))
      expect(queueMutations).toHaveLength(1)
      expect(queuedInputs).toHaveLength(0)
      expect(optimistic).toHaveLength(0)
      expect(sentPrompts).toHaveLength(0)
      expect(preparing).not.toContain(true)
      expect(promptResets).toBe(1)
    },
  )
  test("reserves /queues for management", async () => {
    params.id = "ses_queue"
    promptValue = [{ type: "text", content: "/queues", start: 0, end: 7 }]
    let managed = 0
    await createSubmit({ onManageQueue: () => managed++ }).handleSubmit(new Event("submit"))
    expect(managed).toBe(1)
    expect(queuedInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
  })
  test.each(["/queue", "/queue list"])("%s lists only pending queued items in queue order", async (text) => {
    params.id = "ses_queue"
    queueItems.push(
      ...["pending", "claimed", "uncertain", "pending"].map((state, position) => ({
        id: state,
        state,
        position,
        sessionID: params.id,
        delivery: position === 3 ? "steer" : "queue",
        created: 1,
        payload: { kind: "compact", agent: "agent", model: { providerID: "provider", modelID: "model" } },
      })),
      {
        id: "first",
        state: "pending",
        position: -1,
        sessionID: params.id,
        delivery: "queue",
        created: 1,
        payload: {
          kind: "prompt",
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          parts: [{ type: "text", text: "First line\nsecond line" }],
        },
      },
    )
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    await createSubmit().handleSubmit(new Event("submit"))
    expect(toasts).toContainEqual({
      title: "queue.title",
      description: "queue.list:2\n1. First line second line\n2. queue.compact",
      multiline: true,
      duration: 10000,
      actions: [],
    })
    expect(queuedInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(optimistic).toHaveLength(0)
    expect(statusWrites).toHaveLength(0)
  })
  test.each(["/queue", "/queue list"])("%s reports an empty queue", async (text) => {
    params.id = "ses_queue"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    await createSubmit().handleSubmit(new Event("submit"))
    expect(toasts).toContainEqual(
      expect.objectContaining({ description: "queue.list:0\nqueue.empty", multiline: true }),
    )
    expect(queuedInputs).toHaveLength(0)
  })
  test("list previews attachments and commands without exposing attachment data", async () => {
    params.id = "ses_queue"
    const info = { agent: "agent", model: { providerID: "provider", modelID: "model" } }
    queueItems.push(
      ...[
        {
          kind: "prompt",
          ...info,
          parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,SECRET", filename: "design.png" }],
        },
        { kind: "command", ...info, command: "review", arguments: "changed files" },
        { kind: "shell", ...info, command: "ls -la" },
      ].map((payload, position) => ({
        id: `${position}`,
        position,
        payload,
        sessionID: params.id,
        created: 1,
        state: "pending",
        delivery: "queue",
      })),
    )
    promptValue = [{ type: "text", content: "/queue list", start: 0, end: 11 }]
    await createSubmit().handleSubmit(new Event("submit"))
    expect(toasts).toContainEqual(
      expect.objectContaining({ description: "queue.list:3\n1. design.png\n2. /review changed files\n3. !ls -la" }),
    )
    expect(JSON.stringify(toasts)).not.toContain("SECRET")
  })
  test("bounds list previews and offers the full native queue dialog", async () => {
    params.id = "ses_queue"
    queueItems.push(
      ...Array.from({ length: 4 }, (_, position) => ({
        id: `${position}`,
        position,
        sessionID: params.id,
        created: 1,
        state: "pending",
        delivery: "queue",
        payload: {
          kind: "prompt",
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          parts: [{ type: "text", text: position === 0 ? "x".repeat(200) : `item-${position}` }],
        },
      })),
    )
    promptValue = [{ type: "text", content: "/queue list", start: 0, end: 11 }]
    let managed = 0
    await createSubmit({ onManageQueue: () => managed++ }).handleSubmit(new Event("submit"))
    expect(toasts).toContainEqual(
      expect.objectContaining({
        description: `queue.list:4\n1. ${"x".repeat(77)}...\n2. item-1\n3. item-2\nqueue.list.more`,
      }),
    )
    const toast = toasts[0] as { actions: { label: string; onClick: () => void }[] }
    expect(managed).toBe(0)
    expect(toast.actions[0]?.label).toBe("queue.manage")
    toast.actions[0]?.onClick()
    expect(managed).toBe(1)
    params.id = "ses_other"
    toast.actions[0]?.onClick()
    expect(managed).toBe(1)
    params.id = "ses_queue"
    currentPathname = "/repo/main/other-session"
    toast.actions[0]?.onClick()
    expect(managed).toBe(1)
  })
  test("indexed clear sends stable IDs with the latest acknowledged CAS revision", async () => {
    params.id = "ses_queue"
    queueItems.push(
      ...["second", "first"].map((id, index) => ({
        id,
        position: 1 - index,
        sessionID: params.id,
        state: "pending",
        delivery: "queue",
        created: 1,
        payload: { kind: "compact", agent: "agent", model: { providerID: "provider", modelID: "model" } },
      })),
    )
    promptValue = [{ type: "text", content: "/queue clear 2 1", start: 0, end: 16 }]
    await createSubmit().handleSubmit(new Event("submit"))
    expect(queueMutations).toEqual([
      { sessionID: "ses_queue", directory: "/repo/main", revision: 2, mutation: { action: "delete", id: "second" } },
      { sessionID: "ses_queue", directory: "/repo/main", revision: 3, mutation: { action: "delete", id: "first" } },
    ])
  })
  test("attachment-only queue drafts are admitted instead of stopping the runner", async () => {
    params.id = "ses_queue"
    promptValue = [{ type: "file", content: "", path: "a.ts", start: 0, end: 0 }]
    await createSubmit({ working: () => true }).handleSubmit(new Event("submit"), "queue")
    expect(queuedInputs[0]).toMatchObject({
      payload: { kind: "prompt", parts: [{ type: "file", url: "file:///repo/main/a.ts" }] },
    })
    expect(interrupted).toHaveLength(0)
  })
  test("default Enter steers a busy session instead of queuing", async () => {
    params.id = "ses_queue"
    await createSubmit({ working: () => true }).handleSubmit(new Event("submit"))
    expect(queuedInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(1)
  })
  describe.each([false, true])("prompt admission (busy: %s)", (working) => {
    test("awaits admission before clearing the composer and submitted comments", async () => {
      params.id = "ses_queue"
      promptContextItems.push({ key: "comment", type: "file", path: "a.ts", comment: "captured comment" })
      const release = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      promptGate = release.promise
      onPromptStarted = () => started.resolve()
      const submit = createSubmit({ working: () => working })
      const request = submit.handleSubmit(new Event("submit"))
      await started.promise
      await submit.handleSubmit(new Event("submit"))
      expect(sentPrompts).toHaveLength(1)
      expect(promptResets).toBe(0)
      expect(promptContextItems).toHaveLength(1)
      release.resolve()
      await request
      expect(promptResets).toBe(1)
      expect(promptContextItems).toHaveLength(0)
      if (working) expect(statusWrites).toHaveLength(0)
    })
    test("preserves the captured draft on failure without clearing it", async () => {
      params.id = "ses_queue"
      promptError = new Error("offline")
      await createSubmit({ working: () => working }).handleSubmit(new Event("submit"))
      expect(promptResets).toBe(0)
      expect(promptValue[0]).toMatchObject({ content: "ls" })
      expect(toasts).toContainEqual(expect.objectContaining({ description: "offline" }))
      if (working) expect(statusWrites).toHaveLength(0)
    })
    test.each([false, true])("preserves edits while admission is in flight (failure: %s)", async (fail) => {
      params.id = "ses_queue"
      promptContextItems.push({ key: "comment", type: "file", path: "a.ts", comment: "captured comment" })
      const release = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      promptGate = release.promise
      promptError = fail ? new Error("offline") : undefined
      onPromptStarted = () => started.resolve()
      const request = createSubmit({ working: () => working }).handleSubmit(new Event("submit"))
      await started.promise
      promptValue = [{ type: "text", content: "next draft", start: 0, end: 10 }]
      promptContextItems[0]!.comment = "edited comment"
      release.resolve()
      await request
      expect(promptResets).toBe(0)
      expect(promptValue[0]).toMatchObject({ content: "next draft" })
      expect(promptContextItems[0]?.comment).toBe("edited comment")
      expect(promptInputs[0]).toMatchObject({ text: expect.stringContaining("captured comment") })
    })
  })
})

describe("prompt submit worktree selection", () => {
  test("waits for initial main-session admission and reuses the session after failure", async () => {
    selected = "main"
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    promptGate = release.promise
    promptError = new Error("offline")
    onPromptStarted = () => started.resolve()
    const submit = createSubmit()
    const request = submit.handleSubmit(new Event("submit"))
    await started.promise
    expect(promptResets).toBe(0)
    expect(navigated).toHaveLength(0)
    release.resolve()
    await request
    expect(promptResets).toBe(0)
    expect(navigated).toHaveLength(0)
    promptError = undefined
    await submit.handleSubmit(new Event("submit"))
    expect(createdSessions).toHaveLength(1)
    expect(promptResets).toBe(1)
    expect(navigated).toEqual(["//repo/main/session/session-1"])
  })
  test("waits for backend worktree readiness and submits through the target directory", async () => {
    selected = "create"
    worktreeCreateReady = true
    let releaseWorktree = () => {}
    createWorktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve
    })
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const preparing: boolean[] = []
    const submit = createSubmit({ onPreparing: (value) => preparing.push(value) })
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(preparing).toEqual([true])
    expect(createdWorktrees).toHaveLength(1)
    releaseWorktree()
    await promptStarted

    expect(createdWorktrees).toEqual([{ directory: "/repo/main", worktreeCreateInput: { waitUntilReady: true } }])
    expect(sessionCreateInputs[0]?.location).toEqual({ directory: newWorktreeDirectory })
    expect(sessionCreateCallers).toEqual([newWorktreeDirectory])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
    expect(optimistic).toHaveLength(0)
    expect(navigated).toEqual([])
    expect(promptResets).toBe(0)
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])

    releasePrompt()
    await request

    expect(optimistic).toHaveLength(1)
    expect(navigated).toEqual([`/${newWorktreeDirectory}/session/session-1`])
    expect(promptResets).toBe(1)
    expect(preparing).toEqual([true, false])
    expect(sentPrompts).toHaveLength(1)
  })

  test("waits for the readiness event when an older server omits the readiness result", async () => {
    selected = "create"
    worktreeCreateReady = undefined
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    expect(sessionCreateInputs).toHaveLength(0)
    WorktreeState.ready(ServerScope.local, `${newWorktreeDirectory}-stale`)
    await Bun.sleep(0)
    expect(sessionCreateInputs).toHaveLength(0)

    WorktreeState.ready(ServerScope.local, newWorktreeDirectory)
    await request

    expect(sessionCreateCallers).toEqual([newWorktreeDirectory])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
  })

  test("does not create a session after an older server reports failed worktree readiness", async () => {
    selected = "create"
    worktreeCreateReady = undefined
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)
    WorktreeState.failed(ServerScope.local, newWorktreeDirectory, "checkout failed")
    await request

    expect(sessionCreateInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(navigated).toHaveLength(0)
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    expect(toasts).toContainEqual({
      title: "prompt.toast.worktreeCreateFailed.title",
      description: "checkout failed",
    })
  })

  test("retains the initial prompt and reuses its session after a failed submission", async () => {
    selected = "create"
    promptError = new Error("prompt failed")
    const submit = createSubmit()
    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    expect(sentPrompts).toEqual([newWorktreeDirectory])
    expect(navigated).toEqual([])
    expect(createdWorktrees).toHaveLength(1)
    expect(sessionCreateCallers).toEqual([newWorktreeDirectory])
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])

    promptError = undefined
    await submit.handleSubmit(event)

    expect(sentPrompts).toEqual([newWorktreeDirectory, newWorktreeDirectory])
    expect(createdWorktrees).toHaveLength(1)
    expect(sessionCreateCallers).toHaveLength(1)
    expect(navigated).toEqual([`/${newWorktreeDirectory}/session/session-1`])
  })

  test("does not create a session or send a prompt when worktree preparation fails", async () => {
    selected = "create"
    worktreeCreateError = new Error("bootstrap failed")
    const submit = createSubmit()

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sessionCreateInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(navigated).toHaveLength(0)
    expect(toasts).toContainEqual({
      title: "prompt.toast.worktreeCreateFailed.title",
      description: "bootstrap failed",
    })
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
  })

  test("keeps the prepared worktree and prompt when session creation fails", async () => {
    selected = "create"
    sessionCreateError = new Error("session create failed")
    const submit = createSubmit()
    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    expect(createdWorktrees).toHaveLength(1)
    expect(sessionCreateCallers).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)

    sessionCreateError = undefined
    await submit.handleSubmit(event)

    expect(createdWorktrees).toHaveLength(1)
    expect(sessionCreateCallers).toEqual([newWorktreeDirectory])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
  })

  test("cancels worktree preparation without sending the initial prompt", async () => {
    selected = "create"
    let releaseWorktree = () => {}
    createWorktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve
    })
    let aborts = 0
    const submit = createSubmit({ onAbort: () => aborts++ })
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    await submit.abort()
    releaseWorktree()
    await request

    expect(sessionCreateInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(navigated).toHaveLength(0)
    expect(aborts).toBe(1)
  })

  test("removes a worktree returned after cancellation", async () => {
    selected = "create"
    let releaseWorktree = () => {}
    createWorktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    await submit.abort()
    releaseWorktree()
    await request

    expect(removedWorktrees).toEqual([
      {
        directory: "/repo/main",
        worktreeRemoveInput: { directory: newWorktreeDirectory },
      },
    ])
    expect(sessionCreateInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
  })

  test("cancels an older server readiness wait without creating a session", async () => {
    selected = "create"
    worktreeCreateReady = undefined
    WorktreeState.pending(ServerScope.local, newWorktreeDirectory)
    let aborts = 0
    const submit = createSubmit({ onAbort: () => aborts++ })
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    await submit.abort()
    WorktreeState.ready(ServerScope.local, newWorktreeDirectory)
    await request

    expect(removedWorktrees).toEqual([
      {
        directory: "/repo/main",
        worktreeRemoveInput: { directory: newWorktreeDirectory },
      },
    ])
    expect(sessionCreateInputs).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    expect(aborts).toBe(1)
  })

  test("preserves edits made while the initial worktree prompt is pending", async () => {
    selected = "create"
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    prompt.set([{ type: "text", content: "typed while sending", start: 0, end: 19 }])
    releasePrompt()
    await request

    expect(promptValue).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(sessionPromptValue).toEqual([{ type: "text", content: "typed while sending", start: 0, end: 19 }])
  })

  test("aborting while encoding an image prevents the initial prompt request", async () => {
    selected = "create"
    let releaseImage = () => {}
    imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve
    })
    let imageStarted = () => {}
    const encodingStarted = new Promise<void>((resolve) => {
      imageStarted = resolve
    })
    onImageEncodingStarted = imageStarted
    const image = {
      type: "image",
      id: "image-1",
      filename: "image.png",
      mime: "image/png",
      blob: {} as ImageAttachmentPart["blob"],
    } satisfies ImageAttachmentPart
    prompt.set([image])
    const submit = createSubmit({ imageAttachments: () => [image] })
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    await encodingStarted
    await submit.abort()
    releaseImage()
    await request

    expect(interrupted).toEqual(["session-1"])
    expect(sentPrompts).toHaveLength(0)
    expect(navigated).toHaveLength(0)
  })

  test("allows a different route to submit while a worktree prompt is pending", async () => {
    selected = "create"
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    let starts = 0
    let releaseStarted = () => {}
    const startedTwice = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })
    onPromptStarted = () => {
      starts++
      if (starts === 2) releaseStarted()
    }
    const submit = createSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    currentPathname = "/repo/main/session/session-2"
    params = { id: "session-2" }
    selected = "main"
    prompt.set([{ type: "text", content: "pwd", start: 0, end: 3 }])
    const second = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await startedTwice

    expect(sentPrompts).toEqual([newWorktreeDirectory, "/repo/main"])
    releasePrompt()
    await Promise.all([first, second])
  })

  test("keeps a prepared worktree retry when another route submits", async () => {
    selected = "create"
    promptGateDirectory = newWorktreeDirectory
    promptError = new Error("temporary prompt failure")
    promptErrorDirectory = newWorktreeDirectory
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    let releaseStarted = () => {}
    const firstPromptStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })
    onPromptStarted = () => {
      if (sentPrompts.length === 1) releaseStarted()
    }
    const submit = createSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await firstPromptStarted

    currentPathname = "/repo/main/session/session-2"
    params = { id: "session-2" }
    selected = "main"
    sessionPrompt!.set([{ type: "text", content: "pwd", start: 0, end: 3 }])
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    releasePrompt()
    await first

    expect(toasts).toContainEqual(expect.objectContaining({ title: "prompt.toast.promptSendFailed.title" }))

    promptError = undefined
    currentPathname = "/repo/main/session"
    params = {}
    selected = "create"
    promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdWorktrees).toHaveLength(1)
    expect(sessionCreateInputs).toHaveLength(1)
    expect(sentPrompts).toEqual([newWorktreeDirectory, "/repo/main", newWorktreeDirectory])
    expect(promptInputs.map((value) => (value as { sessionID: string }).sessionID)).toEqual([
      "session-1",
      "session-2",
      "session-1",
    ])
  })

  test("stops the current session instead of a preparing worktree after navigation", async () => {
    selected = "create"
    promptGateDirectory = newWorktreeDirectory
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    currentPathname = "/repo/main/session/session-2"
    params.id = "session-2"
    await submit.abort()
    releasePrompt()
    await request

    expect(interrupted).toEqual(["session-2"])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
    expect(navigated).toHaveLength(0)
  })

  test("keeps an admitted prompt sent when Stop races its response", async () => {
    selected = "create"
    promptGateDirectory = newWorktreeDirectory
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    await submit.abort()
    releasePrompt()
    await request

    expect(interrupted).toEqual(["session-1", "session-1"])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
    expect(promptValue).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
    expect(navigated).toEqual([`/${newWorktreeDirectory}/session/session-1`])
  })

  test("interrupts the current session when its worktree selection is stale", async () => {
    params = { id: "session-1" }
    selected = "create"
    promptGateDirectory = "/repo/main"
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    await submit.abort()
    releasePrompt()
    await request

    expect(createdWorktrees).toHaveLength(0)
    expect(interrupted).toEqual(["session-1"])
  })

  test("cleans up a failed worktree reused after a readiness timeout", async () => {
    selected = "create"
    worktreeCreateReady = false
    const failedDirectory = newWorktreeDirectory
    const submit = createSubmit({ worktreeReadyTimeoutMs: 0 })
    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    expect(createdWorktrees).toHaveLength(1)
    expect(createdSessions).toHaveLength(0)

    WorktreeState.failed(ServerScope.local, failedDirectory, "late bootstrap failure")
    await submit.handleSubmit(event)

    expect(removedWorktrees).toContainEqual(
      expect.objectContaining({ worktreeRemoveInput: { directory: failedDirectory } }),
    )
    expect(createdWorktrees).toHaveLength(1)

    newWorktreeDirectory = `${failedDirectory}-retry`
    worktreeCreateReady = true
    promptValue = [{ type: "text", content: "retry", start: 0, end: 5 }]
    await submit.handleSubmit(event)

    expect(createdWorktrees).toHaveLength(2)
    expect(createdSessions).toEqual([newWorktreeDirectory])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
  })

  test("cleans up a reused worktree when Stop cancels its readiness wait", async () => {
    selected = "create"
    worktreeCreateReady = false
    const cancelledDirectory = newWorktreeDirectory
    const submit = createSubmit({ worktreeReadyTimeoutMs: 0 })
    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    const retry = submit.handleSubmit(event)
    const stop = submit.abort()
    await Promise.all([retry, stop])

    expect(createdWorktrees).toHaveLength(1)
    expect(removedWorktrees).toContainEqual(
      expect.objectContaining({ worktreeRemoveInput: { directory: cancelledDirectory } }),
    )
    expect(createdSessions).toHaveLength(0)

    newWorktreeDirectory = `${cancelledDirectory}-retry`
    worktreeCreateReady = true
    promptValue = [{ type: "text", content: "retry", start: 0, end: 5 }]
    await submit.handleSubmit(event)

    expect(createdWorktrees).toHaveLength(2)
    expect(createdSessions).toEqual([newWorktreeDirectory])
    expect(sentPrompts).toEqual([newWorktreeDirectory])
  })

  test("preserves an edited comment while promoting a worktree prompt", async () => {
    selected = "create"
    const comment: ContextItem & { key: string } = {
      key: "/repo/main/notes.md:comment-1",
      type: "file",
      path: "/repo/main/notes.md",
      comment: "submitted comment",
      commentID: "comment-1",
    }
    promptContextItems.push(comment)
    promptGateDirectory = newWorktreeDirectory
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit({ commentCount: () => promptContextItems.length })
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    prompt.context.updateComment(comment.path, comment.commentID!, { comment: "edited while sending" })
    releasePrompt()
    await request

    expect(sessionContextItems).toContainEqual(
      expect.objectContaining({
        key: comment.key,
        comment: "edited while sending",
        commentID: comment.commentID,
      }),
    )
  })

  test("does not navigate back if the user changes routes during initial prompt submission", async () => {
    selected = "create"
    let releasePrompt = () => {}
    promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const promptStarted = new Promise<void>((resolve) => {
      onPromptStarted = resolve
    })
    const submit = createSubmit()
    const request = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await promptStarted

    currentPathname = "/another/session"
    releasePrompt()
    await request

    expect(navigated).toHaveLength(0)
    expect(promoted).toEqual([{ directory: newWorktreeDirectory, sessionID: "session-1" }])
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    prompt.set([{ type: "text", content: "pwd", start: 0, end: 3 }])
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "pwd" }),
    ])
    expect(sessionCreateCallers).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(shellCallers).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})
