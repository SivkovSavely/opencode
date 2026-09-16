import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function DialogRuntimeLifecycle(props: {
  action: "restart" | "shutdown"
  server: string
  request: () => Promise<void>
  onAccepted: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const title = () => language.t(`dialog.runtime.${props.action}.title`)
  const message = () => language.t(`dialog.runtime.${props.action}.message`, { server: props.server })
  const confirm = async () => {
    await props.request()
    dialog.close()
    props.onAccepted()
  }

  return (
    <Dialog title={title()} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="whitespace-pre-line text-14-regular text-text-strong">{message()}</span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={confirm}>
            {language.t(`dialog.runtime.${props.action}.confirm`)}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
