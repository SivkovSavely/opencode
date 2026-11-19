import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { serverName } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { DialogRuntimeLifecycle } from "./dialog-runtime-lifecycle"

export function ServerLifecycleCommands() {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({ reloading: false })
  const [status] = createResource(
    () => serverSDK().server,
    async () => (await serverSDK().client.global.runtime()).data,
  )

  const run = (action: "restart" | "shutdown") => {
    const sdk = serverSDK()
    if (status()?.lineage === "unavailable" || (action === "restart" && status()?.restartSupported === false)) {
      void platform.notify(language.t("command.runtime.restart"), language.t("dialog.runtime.unsupported"))
      return
    }
    dialog.show(() => (
      <DialogRuntimeLifecycle
        action={action}
        server={serverName(sdk.server)}
        request={async () => {
          if (action === "restart") await sdk.client.global.runtime2.restart()
          else await sdk.client.global.runtime2.shutdown()
        }}
        onAccepted={() => {
          void platform.notify(language.t(`command.runtime.${action}`), language.t(`dialog.runtime.accepted.${action}`))
        }}
      />
    ))
  }

  const reload = async () => {
    if (state.reloading) return
    const sdk = serverSDK()
    setState("reloading", true)
    await sdk.client["client"]
      .post<true, unknown, true>({ url: "/global/config/reload", throwOnError: true })
      .then((result) => {
        if (result.data !== true) throw new Error()
        showToast({ variant: "success", title: language.t("toast.config.reloaded.title") })
      })
      .catch((error: unknown) => {
        const body =
          error instanceof Error && error.cause && typeof error.cause === "object" && "body" in error.cause
            ? error.cause.body
            : error
        const message =
          body !== null &&
          typeof body === "object" &&
          "_tag" in body &&
          body._tag === "ConfigReloadError" &&
          "kind" in body &&
          (body.kind === "invalid" || body.kind === "busy" || body.kind === "internal") &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : language.t("toast.config.reloadFailed.description")
        showToast({ variant: "error", title: language.t("toast.config.reloadFailed.title"), description: message })
      })
      .finally(() => setState("reloading", false))
  }

  command.register("runtime-lifecycle", () => [
    {
      id: "config.reload",
      title: language.t("command.config.reload"),
      category: language.t("command.category.system"),
      slash: "reload-config",
      disabled: state.reloading,
      onSelect: reload,
    },
    {
      id: "runtime.restart",
      title: language.t("command.runtime.restart"),
      category: language.t("command.category.system"),
      slash: "restart-server",
      onSelect: () => run("restart"),
    },
    {
      id: "runtime.shutdown",
      title: language.t("command.runtime.shutdown"),
      category: language.t("command.category.system"),
      slash: "shutdown-server",
      onSelect: () => run("shutdown"),
    },
  ])

  return null
}
