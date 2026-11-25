// Subprocess integration tests for `opencode serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect, Schema } from "effect"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"
import { HttpClient } from "effect/unstable/http"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { awaitWithTimeout, pollWithTimeout } from "../../lib/effect"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

describe("opencode serve (subprocess)", () => {
  cliIt.live(
    "owner loss before pause acknowledgement refuses the exact intent without claiming quiescence or waking",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const env = { OPENCODE_DB: path.join(home, "unacknowledged-pause.sqlite") }
        const release = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        yield* llm.push(
          reply().wait(release.promise).text("Unfinished provider response").stop(),
          reply().text("Must not wake").stop(),
        )
        const first = yield* opencode.serve({ env })
        const sdk = createOpencodeClient({ baseUrl: first.url, directory: home, throwOnError: true })
        const session = (yield* Effect.promise(() => sdk.session.create({ title: "Unacknowledged pause" }))).data
        if (!session) throw new Error("Missing session")
        yield* Effect.promise(() =>
          sdk.session.queueSubmit({
            sessionID: session.id,
            id: "original-input",
            payload: {
              kind: "prompt",
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "Continue the original work" }],
            },
          }),
        )
        yield* llm.wait(1)
        const candidate = (yield* Effect.promise(() => sdk.session.execution({ sessionID: session.id }))).data
          ?.candidate
        if (!candidate) throw new Error("Missing candidate")
        yield* Effect.promise(() =>
          sdk.session.enrollQueueAction({
            sessionID: session.id,
            sessionHandoffV1EnrollRequest: { ...candidate, requestID: "enrollment" },
          }),
        )
        const view = (yield* Effect.promise(() => sdk.session.execution({ sessionID: session.id }))).data
        if (!view?.identity) throw new Error("Missing identity")
        const post = (base: string, route: string, body: unknown) =>
          Effect.promise(() =>
            fetch(`${base}/session/${session.id}/${route}?directory=${encodeURIComponent(home)}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          )
        const request = {
          requestID: "lost-pause",
          expectedDirectory: home,
          expected: view.identity,
          expectedRecoveryRevision: view.recoveryRevision,
        }
        const acceptedResponse = yield* post(first.url, "execution/pause", request)
        expect(acceptedResponse.status).toBe(200)
        const accepted = Schema.decodeUnknownSync(SessionHandoffV1.CooperativePauseReceipt)(
          yield* Effect.promise(() => acceptedResponse.json()),
        )
        expect(accepted.state).toBe("accepted")
        first.kill("SIGKILL")
        yield* awaitWithTimeout(
          Effect.promise(() => first.exited),
          "Isolated Serve did not exit",
          "20 seconds",
        )
        const second = yield* opencode.serve({ env })
        const fresh = createOpencodeClient({ baseUrl: second.url, directory: home, throwOnError: true })
        const refused = yield* pollWithTimeout(
          Effect.gen(function* () {
            const value = (yield* Effect.promise(() =>
              fresh.session.handoffReceipt({ sessionID: session.id, requestID: request.requestID }),
            )).data
            return value?.kind === "cooperative_pause" && value.state === "refused" ? value : undefined
          }),
          "Owner-lost accepted intent was stranded",
          "8 seconds",
        )
        expect(refused).toMatchObject({
          reason: "not_quiet",
          boundaryAssistantMessageID: null,
          pauseRevision: accepted.pauseRevision,
        })
        const retry = yield* post(second.url, "execution/pause", request)
        expect(yield* Effect.promise(() => retry.json())).toEqual(refused)
        const resume = yield* post(second.url, "execution/resume", {
          requestID: "lost-resume",
          pauseRequestID: request.requestID,
          expectedDirectory: home,
          expected: view.identity,
          expectedPauseRevision: accepted.pauseRevision,
        })
        expect(yield* Effect.promise(() => resume.json())).toMatchObject({
          state: "recovery_required",
          reason: "owner_lost",
          resumeFence: null,
        })
        expect((yield* Effect.promise(() => fresh.session.execution({ sessionID: session.id }))).data).toMatchObject({
          state: "held",
          identity: view.identity,
        })
        // An empty legacy flush may succeed, but it must not release the ordinary recovery hold.
        yield* post(second.url, "queue/flush", {})
        expect((yield* Effect.promise(() => fresh.session.execution({ sessionID: session.id }))).data).toMatchObject({
          state: "held",
          identity: view.identity,
        })
        expect(yield* llm.calls).toBe(1)
      }),
    60000,
  )

  for (const cancelled of [false, true])
    cliIt.live(
      cancelled
        ? "public abort after paused acknowledgement revokes resume without changing the pause receipt"
        : "cooperative pause survives a real Serve restart without automatic dispatch or owner takeover",
      ({ opencode, llm, home }) =>
        Effect.gen(function* () {
          const env = {
            OPENCODE_DB: path.join(home, "cooperative-restart.sqlite"),
            OPENCODE_RUNTIME_RESTART: "1",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), permission: { bash: "allow" } }),
          }
          const first = yield* opencode.serve({ env })
          const sdk = createOpencodeClient({ baseUrl: first.url, directory: home, throwOnError: true })
          const session = (yield* Effect.promise(() => sdk.session.create({ title: "Cooperative restart" }))).data
          if (!session) throw new Error("Missing session")
          const ready = path.join(home, "cooperative-ready")
          const release = path.join(home, "cooperative-release")
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
          yield* llm.push(
            reply().tool("bash", {
              command: `touch '${ready}'; while ! test -f '${release}'; do sleep 0.05; done; printf 'persisted before pause'`,
              description: "Cooperative restart gate",
              timeout: 30000,
            }),
            reply().text("Must not dispatch automatically").stop(),
          )
          yield* Effect.promise(() =>
            sdk.session.queueSubmit({
              sessionID: session.id,
              id: "original-queue",
              payload: {
                kind: "prompt",
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text: "Run the gated operation then continue." }],
              },
            }),
          )
          yield* pollWithTimeout(
            Effect.promise(() => Bun.file(ready).exists()).pipe(Effect.map((yes) => (yes ? true : undefined))),
            "Serve Bash never started",
            "30 seconds",
          )
          const candidate = (yield* Effect.promise(() => sdk.session.execution({ sessionID: session.id }))).data
            ?.candidate
          if (!candidate) throw new Error("Missing enrollment candidate")
          yield* Effect.promise(() =>
            sdk.session.enrollQueueAction({
              sessionID: session.id,
              sessionHandoffV1EnrollRequest: { ...candidate, requestID: "enroll-restart" },
            }),
          )
          const view = (yield* Effect.promise(() => sdk.session.execution({ sessionID: session.id }))).data
          if (!view?.identity) throw new Error("Missing identity")
          const post = (base: string, route: string, body: unknown) =>
            Effect.promise(() =>
              fetch(`${base}/session/${session.id}/${route}?directory=${encodeURIComponent(home)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            )
          const pause = {
            requestID: "pause-restart",
            expectedDirectory: home,
            expected: view.identity,
            expectedRecoveryRevision: view.recoveryRevision,
          }
          const accepted = yield* post(first.url, "execution/pause", pause)
          expect(accepted.status).toBe(200)
          expect(yield* Effect.promise(() => accepted.json())).toMatchObject({ state: "accepted" })
          expect(yield* llm.calls).toBe(1)
          yield* Effect.promise(() => Bun.write(release, "release"))
          const paused = yield* pollWithTimeout(
            Effect.gen(function* () {
              const receipt = (yield* Effect.promise(() =>
                sdk.session.handoffReceipt({ sessionID: session.id, requestID: pause.requestID }),
              )).data
              return receipt?.kind === "cooperative_pause" && receipt.state === "paused" ? receipt : undefined
            }),
            "Serve did not acknowledge drained pause",
            "30 seconds",
          )
          const history = (yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data
          expect(history?.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toMatchObject([
            { state: { status: "completed", output: expect.stringContaining("persisted before pause") } },
          ])
          if (cancelled) {
            expect((yield* Effect.promise(() => sdk.session.abort({ sessionID: session.id }))).data).toBe(true)
            const retry = yield* post(first.url, "execution/pause", pause)
            expect(yield* Effect.promise(() => retry.json())).toEqual(paused)
            const resumeRequest = {
              requestID: "resume-after-abort",
              pauseRequestID: pause.requestID,
              expectedDirectory: home,
              expected: view.identity,
              expectedPauseRevision: paused.pauseRevision,
            }
            const response = yield* post(first.url, "execution/resume", resumeRequest)
            expect(response.status).toBe(200)
            const resume = yield* Effect.promise(() => response.json())
            expect(resume).toMatchObject({ state: "recovery_required", reason: "owner_lost", resumeFence: null })
            const retryResume = yield* post(first.url, "execution/resume", resumeRequest)
            expect(yield* Effect.promise(() => retryResume.json())).toEqual(resume)
            expect(
              (yield* Effect.promise(() =>
                sdk.session.handoffReceipt({ sessionID: session.id, requestID: pause.requestID }),
              )).data,
            ).toEqual(paused)
            expect((yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))).data).toEqual(history)
            expect(yield* llm.calls).toBe(1)
            return
          }
          const client = yield* HttpClient.HttpClient
          yield* client.post(`${first.url}/global/runtime/restart`).pipe(Effect.result)
          expect(
            yield* awaitWithTimeout(
              Effect.promise(() => first.exited),
              "Paused Serve did not drain",
              "30 seconds",
            ),
          ).toBe(75)
          const second = yield* opencode.serve({ env })
          const fresh = createOpencodeClient({ baseUrl: second.url, directory: home, throwOnError: true })
          const resumed = yield* post(second.url, "execution/resume", {
            requestID: "resume-after-restart",
            pauseRequestID: pause.requestID,
            expectedDirectory: home,
            expected: view.identity,
            expectedPauseRevision: paused.pauseRevision,
          })
          expect(resumed.status).toBe(200)
          expect(
            Schema.decodeUnknownSync(SessionHandoffV1.CooperativeResumeReceipt)(
              yield* Effect.promise(() => resumed.json()),
            ),
          ).toMatchObject({ state: "recovery_required", reason: "owner_lost", resumeFence: null })
          expect((yield* Effect.promise(() => fresh.session.execution({ sessionID: session.id }))).data).toMatchObject({
            state: "held",
            identity: view.identity,
          })
          const rejected = yield* post(second.url, "execution/pause", { ...pause, requestID: "dead-owner-adoption" })
          expect(yield* Effect.promise(() => rejected.json())).toMatchObject({ state: "refused" })
          expect((yield* post(second.url, "queue/flush", {})).status).toBe(409)
          expect(
            (yield* post(second.url, "message", { parts: [{ type: "text", text: "Do not implicitly resume" }] }))
              .status,
          ).not.toBe(200)
          expect((yield* Effect.promise(() => fresh.session.messages({ sessionID: session.id }))).data).toEqual(history)
          expect(yield* llm.calls).toBe(1)
        }),
      90000,
    )

  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  for (const [action, exitCode] of [
    ["restart", 75],
    ["shutdown", 0],
  ] as const)
    cliIt.live(
      `exits ${exitCode} after runtime ${action}`,
      ({ opencode }) =>
        Effect.gen(function* () {
          const server = yield* opencode.serve({ env: { OPENCODE_RUNTIME_RESTART: "1" } })
          const client = yield* HttpClient.HttpClient
          // Forced listener shutdown may reset the requesting socket before its response flushes.
          const response = yield* client.post(`${server.url}/global/runtime/${action}`).pipe(Effect.result)
          expect(yield* Effect.promise(() => server.exited)).toBe(exitCode)
          if (response._tag === "Success") expect(response.success.status).toBe(200)
          if (response._tag === "Failure")
            expect(response.failure).toMatchObject({
              reason: { _tag: "TransportError", cause: { code: "ECONNRESET" } },
            })
        }),
      60_000,
    )

  cliIt.live(
    "drains an active Bash tool before restarting with exit 75",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const started = path.join(home, "bash-started")
        const release = path.join(home, "bash-release")
        const drained = path.join(home, "bash-drained")
        const server = yield* opencode.serve({
          env: {
            OPENCODE_RUNTIME_RESTART: "1",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), permission: { bash: "allow" } }),
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
        const sdk = createOpencodeClient({ baseUrl: server.url, directory: home, throwOnError: true })
        const created = yield* Effect.promise(() => sdk.session.create({ title: "Active Bash restart" }))
        const session = created.data
        if (!session) throw new Error("Missing CLI session")
        yield* llm.push(
          reply().tool("bash", {
            command: `printf started > ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; printf drained > ${JSON.stringify(drained)}; printf 'Bash drained'`,
            description: "Wait for the restart request before completing",
          }),
          reply().text("Active Bash finished").stop(),
        )
        const admitted = yield* Effect.promise(() =>
          sdk.session.promptAsync({
            sessionID: session.id,
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "Run the deterministic Bash operation." }],
          }),
        )
        expect(admitted.response.status).toBe(204)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const history = yield* Effect.promise(() => sdk.session.messages({ sessionID: session.id }))
            const running = history.data
              ?.flatMap((message) => message.parts)
              .some((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "running")
            return running && (yield* Effect.promise(() => Bun.file(started).exists())) ? true : undefined
          }),
          "Bash did not publish a running tool part and start marker",
          "30 seconds",
        )
        expect(yield* Effect.promise(() => Bun.file(drained).exists())).toBe(false)
        const client = yield* HttpClient.HttpClient
        const response = yield* client.post(`${server.url}/global/runtime/restart`)
        expect(response.status).toBe(200)
        expect(yield* response.json).toMatchObject({ state: "draining", action: "restart" })
        yield* Effect.promise(() => Bun.write(release, "release"))
        expect(
          yield* awaitWithTimeout(
            Effect.promise(() => server.exited),
            "active Bash restart did not exit",
            "30 seconds",
          ),
        ).toBe(75)
        expect(yield* Effect.promise(() => Bun.file(drained).exists())).toBe(true)
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "kills the subprocess on scope close",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
