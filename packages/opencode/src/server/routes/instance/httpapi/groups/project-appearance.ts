import { ProjectAppearance } from "@opencode-ai/schema/project-appearance"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { SchemaErrorMiddleware } from "../middleware/schema-error"

// The browser calls this directly; it is not part of RootHttpApi or the public API.
export const ProjectAppearanceApi = HttpApi.make("project-appearance").add(
  HttpApiGroup.make("project-appearance")
    .add(
      HttpApiEndpoint.get("get", ProjectAppearance.path, {
        success: ProjectAppearance.Snapshot,
        error: HttpApiError.InternalServerError,
      }),
      HttpApiEndpoint.patch("patch", ProjectAppearance.path, {
        payload: ProjectAppearance.Patch,
        success: ProjectAppearance.Snapshot,
        error: HttpApiError.InternalServerError,
      }),
    )
    .middleware(SchemaErrorMiddleware)
    .middleware(Authorization),
)
