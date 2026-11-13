import { describe, expect, test } from "bun:test"
import { distributeTabWidths } from "./titlebar-tab-width"

describe("distributeTabWidths", () => {
  test("uses natural widths without filling unused space or capping long titles", () => {
    expect(distributeTabWidths([100, 200, 300], 700, 28)).toEqual([100, 200, 300])
    expect(distributeTabWidths([350], 800, 28)).toEqual([350])
    expect(distributeTabWidths([], 100, 28)).toEqual([])
  })

  test.each([
    [600, [100, 200, 300]],
    [550, [100, 200, 250]],
    [500, [100, 200, 200]],
    [460, [100, 180, 180]],
    [400, [100, 150, 150]],
    [240, [80, 80, 80]],
  ])("progressively equalizes the longest tabs with %d pixels", (available, expected) => {
    expect(distributeTabWidths([100, 200, 300], available, 28)).toEqual(expected)
  })

  test("preserves tab order and shrinks tied longest tabs together", () => {
    const widths = [300, 100, 300, 200]
    expect(distributeTabWidths(widths, 700, 28)).toEqual([200, 100, 200, 200])
    expect(widths).toEqual([300, 100, 300, 200])
  })

  test("respects the minimum even for empty titles and insufficient space", () => {
    expect(distributeTabWidths([0, 20, 100], 120, 28)).toEqual([28, 28, 64])
    expect(distributeTabWidths([100, 200, 300], 84, 28)).toEqual([28, 28, 28])
    expect(distributeTabWidths([100, 200, 300], 50, 28)).toEqual([28, 28, 28])
    expect(distributeTabWidths([100, 200], -10, 28)).toEqual([28, 28])
  })

  test("keeps fractional widths at natural and equalization boundaries", () => {
    expect(distributeTabWidths([100.125, 200.25, 300.5], 600.875, 28)).toEqual([100.125, 200.25, 300.5])
    expect(distributeTabWidths([100.125, 200.25, 300.5], 500.625, 28)).toEqual([100.125, 200.25, 200.25])
    const result = distributeTabWidths([100.125, 200.25, 300.5], 500.624, 28)
    expect(result[0]).toBe(100.125)
    expect(result[1]).toBeCloseTo(200.2495, 10)
    expect(result[2]).toBeCloseTo(200.2495, 10)
    expect(result.reduce((sum, width) => sum + width, 0)).toBeCloseTo(500.624, 10)
    expect(distributeTabWidths([100, 100, 100], 100, 28)[0]).toBeCloseTo(100 / 3, 10)
  })
})
