import { render } from "solid-js/web"
import { Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { checksum } from "@opencode-ai/core/util/encode"
import { SessionReview } from "@opencode-ai/session-ui/session-review"
import { SessionTurn } from "@opencode-ai/session-ui/session-turn"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import FileTree from "@/components/file-tree"
import "@opencode-ai/ui/styles"
import "@opencode-ai/session-ui/styles"

const mode = new URL(location.href).searchParams.get("fixture")
const layout = new URL(location.href).searchParams.get("layout")

function fixture(): ComponentProps<typeof SessionReview>["diffs"] {
  if (mode === "navigation")
    return Array.from({ length: 40 }, (_, index) => ({
      file: `omitted-${index}.png`,
      patch: "",
      additions: 8,
      deletions: 4,
      omitted: { reason: "patch-budget", files: 1 },
    }))
  if (mode === "aggregate") return [{ additions: 21, deletions: 13, omitted: { reason: "input-budget", files: 700 } }]
  if (mode === "unknown") return [{ additions: 21, deletions: 13, omitted: { reason: "input-budget" } }]
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
    return [{ file: "large.ts", patch: "x".repeat(SnapshotDiff.MAX_PATCH_BYTES + 1), additions: 8, deletions: 4 }]
  if (mode === "v2")
    return Array.from({ length: SnapshotDiff.MAX_FILES + 3 }, (_, index) => ({
      file: `src/${index}.ts`,
      before: "old\n",
      after: "new\n",
      additions: 1,
      deletions: 1,
    }))
  return Array.from({ length: SnapshotDiff.MAX_FILES + 3 }, (_, index) => ({
    file: `src/${index}.ts`,
    patch: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
    additions: 1,
    deletions: 1,
  }))
}

const diffs = fixture()
let scroll: HTMLDivElement | undefined
const [store, setStore] = createStore({ open: [] as string[] })
// Only the review's transient open/scroll state is needed by the real mobile/legacy tab.
const view = {
  scroll: () => undefined,
  setScroll: () => {},
  review: {
    open: () => store.open,
    setOpen: (open: string[]) => setStore("open", open),
  },
} as ReturnType<SessionReviewTabProps["view"]>

// Mirror session.tsx's reviewDiffTop/scrollToReviewDiff for the real Changes tree click.
function focusReviewDiff(path: string) {
  setStore("open", [path])
  const root = scroll
  const sum = checksum(path)
  if (!root || !sum) return
  const target = document.getElementById(`session-review-diff-${sum}`)
  if (!(target instanceof HTMLElement) || !root.contains(target)) return
  root.scrollTo({
    top: target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop,
    behavior: "auto",
  })
}

const message: UserMessage = {
  id: "message-fixture",
  sessionID: "session-fixture",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "fixture", modelID: "fixture" },
  summary: { diffs },
}

// Isolate the real summary normalizers from workers, provider state, and any running backend.
render(
  () => (
    <DialogProvider>
      <FileComponentProvider component={() => <div data-testid="diff-widget">Diff ready</div>}>
        <DataProvider
          directory="/fixture"
          data={{
            session: [],
            session_status: {},
            session_diff: {},
            message: { [message.sessionID]: [message] },
            part: {},
          }}
        >
          <Show when={mode === "navigation"}>
            <nav
              aria-label="Changes"
              style={{
                position: "fixed",
                top: "0",
                right: "0",
                width: "220px",
                "max-height": "600px",
                "overflow-y": "auto",
              }}
            >
              <FileTree
                path=""
                allowed={diffs.flatMap((diff) => (diff.file ? [diff.file] : []))}
                draggable={false}
                onFileClick={(node) => focusReviewDiff(node.path)}
              />
            </nav>
          </Show>
          <section
            aria-label="Review"
            style={{
              height: "600px",
              display: "flex",
              "flex-direction": "column",
              width: mode === "navigation" ? "calc(100% - 240px)" : undefined,
            }}
          >
            <Show when={layout} fallback={<SessionReview diffs={diffs} empty={<div>No changes</div>} />}>
              <SessionReviewTab
                diffs={() => diffs}
                snapshot={mode !== "vcs"}
                view={() => view}
                diffStyle={layout === "mobile" ? "unified" : "split"}
                empty={<div>No changes</div>}
                onScrollRef={(el) => (scroll = el)}
              />
            </Show>
          </section>
          <section aria-label="Turn">
            <SessionTurn sessionID={message.sessionID} messageID={message.id} active={false} />
          </section>
        </DataProvider>
      </FileComponentProvider>
    </DialogProvider>
  ),
  document.getElementById("root")!,
)
