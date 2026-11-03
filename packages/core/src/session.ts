export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { ManagedCommand } from "./managed-command"
import { SessionActiveSelection } from "./session/active-selection"
import { CommandV2 } from "./command"
import { Catalog } from "./catalog"
import { SessionRunnerModel } from "./session/runner/model"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait", "subtask"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class CommandNotFoundError extends Schema.TaggedErrorClass<CommandNotFoundError>()(
  "Session.CommandNotFoundError",
  {
    command: Schema.String,
  },
) {}
export class InvalidModelError extends Schema.TaggedErrorClass<InvalidModelError>()("Session.InvalidModelError", {
  message: Schema.String,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | SessionInput.Retired

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    NotFoundError | PromptConflictError | InvalidModelError | SessionInput.Retired | SessionInput.ManagedProfile
  >
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments?: string
    agent?: string
    model?: ModelV2.Ref
    selection?: PromptInput.Prompt["selection"]
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | CommandNotFoundError
    | InvalidModelError
    | OperationUnavailableError
    | PromptConflictError
    | SessionInput.Retired
    | SessionInput.ManagedProfile
  >
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const activeSelection = yield* SessionActiveSelection.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: `New session - ${new Date(now).toISOString()}`,
          bookmarked: false,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(
            SessionV1.Event.Created,
            { sessionID, info },
            {
              location: input.location,
              commit: () => ManagedCommand.enrollCreatedRoot(database, sessionID),
            },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        activeSelection.admission(
          input.sessionID,
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* SessionInput.guardManagedProfile
              const session = yield* result.get(input.sessionID)
              const messageID = input.id ?? SessionMessage.ID.create()
              const delivery = input.delivery ?? "steer"
              const existing = yield* SessionInput.find(db, messageID)
              if (existing) {
                if (
                  !SessionInput.equivalent(existing, {
                    sessionID: input.sessionID,
                    delivery,
                    prompt: resolvePrompt(input.prompt, existing.prompt.model),
                  })
                )
                  return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
                yield* SessionInput.admit(db, events, {
                  id: messageID,
                  sessionID: input.sessionID,
                  delivery,
                  prompt: existing.prompt,
                })
                if (input.resume !== false) yield* execution.wake(existing.sessionID)
                return existing
              }
              while (true) {
                const parent = activeSelection.parent(input.sessionID)
                const inherited =
                  input.prompt.selection?.inheritActive && input.delivery !== "queue" ? parent?.model : undefined
                const selected = input.prompt.selection?.model
                const fallback = inherited ?? input.prompt.model ?? session.model
                const defaultModel =
                  !fallback && !selected && input.prompt.selection
                    ? yield* Catalog.Service.use((catalog) => SessionRunnerModel.defaultModel(catalog)).pipe(
                        Effect.provide(locations.get(session.location)),
                      )
                    : undefined
                const base =
                  fallback ??
                  (defaultModel && {
                    id: defaultModel.id,
                    providerID: defaultModel.providerID,
                    variant: defaultModel.variants.find((variant) => variant.id === defaultModel.request.variant)?.id,
                  })
                const chosen = selected
                  ? {
                      id: selected.modelID,
                      providerID: selected.providerID,
                      variant: input.prompt.selection?.variant ?? base?.variant,
                    }
                  : base && { ...base, variant: input.prompt.selection?.variant ?? base.variant }
                const catalogModel = chosen
                  ? yield* Catalog.Service.use((catalog) =>
                      Effect.gen(function* () {
                        return (yield* catalog.model.available()).find(
                          (model) => model.providerID === chosen.providerID && model.id === chosen.id,
                        )
                      }),
                    ).pipe(Effect.provide(locations.get(session.location)))
                  : undefined
                // A terminal provider event may arrive while catalog/plugins are resolving.
                if (activeSelection.parent(input.sessionID) !== parent) continue
                if (chosen && !catalogModel)
                  return yield* new InvalidModelError({
                    message: `Model unavailable: ${chosen.providerID}/${chosen.id}`,
                  })
                if (catalogModel && !SessionRunnerModel.supported(catalogModel))
                  return yield* new InvalidModelError({
                    message: `Unsupported model API: ${catalogModel.providerID}/${catalogModel.id}`,
                  })
                const explicitVariant = input.prompt.selection
                  ? input.prompt.selection.variant
                  : input.prompt.model?.variant
                if (
                  catalogModel &&
                  chosen?.variant &&
                  chosen.variant !== "default" &&
                  !catalogModel.variants.some((variant) => variant.id === chosen.variant)
                ) {
                  if (explicitVariant !== undefined && explicitVariant !== "default")
                    return yield* new InvalidModelError({
                      message: `Variant unavailable for ${chosen.providerID}/${chosen.id}: ${chosen.variant}`,
                    })
                  chosen.variant = undefined
                }
                const prompt = resolvePrompt(
                  input.prompt,
                  catalogModel && chosen && (chosen.variant === undefined || chosen.variant === "default")
                    ? {
                        ...chosen,
                        variant:
                          catalogModel.variants.find((variant) => variant.id === catalogModel.request.variant)?.id ??
                          ModelV2.VariantID.make("default"),
                      }
                    : chosen,
                )
                const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
                const admitted = yield* activeSelection.transition(
                  input.sessionID,
                  Effect.gen(function* () {
                    if (activeSelection.parent(input.sessionID) !== parent) return undefined
                    const admitted = yield* SessionInput.admit(db, events, {
                      id: messageID,
                      sessionID: input.sessionID,
                      prompt,
                      delivery,
                    }).pipe(
                      Effect.catchDefect((defect) =>
                        defect instanceof SessionInput.LifecycleConflict
                          ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                          : Effect.die(defect),
                      ),
                    )
                    if (!SessionInput.equivalent(admitted, expected))
                      return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
                    if (parent && delivery === "steer" && admitted.prompt.model)
                      activeSelection.update(input.sessionID, parent, admitted.prompt.model)
                    return admitted
                  }),
                )
                if (!admitted) continue
                if (input.resume !== false) yield* execution.wake(admitted.sessionID)
                return admitted
              }
            }),
          ),
        ),
      ),
      command: Effect.fn("V2Session.command")(function* (input) {
        yield* SessionInput.guardManagedProfile
        const session = yield* result.get(input.sessionID)
        const command = yield* CommandV2.Service.use((commands) => commands.get(input.command)).pipe(
          Effect.provide(locations.get(session.location)),
        )
        if (!command) return yield* new CommandNotFoundError({ command: input.command })
        if (command.subtask) return yield* new OperationUnavailableError({ operation: "subtask" })
        const args =
          (input.arguments ?? "")
            .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
            ?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? []
        const positions = Array.from(command.template.matchAll(/\$(\d+)/g), (match) => Number(match[1]))
        const last = Math.max(0, ...positions)
        const text =
          command.template.replace(/\$(\d+)|\$ARGUMENTS/g, (_, index) => {
            if (index === undefined) return input.arguments ?? ""
            const position = Number(index)
            return position === last ? args.slice(position - 1).join(" ") : (args[position - 1] ?? "")
          }) +
          (positions.length === 0 && !command.template.includes("$ARGUMENTS") && input.arguments?.trim()
            ? `\n\n${input.arguments}`
            : "")
        if (text.includes("!`")) return yield* new OperationUnavailableError({ operation: "shell" })
        const agent = yield* AgentV2.Service.use((agents) => agents.resolve(command.agent ?? input.agent)).pipe(
          Effect.provide(locations.get(session.location)),
        )
        const commandModel = command.model ?? (command.agent ? agent?.model : undefined)
        const variant = command.variant ?? commandModel?.variant ?? (commandModel && ModelV2.VariantID.make("default"))
        const explicitModel = input.selection?.model
        const commandVariant =
          explicitModel &&
          variant !== undefined &&
          variant !== "default" &&
          (commandModel?.id !== explicitModel.modelID || commandModel.providerID !== explicitModel.providerID)
            ? yield* Catalog.Service.use((catalog) =>
                catalog.model.get(explicitModel.providerID, explicitModel.modelID),
              ).pipe(
                Effect.map((model) => (model?.variants.some((item) => item.id === variant) ? variant : undefined)),
                Effect.provide(locations.get(session.location)),
              )
            : variant
        return yield* result.prompt({
          id: input.id,
          sessionID: input.sessionID,
          delivery: input.delivery,
          resume: input.resume,
          prompt: {
            text: text.trim(),
            files: input.files,
            agents: input.agents,
            agent: command.agent ?? input.agent,
            model: commandModel ?? input.model,
            selection:
              input.selection || commandVariant !== undefined || commandModel
                ? {
                    ...input.selection,
                    model:
                      input.selection?.model ??
                      (commandModel && {
                        providerID: commandModel.providerID,
                        modelID: commandModel.id,
                      }),
                    variant: input.selection?.variant ?? commandVariant,
                  }
                : undefined,
          },
        })
      }),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* SessionInput.guardManagedProfile
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt, model?: ModelV2.Ref) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    agent: input.agent,
    model,
    requestedModel: input.model,
    selection: input.selection,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: file.uri.startsWith("skill:")
          ? "application/x-opencode-skill"
          : (dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target))),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionActiveSelection.node,
  ],
})
