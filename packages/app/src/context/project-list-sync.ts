import { onCleanup } from "solid-js"
import { createServerProjects } from "./server"
import { ServerSDK } from "@/context/server-sdk"

// Bump when the browser-side project list must be re-merged into the server list.
export const PROJECT_LIST_MIGRATION = 1

type ProjectListOperation =
  | { type: "merge"; projects: string[] }
  | { type: "add"; directory: string }
  | { type: "remove"; directory: string }
  | { type: "move"; directory: string; toIndex: number }

type ProjectListResponse = { data?: { projects?: string[] } | undefined }

/**
 * Keeps the browser project list mirrored from the server-global `/global/projects` list.
 *
 * The persisted list stays as a cache/mirror: it renders immediately while the first
 * request is in flight, then becomes authoritative. Local mutations are applied to the
 * cache right away and queued behind initialization so a queued `open()` cannot be
 * silently overwritten by the bootstrap snapshot.
 */
export function createServerProjectSync(input: {
  sdk: ServerSDK
  projects: ReturnType<typeof createServerProjects>
}) {
  const remote = input.sdk.client.global.projects
  // Servers without this endpoint stay local-only: the cached list keeps rendering, the
  // migration marker is never written, and no further requests are attempted this session.
  let available = true
  // Our own mutation response can arrive after a newer server.projects.updated event for a
  // remote change. Counting applied snapshots keeps a stale response from reverting it.
  let revision = 0
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = (task: (at: number) => Promise<void>) => {
    if (!available) return
    // Captured before the request is issued rather than when it runs: a snapshot that
    // lands while a request is in flight is at least as new as that response, so the
    // response must not replace it.
    const at = revision
    queue = queue
      .then(async () => {
        // Re-checked at run time: a bootstrap failure earlier in the chain must stop
        // every later mutation for this server.
        if (!available) return
        await task(at)
      })
      .catch((error) => {
        available = false
        console.error("[project-sync] added project list request failed", error)
      })
  }

  const reconcile = async (request: Promise<ProjectListResponse>, at: number) => {
    const projects = (await request).data?.projects
    if (!projects) return
    if (revision === at) input.projects.replace(projects)
    return projects
  }

  const bootstrap = () =>
    enqueue(async (at) => {
      if (input.projects.migrated(PROJECT_LIST_MIGRATION)) {
        await reconcile(remote.list(), at)
        return
      }
      // First run for this browser/server scope: union the legacy browser list into the
      // server list, then adopt the returned server order. The marker is only written
      // after the merge actually returns a list, so a failed or unusable bootstrap
      // retries instead of dropping local-only projects.
      const merged = await reconcile(
        remote.update({
          body: { type: "merge", projects: input.projects.list().map((project) => project.worktree) },
        }),
        at,
      )
      if (merged) input.projects.markMigrated(PROJECT_LIST_MIGRATION)
    })

  const send = (operation: ProjectListOperation) =>
    enqueue(async (at) => {
      await reconcile(remote.update({ body: operation }), at)
    })

  onCleanup(
    input.sdk.event.on("global", (event) => {
      if (event.type !== "server.projects.updated") return
      // Remote changes are not user closes, so they must not reach recentlyClosed.
      revision++
      input.projects.replace(event.properties.projects)
    }),
  )

  bootstrap()

  return { send }
}
