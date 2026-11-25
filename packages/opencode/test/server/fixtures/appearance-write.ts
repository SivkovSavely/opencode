import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { GlobalProjectList } from "@/server/global-project-list"

const failure = await Effect.runPromise(
  Effect.gen(function* () {
    const list = yield* GlobalProjectList.Service
    return yield* Effect.flip(list.patchAppearance({ directory: "/a", appearance: { name: "a".repeat(8192) } }))
  }).pipe(Effect.provide(LayerNode.compile(GlobalProjectList.node))),
)
const cause = failure._tag === "PlatformError" ? failure.reason.cause : "cause" in failure ? failure.cause : undefined
console.log(cause ?? failure)
