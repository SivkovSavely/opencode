import { createEffect, createMemo, onCleanup, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const desktop = createMediaQuery("(min-width: 768px)")
  const vertical = createMemo(() => desktop() && settings.appearance.tabPosition() === "left")
  const [state, setState] = createStore({
    debugTools: true,
    tabsMount: undefined as HTMLDivElement | undefined,
    width: 0,
  })
  let root!: HTMLDivElement
  const maximumWidth = createMemo(() => Math.max(196, Math.min(640, state.width - 480)))
  const sidebarWidth = createMemo(() => Math.min(settings.appearance.tabSidebarWidth(), maximumWidth()))

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setState("width", entry.contentRect.width))
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      ref={root}
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        tabsMount={vertical() ? state.tabsMount : undefined}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div class="flex flex-1 min-h-0 min-w-0">
        <Show when={vertical()}>
          <aside
            data-slot="titlebar-tabs-sidebar"
            class="relative flex shrink-0 min-h-0 min-w-0 flex-col border-e border-v2-border-border-muted"
            style={{ width: `${sidebarWidth()}px` }}
          >
            <div ref={(el) => setState("tabsMount", el)} class="flex flex-1 min-h-0 min-w-0 flex-col p-2" />
            <ResizeHandle
              direction="horizontal"
              edge="end"
              size={sidebarWidth()}
              min={196}
              max={maximumWidth()}
              onResize={settings.appearance.setTabSidebarWidth}
              role="separator"
              tabIndex={0}
              aria-label={language.t("settings.appearance.tabSidebar.resize")}
              aria-orientation="vertical"
              aria-valuemin={196}
              aria-valuemax={maximumWidth()}
              aria-valuenow={sidebarWidth()}
              class="before:absolute before:inset-y-0 before:start-1/2 before:w-px before:bg-v2-border-border-muted after:bg-v2-border-border-base focus-visible:outline-none focus-visible:after:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
                const step = event.shiftKey ? 50 : 10
                const next =
                  event.key === "Home"
                    ? 196
                    : event.key === "End"
                      ? maximumWidth()
                      : event.key === "ArrowRight"
                        ? sidebarWidth() + (rtl ? -step : step)
                        : event.key === "ArrowLeft"
                          ? sidebarWidth() + (rtl ? step : -step)
                          : undefined
                if (next === undefined) return
                event.preventDefault()
                event.stopPropagation()
                settings.appearance.setTabSidebarWidth(Math.max(196, Math.min(maximumWidth(), next)))
              }}
            />
          </aside>
        </Show>
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
      </div>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
