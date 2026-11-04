// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SnapshotDiff } from "@opencode-ai/core/snapshot-diff"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer, Stream } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

// Replay identity and durable storage stay untouched; only transport views are bounded.
function bounded<D extends EventV2.Definition>(event: EventV2.Payload<D>): EventV2.Payload<D> {
  if (event.type === SessionV1.Event.MessageUpdated.type) {
    const data = event.data as typeof SessionV1.Event.MessageUpdated.data.Type
    if (data.info.role !== "user" || !data.info.summary) return event
    return {
      ...event,
      data: {
        ...data,
        info: {
          ...data.info,
          summary: { ...data.info.summary, diffs: SnapshotDiff.limit(data.info.summary.diffs) },
        },
      } as EventV2.Data<D>,
    }
  }
  if (
    event.type === SessionV1.Event.Created.type ||
    event.type === SessionV1.Event.Updated.type ||
    event.type === SessionV1.Event.Deleted.type
  ) {
    const data = event.data as typeof SessionV1.Event.Updated.data.Type
    if (!data.info.summary?.diffs) return event
    return {
      ...event,
      data: {
        ...data,
        info: {
          ...data.info,
          summary: { ...data.info.summary, diffs: SnapshotDiff.limit(data.info.summary.diffs) },
        },
      } as EventV2.Data<D>,
    }
  }
  if (event.type === SessionV1.Event.Diff.type) {
    const data = event.data as typeof SessionV1.Event.Diff.data.Type
    return { ...event, data: { ...data, diff: SnapshotDiff.limit(data.diff) } as EventV2.Data<D> }
  }
  return event
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const withLocation = (options?: EventV2.PublishOptions) =>
      Effect.gen(function* () {
        if (options?.location) return options
        const ctx = yield* InstanceRef
        if (!ctx) return options
        const workspaceID = yield* WorkspaceRef
        return {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        }
      })

    const record: EventV2.Interface["record"] = (definition, data, options) =>
      withLocation(options).pipe(Effect.flatMap((options) => events.record(definition, data, options)))

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      withLocation(options).pipe(Effect.flatMap((options) => events.publish(definition, data, options)))

    const unsubscribe = yield* events.listen((input) =>
      Effect.gen(function* () {
        const event = bounded(input)
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              // Sync must preserve canonical data for exact duplicate replay comparison.
              data: input.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({
      ...events,
      record,
      publish,
      listen: (listener) => events.listen((event) => listener(bounded(event))),
      all: () => events.all().pipe(Stream.map(bounded)),
      subscribe: (definition) => events.subscribe(definition).pipe(Stream.map(bounded)),
      durable: (input) => events.durable(input).pipe(Stream.map(bounded)),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
