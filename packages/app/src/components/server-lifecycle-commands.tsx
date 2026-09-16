import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createResource } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { serverName } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { DialogRuntimeLifecycle } from "./dialog-runtime-lifecycle"

export function ServerLifecycleCommands() {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
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

  command.register("runtime-lifecycle", () => [
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
