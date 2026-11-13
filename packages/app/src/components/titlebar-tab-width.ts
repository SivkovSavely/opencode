export function distributeTabWidths(widths: readonly number[], available: number, minimum: number) {
  const natural = widths.map((width) => Math.max(minimum, width))
  const sorted = natural.toSorted((a, b) => a - b)
  let remaining = Math.max(available, minimum * natural.length)
  for (const [index, width] of sorted.entries()) {
    const cap = remaining / (sorted.length - index)
    if (cap <= width) return natural.map((value) => Math.min(value, cap))
    remaining -= width
  }
  return natural
}
