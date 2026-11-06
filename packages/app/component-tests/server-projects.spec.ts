import { expect, sourceURL, story } from "../../stories/playwright/story"

const fixture = sourceURL(new URL("./server-projects.fixture.tsx", import.meta.url))

for (const initialized of [true, false]) {
  story(
    `cached project acknowledgments survive controller disposal (${initialized ? "initialized" : "lazy"})`,
    async ({ mount, page }) => {
      await mount("ui-line-comment--editor")
      const result = await page.evaluate(
        async ({ fixture, initialized }) => {
          const { exerciseProjectOwner } = await import(fixture)
          return exerciseProjectOwner(initialized)
        },
        { fixture, initialized },
      )
      expect(result).toEqual({ same: true, acknowledged: true, later: true })
    },
  )
}
