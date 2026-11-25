import { GlobalProjectList } from "@/server/global-project-list"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ProjectAppearanceApi } from "../groups/project-appearance"

export const projectAppearanceHandlers = HttpApiBuilder.group(ProjectAppearanceApi, "project-appearance", (handlers) =>
  Effect.gen(function* () {
    const projects = yield* GlobalProjectList.Service
    return handlers
      .handle("get", () =>
        projects.getAppearance().pipe(Effect.mapError(() => new HttpApiError.InternalServerError({}))),
      )
      .handle("patch", (ctx) =>
        projects.patchAppearance(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({}))),
      )
  }),
)
