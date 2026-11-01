import { ManagedWorkspace } from "@/server/managed-workspace"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// A dedicated managed runtime exposes only the orchestration and attached CLI
// surface. New routes must be reviewed before they become reachable here.
export const managedWorkspaceMiddleware = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      if (!ManagedWorkspace.directory) return yield* effect
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = new URL(request.url, "http://localhost").pathname
      // Managed clients select models explicitly; provider discovery can serialize configured credentials.
      const allowed =
        request.method === "GET"
          ? new Set([
              "/global/health",
              "/global/event",
              "/event",
              "/session",
              "/session/status",
              "/agent",
              "/command",
              "/skill",
              "/experimental/tool",
              "/experimental/tool/ids",
              "/experimental/capabilities",
              "/path",
              "/permission",
              "/question",
              "/maintenance/historical-fence/identity",
            ]).has(path) || /^\/session\/[^/%]+(?:\/children|\/message(?:\/[^/%]+)?)?$/.test(path)
          : request.method === "POST" &&
            (path === "/session" ||
              path === "/maintenance/historical-fence" ||
              /^\/session\/[^/%]+\/(?:prompt_async|message|abort|retire|summarize)$/.test(path) ||
              /^\/permission\/[^/%]+\/reply$/.test(path) ||
              /^\/question\/[^/%]+\/(?:reply|reject)$/.test(path))
      if (allowed) return yield* effect
      return HttpServerResponse.text("Forbidden", { status: 403 })
    }),
  { global: true },
)
