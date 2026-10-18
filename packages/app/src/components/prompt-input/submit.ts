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
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"
import { QueueCommand } from "@opencode-ai/schema/queue-command"
import { queuePayload, QueuePayloadError } from "./queue-payload"
import { Schema } from "effect"
import { SessionQueueV1 } from "@opencode-ai/schema/v1/session-queue"
import { queuePreview } from "@/utils/session-queue"

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
  onManageQueue?: () => void
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
  const queueRetries = new Map<string, { id: string; signature: string }>()
  const destinationKey = () => JSON.stringify([location.pathname, search.draftId])

  const errorMessage = (err: unknown) => {
    if (err instanceof QueuePayloadError) return language.t(err.key)
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
    const active = activeSubmissions.get(destinationKey())
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

  const handleSubmit = (event: Event, delivery: "steer" | "queue" = "steer") => {
    event.preventDefault()
    const draftID = search.draftId
    const sourceKey = destinationKey()
    if (submitting.has(sourceKey)) return
    submitting.add(sourceKey)
    const active: ActiveSubmission = {}
    activeSubmissions.set(sourceKey, active)
    return handleSubmitBody(draftID, sourceKey, active, delivery).finally(() => {
      submitting.delete(sourceKey)
      if (activeSubmissions.get(sourceKey) === active) activeSubmissions.delete(sourceKey)
      if (destinationKey() === sourceKey || !activeSubmissions.has(destinationKey())) input.onPreparing?.(false)
    })
  }

  const handleSubmitBody = async (
    initialDraftID: string | undefined,
    initialKey: string,
    active: ActiveSubmission,
    delivery: "steer" | "queue",
  ) => {
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
    const queueCommand =
      mode === "normal"
        ? QueueCommand.parse(text, currentPrompt.some((part) => part.type !== "text") || context.length > 0)
        : undefined

    if (queueCommand && queueCommand.type !== "enqueue") {
      if (queueCommand.type === "error") {
        showToast({ title: language.t("queue.invalid") })
        return
      }
      if (!params.id) {
        showToast({ title: language.t("queue.sessionRequired") })
        return
      }
      if (queueCommand.type === "manage") {
        input.onManageQueue?.()
        if (submission.clear(true)) input.setPopover(null)
        return
      }
      try {
        const sessionID = params.id
        const directory = sourceSDK.directory
        const client = sourceSDK.client.session
        const snapshot = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(
          (await client.queueList({ sessionID, directory })).data,
        )
        if (queueCommand.type === "list") {
          const queued = snapshot.items
            .filter((item) => item.delivery === "queue" && item.state === "pending")
            .sort((a, b) => a.position - b.position)
          const previews = queued.slice(0, 3).map((item, index) => {
            const payload = item.payload
            const files =
              payload.kind === "prompt" || payload.kind === "command"
                ? (payload.parts?.flatMap((part) => (part.type === "file" ? [part.filename ?? part.mime] : [])) ?? [])
                : []
            const preview = [queuePreview(payload, language.t("queue.compact")), ...files]
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
            return `${index + 1}. ${preview.length > 80 ? `${preview.slice(0, 77)}...` : preview}`
          })
          showToast({
            title: language.t("queue.title"),
            description: [
              language.plural("queue.list", queued.length),
              ...(queued.length ? previews : [language.t("queue.empty")]),
              ...(queued.length > previews.length ? [language.t("queue.list.more")] : []),
            ].join("\n"),
            multiline: true,
            duration: 10000,
            actions: input.onManageQueue
              ? [
                  {
                    label: language.t("queue.manage"),
                    onClick: () => {
                      if (destinationKey() !== initialKey || params.id !== sessionID || sdk().directory !== directory)
                        return
                      input.onManageQueue?.()
                    },
                  },
                ]
              : [],
          })
        }
        if (queueCommand.type === "flush") await client.queueFlush({ sessionID, directory })
        if (queueCommand.type === "start" || queueCommand.type === "stop")
          await client.queueUpdate({
            sessionID,
            directory,
            revision: snapshot.revision,
            mutation: { action: "pause", paused: queueCommand.type === "stop" },
          })
        if (queueCommand.type === "clear") {
          const queued = snapshot.items
            .filter((item) => item.delivery === "queue" && item.state === "pending")
            .sort((a, b) => a.position - b.position)
          if (queueCommand.indices.some((index) => !queued[index - 1])) throw new Error(language.t("queue.invalid"))
          if (!queueCommand.indices.length)
            await client.queueUpdate({
              sessionID,
              directory,
              revision: snapshot.revision,
              mutation: { action: "clear" },
            })
          let revision = snapshot.revision
          for (const index of queueCommand.indices) {
            const result = await client.queueUpdate({
              sessionID,
              directory,
              revision,
              mutation: { action: "delete", id: queued[index - 1]!.id },
            })
            revision = Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(result.data).revision
          }
        }
        if (submission.clear(true)) input.setPopover(null)
      } catch (error) {
        showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) })
      }
      return
    }

    if (text.trim().length === 0 && !currentPrompt.some((part) => part.type !== "text") && context.length === 0) {
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
    const model = { modelID: currentModel.id, providerID: currentModel.provider.id }
    const agent = currentAgent.name

    const enqueue = delivery === "queue" || queueCommand?.type === "enqueue"
    const steering = !enqueue && input.working()
    if (!enqueue) input.onPreparing?.(true)

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
      const prepared = pendingNewSessions.get(initialKey)
      if (prepared?.directory === directory) {
        pendingNewSessions.delete(initialKey)
      }
      await removeCreatedWorktree(directory)
    }
    const prepared = pendingNewSessions.get(initialKey)
    const reuse =
      isNewSession && prepared?.projectDirectory === projectDirectory && prepared.selection === worktreeSelection
        ? prepared
        : undefined
    if (!reuse) pendingNewSessions.delete(initialKey)

    let sessionDirectory = reuse?.directory ?? projectDirectory
    let worktreeReady = reuse?.ready === true

    if (isNewSession) {
      if (worktreeSelection === "create" && !reuse) {
        const createdWorktree = await sourceSDK.client.worktree
          .create(
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
        pendingNewSessions.set(initialKey, {
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
          pendingNewSessions.set(initialKey, {
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
          agent,
          model: { id: model.modelID, providerID: model.providerID, variant },
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
        pendingNewSessions.set(initialKey, {
          projectDirectory,
          selection: worktreeSelection,
          directory: sessionDirectory,
          ready: worktreeReady,
          session: created,
        })
      }
    }
    if (controller?.signal.aborted) {
      if (createdNewSession && session) {
        await sessionApi.remove({ sessionID: session.id, directory: sessionDirectory }).catch(() => {})
        pendingNewSessions.set(initialKey, {
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

    const forceDefaultVariant = !!sync().session.get(session.id)?.parentID && variant === undefined
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
      variant: forceDefaultVariant ? "default" : variant,
    }

    const clearInput = (preserveChanges = false) => {
      if (!submission.clear(preserveChanges)) return false
      input.setMode("normal")
      input.setPopover(null)
      return true
    }

    const promoteSession = async () => {
      if (!isNewSession) return
      if (destinationKey() !== initialKey) {
        local.session.promote(sessionDirectory, session.id, {
          agent,
          model,
          variant: variant ?? null,
        })
        if (clearInput(true) && enqueue) clearContext(submission.target())
        if (pendingNewSessions.get(initialKey)?.session?.id === session.id) {
          pendingNewSessions.delete(initialKey)
        }
        return
      }
      const unchanged = submission.unchanged()
      submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
      if (!enqueue || unchanged) {
        for (const item of commentItems) {
          const current = submission
            .target()
            .context.items()
            .find((candidate) => candidate.key === item.key)
          if (current && JSON.stringify(current) === JSON.stringify(item)) {
            submission.target().context.remove(item.key)
          }
        }
      }
      clearInput(true)
      if (enqueue && unchanged) {
        clearContext(submission.target())
        clearContext(target)
      }

      await startTransition(() => {
        if (shouldAutoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id, {
          agent,
          model,
          variant: variant ?? null,
        })
        if (destinationKey() !== initialKey) return
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        if (initialDraftID)
          tabs.promoteDraft(initialDraftID, { server: tabs.draft(initialDraftID).server, sessionId: session.id })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      })
      input.onNewSessionWorktreeReset?.()
      if (pendingNewSessions.get(initialKey)?.session?.id === session.id) {
        pendingNewSessions.delete(initialKey)
      }
    }

    if (enqueue) {
      try {
        const [head] = text.split(" ")
        const payload = await queuePayload(draft, {
          mode,
          command: queueCommand?.type === "enqueue" ? queueCommand : undefined,
          custom: text.startsWith("/") && sync().data.command.some((item) => item.name === head?.slice(1)),
        })
        const key = ScopedKey.from(sourceSDK.scope, sessionDirectory, session.id, initialKey)
        const front = queueCommand?.type === "enqueue" ? queueCommand.front : undefined
        const signature = JSON.stringify([payload, front])
        const previous = queueRetries.get(key)
        const admission =
          previous?.signature === signature ? previous : { id: Identifier.ascending("message"), signature }
        queueRetries.set(key, admission)
        const result = await sourceSDK.client.session.queueSubmit({
          sessionID: session.id,
          directory: sessionDirectory,
          id: admission.id,
          payload,
          front,
        })
        Schema.decodeUnknownSync(SessionQueueV1.Snapshot)(result.data)
        showToast({ title: language.t("queue.queued"), variant: "success", duration: 3000 })
        if (isNewSession) {
          await promoteSession()
          queueRetries.delete(key)
          return
        }
        // Do not erase edits or a different session's draft while admission was in flight.
        if (clearInput(true)) clearContext(submission.target())
        queueRetries.delete(key)
      } catch (error) {
        showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) })
      }
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      const eventID = Event.ID.create()
      if (isNewSession) active.session = { sessionID: session.id, api: sessionApi }
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
        if (isNewSession) await promoteSession()
        if (!isNewSession) clearInput(true)
      } catch (err) {
        showToast({
          title: language.t("prompt.toast.shellSendFailed.title"),
          description: errorMessage(err),
        })
      }
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        const messageID = Identifier.ascending("message")
        if (!steering) serverSync().session.set("session_status", session.id, { type: "busy" })
        if (isNewSession) active.session = { sessionID: session.id, api: sessionApi }
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
          if (isNewSession) await promoteSession()
          if (!isNewSession) clearInput(true)
        } catch (err) {
          if (!steering) serverSync().session.set("session_status", session.id, { type: "idle" })
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: formatServerError(err, language.t, language.t("common.requestFailed")),
          })
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

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sourceSDK.scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (!steering && sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (!steering && sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
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

    if (isNewSession) active.session = { sessionID: session.id, api: sessionApi }
    try {
      const sent = await sendFollowupDraft({
        api: sessionApi,
        sync: sync(),
        serverSync: serverSync(),
        draft,
        forceDefaultVariant,
        messageID,
        optimisticBusy: !steering && (sessionDirectory === projectDirectory || isNewSession),
        optimisticAfterSend: isNewSession,
        signal: active.abort?.signal,
        before: isNewSession ? undefined : waitForWorktree,
      })
      if (!sent) return
      await interruptStoppedSubmission()
      if (isNewSession) await promoteSession()
      if (!isNewSession && clearInput(true)) {
        for (const item of commentItems) submission.target().context.remove(item.key)
      }
    } catch (err) {
      pending.delete(pendingKey(sourceSDK.scope, session.id))
      if (!steering && sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
    }
  }

  return {
    abort,
    handleSubmit,
  }
}
