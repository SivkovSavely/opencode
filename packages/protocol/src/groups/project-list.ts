import { ProjectList } from "@opencode/schema/project-list"
import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { ServiceUnavailableError } from "../errors.js"

export const ProjectListEndpoints = [
  HttpApiEndpoint.get("projects.list", "/api/experimental/projects", {
    success: ProjectList.Snapshot,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "experimental.projects.list",
      summary: "List added project directories",
      description:
        "Experimental: may change without compatibility guarantees. Ordered explicit directory membership, separate from project inventory.",
    }),
  ),
  HttpApiEndpoint.patch("projects.update", "/api/experimental/projects", {
    payload: Schema.Struct({ operation: ProjectList.Operation }),
    success: ProjectList.Snapshot,
    error: ServiceUnavailableError,
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "experimental.projects.update",
      summary: "Update added project directories",
      description:
        "Experimental: may change without compatibility guarantees. Serialized add, remove, move or server-first additive merge. Never deletes files, projects or sessions.",
    }),
  ),
] as const
