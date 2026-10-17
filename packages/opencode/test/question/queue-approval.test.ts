import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { SessionQueue } from "@/session/queue"
import { Question } from "@/question"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, Session.node, SessionQueue.node, SessionProjector.node])),
)
const question: Question.Info = {
  header: "Build Agent",
  question: "Plan at plans/test.md is complete. Would you like to switch to the build agent and start implementing?",
  custom: false,
  options: [
    { label: "Yes", description: "Switch" },
    { label: "No", description: "Stay" },
  ],
}

it.instance("only auto-declines the exact switch prompt with actionable queued backlog", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const queue = yield* SessionQueue.Service
    const questions = yield* Question.Service
    const session = yield* sessions.create({})
    yield* queue.enqueue(session.id, {
      id: "queue-plan-approval",
      payload: { kind: "shell", agent: "plan", model: { providerID: "test", modelID: "test" }, command: "pwd" },
    })
    expect(yield* questions.ask({ sessionID: session.id, questions: [question] })).toEqual([["No"]])
    expect(yield* questions.list()).toEqual([])

    const pending = Effect.fnUntraced(function* (input: readonly Question.Info[]) {
      const fiber = yield* questions.ask({ sessionID: session.id, questions: input }).pipe(Effect.forkScoped)
      const request = yield* pollWithTimeout(
        questions.list().pipe(Effect.map((items) => items[0])),
        "question not published",
      )
      yield* questions.reply({ requestID: request.id, answers: [["Yes"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["Yes"]])
    })
    yield* pending([{ ...question, header: "Other" }])
    yield* pending([{ ...question, question: "Should we switch to the build agent later?" }])
    yield* pending([question, question])
    const snapshot = yield* queue.list(session.id)
    yield* queue.update(session.id, { revision: snapshot.revision, mutation: { action: "pause", paused: true } })
    yield* pending([question])
    const paused = yield* queue.list(session.id)
    yield* queue.update(session.id, { revision: paused.revision, mutation: { action: "pause", paused: false } })
    yield* queue.block(session.id)
    yield* pending([question])
    yield* queue.unblock(session.id)
    const item = yield* queue.claimNext(session.id)
    if (!item) return yield* Effect.die("Missing queued item")
    yield* queue.delivered(session.id, item.id)
    yield* pending([question])
    const steer = yield* queue.enqueue(session.id, {
      id: "plan-approval-steer-only",
      payload: {
        kind: "prompt",
        agent: "plan",
        model: { providerID: "test", modelID: "test" },
        parts: [{ type: "text", text: "steer" }],
      },
    })
    yield* queue.update(session.id, {
      revision: steer.revision,
      mutation: { action: "convert", id: "plan-approval-steer-only", delivery: "steer" },
    })
    yield* pending([question])
  }),
)
