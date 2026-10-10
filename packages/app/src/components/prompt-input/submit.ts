import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

type ActiveSubmission = {
  abort?: AbortController
  session?: { sessionID: string; api: DirectorySDK["api"]["session"] }
}

type PendingNewSession = {
  projectDirectory: string
  selection: string
  directory: string
  ready?: boolean
  session?: Session
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  forceDefaultVariant?: boolean
  messageID?: string
  optimisticBusy?: boolean
  optimisticAfterSend?: boolean
  signal?: AbortSignal
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const variant = input.forceDefaultVariant ? "default" : input.draft.variant
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    if (input.signal?.aborted) return false
    const ok = await input.before?.()
    if (ok === false || input.signal?.aborted) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

        const files = await Promise.all(
          images.map(async (attachment) => ({
            uri: await blobDataUrl(attachment.blob, attachment.mime),
            name: attachment.filename,
          })),
        )
        if (input.signal?.aborted) {
          setIdle()
          return false
        }

        const messageID = Identifier.ascending("message")
        await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant,
        },
          files,
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  if (input.signal?.aborted) return false
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    if (!input.optimisticAfterSend) add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      variant,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    // A resolved request was admitted even if Stop raced its response.
    if (input.optimisticAfterSend) add()
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  onPreparing?: (value: boolean) => void
  worktreeReadyTimeoutMs?: number
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const location = useLocation()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (scope: DirectorySDK["scope"], sessionID: string) => ScopedKey.from(scope, sessionID)
  const submitting = new Set<string>()
  const activeSubmissions = new Map<string, ActiveSubmission>()
  const pendingNewSessions = new Map<string, PendingNewSession>()

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const waitForCreatedWorktree = async (scope: DirectorySDK["scope"], directory: string, signal: AbortSignal) => {
    const status = WorktreeState.get(scope, directory)
    if (status?.status === "ready") return true
    if (status?.status === "failed") throw new Error(status.message)

    WorktreeState.pending(scope, directory)
    let abortListener: () => void = () => {}
    const aborted = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
      abortListener = () => resolve({ status: "failed", message: "aborted" })
      if (signal.aborted) abortListener()
      else signal.addEventListener("abort", abortListener, { once: true })
    })
    const timeoutMs = input.worktreeReadyTimeoutMs ?? 5 * 60 * 1000
    const timer = { id: undefined as number | undefined }
    const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
      timer.id = window.setTimeout(
        () => resolve({ status: "failed", message: language.t("workspace.error.stillPreparing") }),
        timeoutMs,
      )
    })
    const result = await Promise.race([WorktreeState.wait(scope, directory), aborted, timeout]).finally(() => {
      if (timer.id !== undefined) window.clearTimeout(timer.id)
      signal.removeEventListener("abort", abortListener)
    })
    if (signal.aborted) return false
    if (result.status === "failed") throw new Error(result.message)
    return true
  }

  const abort = async () => {
    const active = activeSubmissions.get(location.pathname)
    if (active?.abort) {
      active.abort.abort()
      input.onAbort?.()
      if (active.session) {
        return active.session.api.interrupt({ sessionID: active.session.sessionID }).catch(() => {})
      }
      return Promise.resolve()
    }

    const sessionID = params.id
    if (!sessionID) {
      if (active?.session) {
        input.onAbort?.()
        return active.session.api.interrupt({ sessionID: active.session.sessionID }).catch(() => {})
      }
      return Promise.resolve()
    }

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sdk().scope, sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .api.session.interrupt({ sessionID })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = (event: Event) => {
    event.preventDefault()
    const sourcePath = location.pathname
    if (submitting.has(sourcePath)) return
    submitting.add(sourcePath)
    const active: ActiveSubmission = {}
    activeSubmissions.set(sourcePath, active)
    return handleSubmitBody(sourcePath, active).finally(() => {
      submitting.delete(sourcePath)
      if (activeSubmissions.get(sourcePath) === active) activeSubmissions.delete(sourcePath)
      if (location.pathname === sourcePath || !activeSubmissions.has(location.pathname)) input.onPreparing?.(false)
    })
  }

  const handleSubmitBody = async (initialPathname: string, active: ActiveSubmission) => {
    const sourceSDK = sdk()
    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.onPreparing?.(true)

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sourceSDK.directory
    const permissionState = permission.currentServerState()
    const removeCreatedWorktree = async (directory: string) => {
      await sourceSDK.client.worktree
        .remove({
          directory: projectDirectory,
          worktreeRemoveInput: { directory },
        })
        .catch((err) =>
          showToast({
            title: language.t("workspace.delete.failed.title"),
            description: errorMessage(err),
          }),
        )
    }
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    const controller = isNewSession && worktreeSelection === "create" ? new AbortController() : undefined
    if (controller) active.abort = controller
    let createdDirectory: string | undefined
    const cleanupCreatedWorktree = async (directory = createdDirectory) => {
      if (!directory) return
      const prepared = pendingNewSessions.get(initialPathname)
      if (prepared?.directory === directory) {
        pendingNewSessions.delete(initialPathname)
      }
      await removeCreatedWorktree(directory)
    }
    const prepared = pendingNewSessions.get(initialPathname)
    const reuse =
      isNewSession &&
      worktreeSelection === "create" &&
      prepared?.projectDirectory === projectDirectory &&
      prepared.selection === worktreeSelection
        ? prepared
        : undefined
    if (!reuse) pendingNewSessions.delete(initialPathname)

    let sessionDirectory = reuse?.directory ?? projectDirectory
    let worktreeReady = reuse?.ready === true

    if (isNewSession) {
      if (worktreeSelection === "create" && !reuse) {
        const createdWorktree = await sourceSDK
          .client.worktree.create(
            { directory: projectDirectory, worktreeCreateInput: { waitUntilReady: true } },
            { signal: controller?.signal },
          )
          .then((x) => x.data)
          .catch((err) => {
            if (controller?.signal.aborted) return undefined
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return null
          })

        if (createdWorktree?.directory) createdDirectory = createdWorktree.directory
        if (controller?.signal.aborted) {
          await cleanupCreatedWorktree()
          return
        }
        if (createdWorktree === null) return
        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        sessionDirectory = createdWorktree.directory
        createdDirectory = sessionDirectory
        worktreeReady = createdWorktree.ready === true
        pendingNewSessions.set(initialPathname, {
          projectDirectory,
          selection: worktreeSelection,
          directory: sessionDirectory,
          ready: worktreeReady,
        })
      }

      if (worktreeSelection === "create" && !worktreeReady) {
        try {
          if (!(await waitForCreatedWorktree(sourceSDK.scope, sessionDirectory, controller!.signal))) {
            await cleanupCreatedWorktree(sessionDirectory)
            return
          }
          worktreeReady = true
          pendingNewSessions.set(initialPathname, {
            projectDirectory,
            selection: worktreeSelection,
            directory: sessionDirectory,
            ready: true,
            session: reuse?.session,
          })
        } catch (err) {
          if (WorktreeState.get(sourceSDK.scope, sessionDirectory)?.status === "failed") {
            await cleanupCreatedWorktree(sessionDirectory)
          }
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: errorMessage(err),
          })
          return
        }
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        serverSync().child(sessionDirectory)
      }
    }

    const sessionApi = sourceSDK.apiForDirectory(sessionDirectory).session
    let session = input.info() ?? reuse?.session
    let createdNewSession = false
    if (!session && isNewSession) {
      const created = await sessionApi
        .create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        })
        .then(normalizeSessionInfo)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        createdNewSession = true
        if (worktreeSelection === "create") {
          pendingNewSessions.set(initialPathname, {
            projectDirectory,
            selection: worktreeSelection,
            directory: sessionDirectory,
            ready: worktreeReady,
            session: created,
          })
        }
      }
    }
    if (controller?.signal.aborted) {
      if (createdNewSession && session) {
        await sessionApi.remove({ sessionID: session.id, directory: sessionDirectory }).catch(() => {})
        pendingNewSessions.set(initialPathname, {
          projectDirectory,
          selection: worktreeSelection,
          directory: sessionDirectory,
        })
      }
      return
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const forceDefaultVariant = !!sync().session.get(session.id)?.parentID && variant === undefined
    const deferNewWorktreeNavigation = isNewSession && worktreeSelection === "create"
    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const interruptStoppedSubmission = async () => {
      if (!active.abort?.signal.aborted) return
      await sessionApi.interrupt({ sessionID: session.id }).catch(() => {})
    }
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = (preserveChanges = false) => {
      if (!submission.clear(preserveChanges)) return false
      input.setMode("normal")
      input.setPopover(null)
      return true
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    const promoteSession = async () => {
      if (!isNewSession) return
      if (deferNewWorktreeNavigation) {
        if (location.pathname !== initialPathname) {
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent.name,
            model: { providerID: currentModel.provider.id, modelID: currentModel.id },
            variant: variant ?? null,
          })
          clearInput(true)
          if (pendingNewSessions.get(initialPathname)?.session?.id === session.id) {
            pendingNewSessions.delete(initialPathname)
          }
          return
        }
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
        for (const item of commentItems) {
          const current = submission.target().context.items().find((candidate) => candidate.key === item.key)
          if (current && JSON.stringify(current) === JSON.stringify(item)) {
            submission.target().context.remove(item.key)
          }
        }
        clearInput(true)
      } else {
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
      }

      await startTransition(() => {
        if (shouldAutoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id, {
          agent: currentAgent.name,
          model: { providerID: currentModel.provider.id, modelID: currentModel.id },
          variant: variant ?? null,
        })
        if (deferNewWorktreeNavigation && location.pathname !== initialPathname) return
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        const draftID = search.draftId
        if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      })
      input.onNewSessionWorktreeReset?.()
      if (pendingNewSessions.get(initialPathname)?.session?.id === session.id) {
        pendingNewSessions.delete(initialPathname)
      }
    }

    if (isNewSession && !deferNewWorktreeNavigation) await promoteSession()

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      if (!deferNewWorktreeNavigation) clearInput()
      const eventID = Event.ID.create()
      if (deferNewWorktreeNavigation) active.session = { sessionID: session.id, api: sessionApi }
      try {
        if (active.abort?.signal.aborted) return
        await sessionApi.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        await interruptStoppedSubmission()
        if (deferNewWorktreeNavigation) await promoteSession()
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.shellSendFailed.title"),
          description: errorMessage(err),
        })
        if (!deferNewWorktreeNavigation) restoreInput()
      }
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        if (!deferNewWorktreeNavigation) clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        if (deferNewWorktreeNavigation) active.session = { sessionID: session.id, api: sessionApi }
        try {
          const files = await Promise.all(
            images.map(async (attachment) => ({
              uri: await blobDataUrl(attachment.blob, attachment.mime),
              name: attachment.filename,
            })),
          )
          if (active.abort?.signal.aborted) return
          await sessionApi.command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: {
              id: model.modelID,
              providerID: model.providerID,
              variant: forceDefaultVariant ? "default" : variant,
            },
            files,
          })
          await interruptStoppedSubmission()
          if (deferNewWorktreeNavigation) await promoteSession()
        } catch (err) {
          serverSync().session.set("session_status", session.id, { type: "idle" })
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: formatServerError(err, language.t, language.t("common.requestFailed")),
          })
          if (!deferNewWorktreeNavigation) restoreInput()
        }
        return
      }
    }

    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    if (!deferNewWorktreeNavigation) {
      for (const item of commentItems) submission.target().context.remove(item.key)
      clearInput()
    }

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sourceSDK.scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput() && !deferNewWorktreeNavigation) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(sourceSDK.scope, session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sourceSDK.scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(sourceSDK.scope, session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    if (deferNewWorktreeNavigation) active.session = { sessionID: session.id, api: sessionApi }
    try {
      const sent = await sendFollowupDraft({
        api: sessionApi,
        sync: sync(),
        serverSync: serverSync(),
        draft,
        forceDefaultVariant,
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory || deferNewWorktreeNavigation,
        optimisticAfterSend: deferNewWorktreeNavigation,
        signal: active.abort?.signal,
        before: deferNewWorktreeNavigation ? undefined : waitForWorktree,
      })
      if (!sent) return
      await interruptStoppedSubmission()
      if (deferNewWorktreeNavigation) await promoteSession()
    } catch (err) {
      pending.delete(pendingKey(sourceSDK.scope, session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (!deferNewWorktreeNavigation && restoreInput()) restoreCommentItems(submission.target(), commentItems)
    }
  }

  return {
    abort,
    handleSubmit,
  }
}
