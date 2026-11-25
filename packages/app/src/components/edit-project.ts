import { getFilename } from "@opencode-ai/core/util/path"
import { ProjectAppearance } from "@opencode-ai/schema/project-appearance"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { Schema } from "effect"
import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useLanguage } from "@/context/language"
import { errorMessage, getProjectAvatarSource } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

const isAppearance = Schema.is(ProjectAppearance.Fields)

export function createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const initial = {
    name: defaultName(),
    color: props.project.icon?.color,
    iconOverride: props.project.icon?.override,
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
  }
  const [store, setStore] = createStore({ ...initial, iconStatus: undefined as "reading" | "failed" | undefined })
  let startupLoad: Promise<{ id: string; start: string }> | undefined
  let startupEdited = false
  let savedStartup: string | undefined
  let disposed = false
  let iconInput: HTMLInputElement | undefined
  let iconReader: FileReader | undefined

  onCleanup(() => (disposed = true))

  function selectFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    iconReader = reader
    setStore("iconStatus", "reading")
    reader.onloadend = () => {
      if (iconReader !== reader) return
      iconReader = undefined
      if (typeof reader.result !== "string") {
        setStore("iconStatus", "failed")
        return
      }
      setStore({ iconOverride: reader.result, iconHover: false, iconStatus: undefined })
    }
    reader.readAsDataURL(file)
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", false)
    const file = event.dataTransfer?.files[0]
    if (file) selectFile(file)
  }

  function dragOver(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", true)
  }

  function dragLeave() {
    setStore("dragOver", false)
  }

  function inputChange(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (file) selectFile(file)
  }

  function iconClick() {
    if (store.iconOverride) {
      iconReader = undefined
      setStore({ iconOverride: "", iconStatus: undefined })
      return
    }
    iconInput?.click()
  }

  const avatar = () =>
    getProjectAvatarSource(props.project.id, {
      color: store.color,
      url: store.iconOverride === "" || (store.color && store.color !== initial.color) ? "" : props.project.icon?.url,
      override: store.iconOverride,
    })

  const loadFailure = () => language.t("toast.project.reloadFailed.title", { project: defaultName() })

  function loadStartup() {
    return (startupLoad ??= (async () => {
      const { sdk } = serverCtx()
      // Resolving an unknown ID can boot the folder, and current's metadata is an instance-time snapshot.
      const id =
        props.project.id || (await sdk.api.project.current({ location: { directory: props.project.worktree } })).id
      if (!id) throw new Error(loadFailure())
      if (id === "global") return { id, start: initial.startup.trim() }
      const project = (await sdk.api.project.list()).find((item) => item.id === id)
      if (!project) throw new Error(loadFailure())
      const start = project.commands?.start ?? ""
      if (!disposed && !startupEdited) setStore("startup", start)
      return { id, start: start.trim() }
    })().catch((cause) => {
      startupLoad = undefined
      throw cause
    }))
  }

  function focusStartup() {
    if (startupLoad || save.isPending) return
    void loadStartup().catch((cause) => {
      if (disposed || save.isPending) return
      showToast({
        title: language.t("dialog.project.edit.worktree.startup"),
        description: errorMessage(cause, loadFailure()),
      })
    })
  }

  function changeStartup(value: string) {
    startupEdited = true
    setStore("startup", value)
  }

  async function updateStartup(start: string) {
    const { id, start: baseline } = await loadStartup()
    if (start === (savedStartup ?? baseline)) return
    const ctx = serverCtx()
    const { worktree } = props.project
    if (id === "global") {
      ctx.sync.project.meta(worktree, { commands: { start: start || undefined } })
      savedStartup = start
      return
    }
    const failure = language.t("dialog.project.edit.worktree.startup.error")
    if ((await ctx.sdk.protocol) !== "v1") throw new Error(failure)
    const { data, response } = await ctx.sdk.client.project.update({
      projectID: id,
      directory: worktree,
      commands: { start },
    })
    if (!response?.ok || data?.id !== id || (data.commands?.start ?? "") !== start) throw new Error(failure)
    ctx.sync.set("project", (items) => items.map((item) => (item.id === id ? normalizeProjectInfo(data) : item)))
    savedStartup = start
  }

  const save = useMutation(() => ({
    mutationFn: async () => {
      const ctx = serverCtx()
      const { worktree } = props.project
      const name = store.name.trim()
      const patch: ProjectAppearance.Fields = {
        ...(name !== initial.name.trim() && { name: name && name !== folderName() ? name : null }),
        ...(store.color !== initial.color && { color: store.color || null }),
        ...(store.iconOverride !== initial.iconOverride && { icon: store.iconOverride || null }),
      }
      if (store.iconStatus === "failed" || !isAppearance(patch)) {
        throw new Error(language.t("dialog.project.edit.icon.invalid"))
      }

      if (startupEdited) await updateStartup(store.startup.trim())

      if (Object.keys(patch).length) {
        await ctx.appearance.update(worktree, patch).catch((cause) => {
          if (savedStartup === undefined) throw cause
          throw new Error(language.t("dialog.project.edit.appearance.partial"), { cause })
        })
      }
      dialog.close()
    },
    onError: (cause) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      }),
  }))

  const saveDisabled = () => save.isPending || store.iconStatus === "reading"

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (saveDisabled()) return
    save.mutate()
  }

  return {
    store,
    setStore,
    folderName,
    defaultName,
    save,
    saveDisabled,
    avatar,
    submit,
    drop,
    dragOver,
    dragLeave,
    inputChange,
    iconClick,
    focusStartup,
    changeStartup,
    close() {
      dialog.close()
    },
    setIconInput(input: HTMLInputElement) {
      iconInput = input
    },
  }
}
