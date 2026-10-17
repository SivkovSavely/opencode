import { expect, test } from "@playwright/test"
import { setupTimeline, status } from "../performance/timeline-stability/fixture"

test("shows Retry now on a fork reporting v1 and keeps the accepted attempt disabled", async ({ page }) => {
  let release: (() => void) | undefined
  let releaseNext: (() => void) | undefined
  let requested: (() => void) | undefined
  let requestedNext: (() => void) | undefined
  const response = new Promise<void>((resolve) => (release = resolve))
  const nextResponse = new Promise<void>((resolve) => (releaseNext = resolve))
  const requestStarted = new Promise<void>((resolve) => (requested = resolve))
  const nextRequestStarted = new Promise<void>((resolve) => (requestedNext = resolve))
  const requests: { url: URL; headers: Record<string, string>; body: unknown }[] = []

  const timeline = await setupTimeline(page, { protocol: "v1" })
  await page.route("**/session/*/retry", async (route) => {
    requests.push({
      url: new URL(route.request().url()),
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    })
    if (requests.length === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: false }) })
      return
    }
    if (requests.length === 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "offline" }) })
      return
    }
    if (requests.length === 3) {
      requested?.()
      await response
    } else {
      requestedNext?.()
      await nextResponse
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true }) })
  })
  await timeline.send(status("retry"))

  const retry = page.getByRole("button", { name: "retry now" })
  await expect(retry).toBeVisible()
  const rejected = page.waitForResponse((res) => res.url().includes("/session/ses_timeline_stability/retry"))
  await retry.click()
  await rejected
  await expect(retry).toBeEnabled()
  expect(requests).toHaveLength(1)

  const failed = page.waitForResponse((res) => res.url().includes("/session/ses_timeline_stability/retry"))
  await retry.click()
  await failed
  await expect(retry).toBeEnabled()
  expect(requests).toHaveLength(2)

  await retry.click()
  await requestStarted
  await expect(retry).toBeDisabled()
  await retry.dispatchEvent("click")
  expect(requests).toHaveLength(3)
  expect(requests[2]?.url.pathname).toBe("/session/ses_timeline_stability/retry")
  expect(requests[2]?.headers["x-opencode-directory"]).toBe("C%3A%2FOpenCode%2FTimelineStability")
  expect(requests[2]?.body).toEqual({ attempt: 1, next: 1700000010000 })

  await timeline.send(status("retry", 2))
  await expect(retry).toBeEnabled()

  const staleResponse = page.waitForResponse((res) => res.url().includes("/session/ses_timeline_stability/retry"))
  release?.()
  await staleResponse
  await timeline.settle()
  await expect(retry).toBeEnabled()

  const acceptedResponse = page.waitForResponse(
    (res) => res.url().includes("/session/ses_timeline_stability/retry") && res.request().postDataJSON().attempt === 2,
  )
  await retry.click()
  await nextRequestStarted
  await expect(retry).toBeDisabled()
  releaseNext?.()
  expect((await acceptedResponse).status()).toBe(200)
  await timeline.settle()
  await expect(retry).toBeDisabled()
  await retry.dispatchEvent("click")
  expect(requests).toHaveLength(4)

  await timeline.send(status("retry", 3))
  await expect(retry).toBeEnabled()

  await timeline.send(status("idle"))
  await expect(retry).toHaveCount(0)
})
