const sizes = [
  4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 134217728, 268435456, 536870912, 1073741824,
]
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
const phases = ["load", "validation", "compression", "verification", "write", "checkpoint", "total"] as const
export type TimingPhase = (typeof phases)[number]

class Duration {
  count = 0
  totalMs = 0
  minMs = Infinity
  maxMs = 0
  mean = 0
  squared = 0
  // Sixteen bins per doubling, in microseconds; the last bin holds overflow.
  histogram = new Float64Array(512)

  add(ms: number) {
    this.count++
    this.totalMs += ms
    this.minMs = Math.min(this.minMs, ms)
    this.maxMs = Math.max(this.maxMs, ms)
    const delta = ms - this.mean
    this.mean += delta / this.count
    this.squared += delta * (ms - this.mean)
    this.histogram[Math.min(511, Math.ceil(Math.log2(1 + ms * 1000) * 16))]++
  }

  percentile(fraction: number) {
    if (!this.count) return null
    const rank = Math.ceil(this.count * fraction)
    let count = 0
    for (let index = 0; index < this.histogram.length; index++) {
      count += this.histogram[index]
      if (count >= rank) return index === 511 ? this.maxMs : Math.min(this.maxMs, (2 ** (index / 16) - 1) / 1000)
    }
    return this.maxMs
  }

  summary() {
    return {
      count: this.count,
      totalMs: this.totalMs,
      averageMs: this.count ? this.totalMs / this.count : 0,
      minMs: this.count ? this.minMs : 0,
      maxMs: this.maxMs,
      medianMs: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      stddevMs: this.count ? Math.sqrt(Math.max(0, this.squared / this.count)) : 0,
    }
  }
}

export class CompressionTimings {
  private readonly started = performance.now()
  private readonly checkpoints = new Duration()
  private readonly buckets = labels.map((label, index) => ({
    label,
    minBytes: sizes[index],
    maxBytes: sizes[index + 1],
    rows: 0,
    inputBytes: 0,
    outputBytes: 0,
    phases: Object.fromEntries(phases.map((phase) => [phase, new Duration()])) as Record<TimingPhase, Duration>,
  }))

  record(inputBytes: number, outputBytes: number, measurements: Partial<Record<TimingPhase, number>>) {
    const bucket = this.buckets.find(
      (bucket, index) =>
        inputBytes >= bucket.minBytes &&
        (inputBytes < bucket.maxBytes || (index === this.buckets.length - 1 && inputBytes === bucket.maxBytes)),
    )
    if (!bucket) throw new RangeError("Timing input size is outside the supported candidate range")
    bucket.rows++
    bucket.inputBytes += inputBytes
    bucket.outputBytes += outputBytes
    for (const phase of phases) {
      const ms = measurements[phase]
      if (ms !== undefined) bucket.phases[phase].add(ms)
    }
  }

  checkpoint(ms: number) {
    this.checkpoints.add(ms)
  }

  summary() {
    return {
      elapsedMs: performance.now() - this.started,
      checkpoint: this.checkpoints.summary(),
      buckets: this.buckets
        .filter((bucket) => bucket.rows > 0)
        .map((bucket) => ({
          label: bucket.label,
          minBytes: bucket.minBytes,
          maxBytes: bucket.maxBytes,
          rows: bucket.rows,
          inputBytes: bucket.inputBytes,
          outputBytes: bucket.outputBytes,
          savingsPercent: 100 * (1 - bucket.outputBytes / bucket.inputBytes),
          throughputMiBps:
            bucket.phases.compression.totalMs > 0
              ? bucket.inputBytes / 1048576 / (bucket.phases.compression.totalMs / 1000)
              : 0,
          phases: Object.fromEntries(phases.map((phase) => [phase, bucket.phases[phase].summary()])) as Record<
            TimingPhase,
            ReturnType<Duration["summary"]>
          >,
        })),
    }
  }
}

export type TimingStats = ReturnType<CompressionTimings["summary"]>

export function timingSummary(stats: TimingStats) {
  return [
    "Compression timings (ms; approximate histogram p50/p95; sparse samples are not reliable tail estimates):",
    ...stats.buckets.flatMap((bucket) => [
      `${bucket.label}: rows=${bucket.rows}, input=${bucket.inputBytes}, retained output=${bucket.outputBytes}, savings=${bucket.savingsPercent.toFixed(2)}%, compression=${bucket.throughputMiBps.toFixed(2)} MiB/s`,
      ...phases
        .filter((phase) => bucket.phases[phase].count)
        .map((phase) => {
          const duration = bucket.phases[phase]
          return `  ${phase}: n=${duration.count}, sum=${duration.totalMs.toFixed(3)}, avg=${duration.averageMs.toFixed(3)}, p50~${duration.medianMs!.toFixed(3)}, p95~${duration.p95Ms!.toFixed(3)}, min=${duration.minMs.toFixed(3)}, max=${duration.maxMs.toFixed(3)}`
        }),
    ]),
    `All WAL checkpoints, including startup/final: n=${stats.checkpoint.count}, ${stats.checkpoint.totalMs.toFixed(3)} ms; run elapsed=${stats.elapsedMs.toFixed(3)} ms`,
  ].join("\n")
}
