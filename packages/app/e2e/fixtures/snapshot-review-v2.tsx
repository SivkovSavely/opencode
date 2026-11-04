import { createEffect, Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { SessionReviewFilePreviewV2 } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { PlatformProvider } from "@/context/platform"
import { LanguageProvider } from "@/context/language"
import { ReviewPanelV2 } from "@/pages/session/v2/review-panel-v2"
import { createReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"
import "@opencode-ai/ui/styles"
import "@opencode-ai/session-ui/styles"

const mode = new URL(location.href).searchParams.get("fixture")

function fixture(): ReturnType<ComponentProps<typeof ReviewPanelV2>["diffs"]> {
  if (mode === "focus")
    return [
      {
        file: "src/omitted.png",
        patch: "",
        status: "modified",
        additions: 8,
        deletions: 4,
        omitted: { reason: "patch-budget", files: 1 },
      },
      {
        file: "src/next.ts",
        patch: "diff --git a/next.ts b/next.ts\n--- a/next.ts\n+++ b/next.ts\n@@ -1 +1 @@\n-old\n+new\n",
        additions: 1,
        deletions: 1,
      },
    ]
  if (mode === "aggregate") return [{ additions: 21, deletions: 13, omitted: { reason: "input-budget", files: 700 } }]
  if (mode === "unknown") return [{ additions: 0, deletions: 0, omitted: { reason: "input-budget" } }]
  if (mode === "statistics")
    return [
      {
        file: "unknown.png",
        patch: "",
        additions: 0,
        deletions: 0,
        omitted: { reason: "input-budget", files: 1, statisticsIncomplete: true },
      },
    ]
  if (mode === "patch")
    return [{ file: "large.png", patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1), additions: 8, deletions: 4 }]
  if (mode === "v2")
    return Array.from({ length: 207 }, (_, index) => ({
      file: `src/${index}.ts`,
      before: "old\n",
      after: "new\n",
      additions: 1,
      deletions: 1,
    }))
  return Array.from({ length: 207 }, (_, index) => ({
    file: `src/${index}.ts`,
    patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
    additions: 1,
    deletions: 1,
  }))
}

function DiffWidget(props: { media?: { path: string; readFile?: (path: string) => Promise<unknown> } }) {
  createEffect(() => {
    if (!props.media?.path.endsWith(".png")) return
    void props.media.readFile?.(props.media.path)
  })
  return <div data-testid="diff-widget">Diff ready</div>
}

function Fixture() {
  const diffs = fixture()
  const state = createReviewPanelV2State()
  const [store, setStore] = createStore({
    active: (mode === "focus" ? "src/next.ts" : undefined) as string | undefined,
    focused: null as ComponentProps<typeof ReviewPanelV2>["focusedComment"],
    detailLoads: 0,
    previewReads: 0,
  })
  const named = () => diffs.find((diff): diff is (typeof diffs)[number] & { file: string } => !!diff.file)

  return (
    <FileComponentProvider component={DiffWidget}>
      <output data-testid="detail-load-count">{store.detailLoads}</output>
      <output data-testid="preview-read-count">{store.previewReads}</output>
      <Show when={mode === "focus"}>
        <button onClick={() => setStore("focused", { file: "src/omitted.png", id: "omitted-comment" })}>
          Focus omitted comment
        </button>
        <output data-testid="focused-comment">{store.focused?.file ?? "none"}</output>
      </Show>
      <section aria-label="Default Review" style={{ height: "600px", display: "flex", "flex-direction": "column" }}>
        <ReviewPanelV2
          title="Changes"
          empty={<div>No file changes</div>}
          diffs={() => diffs}
          snapshot={mode !== "vcs"}
          diffsReady={() => true}
          activeFile={store.active}
          onSelectFile={(file) => setStore("active", file)}
          comments={[
            {
              file: "src/omitted.png",
              id: "omitted-comment",
              comment: "Review this omitted file",
              selection: { start: 1, end: 1 },
            },
          ]}
          focusedComment={store.focused}
          onFocusedCommentChange={(focus) => {
            if (!focus && store.focused) setStore("active", store.focused.file)
            setStore("focused", focus)
          }}
          diffStyle="unified"
          state={state}
          loadDiff={async () => {
            setStore("detailLoads", (count) => count + 1)
            return undefined
          }}
        />
      </section>
      <Show when={(mode === "statistics" || mode === "patch") && named()}>
        {(diff) => (
          <section aria-label="Direct Preview">
            <SessionReviewFilePreviewV2
              file={diff().file}
              diff={diff()}
              diffStyle="unified"
              readFile={async () => {
                setStore("previewReads", (count) => count + 1)
                return undefined
              }}
            />
          </section>
        )}
      </Show>
    </FileComponentProvider>
  )
}

// Only language and transient review state are real providers; SDK and tree I/O are isolated by the spec.
render(
  () => (
    <PlatformProvider
      value={{ platform: "web", openExternal: () => {}, restart: async () => {}, notify: async () => {} }}
    >
      <LanguageProvider locale="en">
        <Fixture />
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
