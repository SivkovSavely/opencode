import { expect, test } from "bun:test"
import { CompressionTimings } from "../script/event-compress-timings"

test("size buckets use inclusive lower bounds and exclude empty buckets", () => {
  const timings = new CompressionTimings()
  expect(timings.summary().buckets).toEqual([])
  const boundaries = [4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 134217728, 268435456, 536870912]
  const labels = [
    "4-16 KiB",
    "16-64 KiB",
    "64-256 KiB",
    "256 KiB-1 MiB",
    "1-4 MiB",
    "4-16 MiB",
    "16-64 MiB",
    "64-128 MiB",
    "128-256 MiB",
    "256-512 MiB",
    "512-1024 MiB",
  ]
  boundaries.forEach((bytes) => timings.record(bytes, bytes / 2, { compression: 1, total: 2 }))
  expect(timings.summary().buckets.map((bucket) => bucket.label)).toEqual(labels)
  expect(timings.summary().buckets.map((bucket) => bucket.rows)).toEqual(boundaries.map(() => 1))
  timings.record(1073741824, 100, { compression: 1, total: 2 })
  expect(timings.summary().buckets.at(-1)!.rows).toBe(2)
  expect(() => timings.record(4095, 1, { compression: 1 })).toThrow()
  expect(() => timings.record(1073741825, 1, { compression: 1 })).toThrow()
})

test("fixed histograms approximate percentiles and compute exact sums, variance and throughput", () => {
  const timings = new CompressionTimings()
  for (let ms = 1; ms <= 100; ms++) timings.record(1048576, 524288, { load: 0.5, compression: ms, total: ms + 2 })
  timings.checkpoint(4)
  const summary = timings.summary()
  const bucket = summary.buckets[0]
  expect(bucket).toMatchObject({ rows: 100, inputBytes: 104857600, outputBytes: 52428800, savingsPercent: 50 })
  expect(bucket.phases.compression).toMatchObject({ count: 100, totalMs: 5050, averageMs: 50.5, minMs: 1, maxMs: 100 })
  expect(bucket.phases.compression.medianMs!).toBeGreaterThanOrEqual(50)
  expect(bucket.phases.compression.medianMs!).toBeLessThan(53)
  expect(bucket.phases.compression.p95Ms!).toBeGreaterThanOrEqual(95)
  expect(bucket.phases.compression.p95Ms!).toBeLessThan(100)
  expect(bucket.phases.compression.stddevMs).toBeCloseTo(Math.sqrt(833.25), 8)
  expect(bucket.throughputMiBps).toBeCloseTo(100 / 5.05, 8)
  expect(bucket.phases.write).toMatchObject({ count: 0, totalMs: 0, medianMs: null, p95Ms: null })
  expect(summary.checkpoint).toMatchObject({ count: 1, totalMs: 4 })
})

test("aggregation storage is fixed even after many rows and unusually long phases", () => {
  const timings = new CompressionTimings()
  const before = JSON.stringify(timings).length
  for (let row = 0; row < 20000; row++) timings.record(4096, 100, { compression: 1, total: 2 })
  timings.record(4096, 100, { compression: 1e9, total: 1e9 })
  expect(JSON.stringify(timings).length).toBeLessThan(before + 1000)
  const duration = timings.summary().buckets[0].phases.compression
  expect(duration.count).toBe(20001)
  expect(duration.maxMs).toBe(1e9)
  expect(duration.p95Ms!).toBeGreaterThanOrEqual(1)
  expect(duration.p95Ms!).toBeLessThan(1.1)
  expect(JSON.stringify(timings.summary()).length).toBeLessThan(10000)
})
