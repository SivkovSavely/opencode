/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { UserMessageMetadata } from "../../src/component/user-message-metadata"

test("scheduled origin stays visible without timestamps and alongside steering", async () => {
  const color = RGBA.fromInts(255, 255, 255)
  for (const steering of [false, true]) {
    const app = await testRender(
      () => <UserMessageMetadata scheduled steering={steering} color={color} foreground={color} muted={color} />,
      { width: 80, height: 10 },
    )
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("SCHEDULED")
      expect(frame.includes("STEERING")).toBe(steering)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("ordinary messages do not display a scheduled badge", async () => {
  const color = RGBA.fromInts(255, 255, 255)
  const app = await testRender(
    () => (
      <UserMessageMetadata
        scheduled={false}
        steering={false}
        timestamp="12:00"
        color={color}
        foreground={color}
        muted={color}
      />
    ),
    { width: 80, height: 10 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("12:00")
    expect(app.captureCharFrame()).not.toContain("SCHEDULED")
  } finally {
    app.renderer.destroy()
  }
})
