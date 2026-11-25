import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

export const path = "/global/project-appearance"
export const updated = "server.project-appearance.updated"

// Mirrors the Web pathKey rules also used for project-list deduplication.
export function directoryKey(input: string) {
  const value = input[1] === ":" || input.startsWith("\\\\") ? input.replaceAll("\\", "/") : input
  const trimmed = value.replace(/\/+$/, "")
  if (!trimmed) return value.startsWith("/") ? "/" : trimmed
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + "/"
  return trimmed
}

const Directory = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim() && !value.includes("\0") && !/^__proto__\/*$/.test(value) ? undefined : "Invalid project directory",
  ),
)
const isDirectory = Schema.is(Directory)
const DirectoryInput = Schema.String.check(
  Schema.makeFilter((value) => (isDirectory(directoryKey(value)) ? undefined : "Invalid project directory")),
)

// FileReader returns a base64 image data URL. Limit the encoded value, including its prefix.
const Icon = Schema.String.check(
  Schema.isMaxLength(8 * 1024 * 1024),
  Schema.makeFilter((value) =>
    /^data:image\/[a-z0-9!#$%&'*+.^_`|~-]+;base64,[a-z0-9+/]+={0,2}(?![\s\S])/i.test(value) &&
    (value.length - value.indexOf(",") - 1) % 4 === 0
      ? undefined
      : "Expected a base64 image data URL",
  ),
)

// An omitted override inherits the default; null explicitly clears it.
export interface Fields extends Schema.Schema.Type<typeof Fields> {}
export const Fields = Schema.Struct({
  name: optional(Schema.NullOr(Schema.String)),
  icon: optional(Schema.NullOr(Icon)),
  color: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "ProjectAppearance.Fields" })

export interface Patch extends Schema.Schema.Type<typeof Patch> {}
export const Patch = Schema.Struct({ directory: DirectoryInput, appearance: Fields }).annotate({
  identifier: "ProjectAppearance.Patch",
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({ revision: NonNegativeInt, entries: Schema.Record(Directory, Fields) }).annotate(
  {
    identifier: "ProjectAppearance.Snapshot",
  },
)

export * as ProjectAppearance from "./project-appearance"
