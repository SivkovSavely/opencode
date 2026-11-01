import { Effect, Schema } from "effect"
import { Tool } from "./tool"

export const CompressTool = Tool.define(
  "compress",
  Effect.succeed({
    description:
      "Compress the current conversation when older context is large or no longer needed. Queues a durable native compaction request; after this tool turn completes, the same tracked session runner summarizes history and continues with the retained recent context. Preserves structured history and does not delete transcript records. Does not spawn a background summarizer, delegate work, or read or write arbitrary files. No summary or message ranges are required.",
    parameters: Schema.Struct({}),
    execute: (_params, ctx) =>
      Effect.gen(function* () {
        const request = ctx.extra?.requestCompaction as (() => Effect.Effect<void>) | undefined
        if (!request || !ctx.managedRuntime || ctx.executionFence === undefined)
          return yield* Effect.die(new Error("Compression requires a tracked session runner"))
        if (ctx.abort.aborted) return yield* Effect.interrupt
        yield* request()
        return {
          title: "Context compression queued",
          metadata: { queued: true },
          output:
            "Native context compression queued. The same session runner will summarize history before the next normal provider turn.",
        }
      }),
  }),
)
