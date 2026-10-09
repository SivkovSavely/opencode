import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { ImageAttachmentPart, Prompt, PromptScope, PromptStore } from "@/context/prompt"
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
const interrupted: string[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let createWorktreeGate: Promise<void> | undefined
let promptGate: Promise<void> | undefined
let promptError: Error | undefined
let sessionCreateError: Error | undefined
let worktreeCreateError: Error | undefined
let worktreeCreateReady: boolean | undefined
let onPromptStarted: () => void = () => undefined
let onImageEncodingStarted: () => void = () => undefined
let imageGate: Promise<void> | undefined
let newWorktreeDirectory = "/repo/main/new"
let promptResets = 0
let currentPathname = "/repo/main/session"

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
let sessionPromptValue: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
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
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: (scope?: PromptScope) => (scope && "id" in scope && scope.id ? (sessionPrompt ?? prompt) : prompt),
}

let sessionPrompt: typeof prompt | undefined
sessionPrompt = {
  ...prompt,
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
            id: `session-${createdSessions.length}`,
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
          await promptGate
          if (promptError) throw promptError
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
    useLocation: () => ({ get pathname() { return currentPathname } }),
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
        get: () => undefined,
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
        set: () => undefined,
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
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
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
  permissionServer = "server-a"
  createSessionGate = undefined
  createWorktreeGate = undefined
  promptGate = undefined
  promptError = undefined
  sessionCreateError = undefined
  worktreeCreateError = undefined
  worktreeCreateReady = true
  onPromptStarted = () => undefined
  onImageEncodingStarted = () => undefined
  imageGate = undefined
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

describe("prompt submit worktree selection", () => {
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
