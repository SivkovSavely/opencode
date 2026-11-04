export * as EventData from "./data"

import { createHash } from "node:crypto"
import zlib from "node:zlib"

const magic = Buffer.from("OCEZ")
const version = 1
const headerSize = 41
const threshold = 16 * 1024
const bun =
  typeof Bun !== "undefined" &&
  typeof Bun.zstdCompressSync === "function" &&
  typeof Bun.zstdDecompressSync === "function"
const node = typeof zlib.zstdCompressSync === "function" && typeof zlib.zstdDecompressSync === "function"

// Per-event transport budget includes prompts and metadata, not just summary patches.
export const MAX_TRANSPORT_BYTES = 16 * 1024 * 1024

export class LimitError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds transport limit of ${maximumBytes} bytes`)
    this.name = "EventData.LimitError"
  }
}

export function encode(data: Record<string, unknown>): string | Uint8Array {
  const json = JSON.stringify(data)
  const size = Buffer.byteLength(json)
  if (size < threshold || (!bun && !node)) return json
  const compressed = bun
    ? Bun.zstdCompressSync(Buffer.from(json), { level: 3 })
    : zlib.zstdCompressSync(json, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })
  if (compressed.byteLength + headerSize > size * 0.75) return json
  const result = Buffer.allocUnsafe(headerSize + compressed.byteLength)
  magic.copy(result)
  result[4] = version
  result.writeUInt32LE(size, 5)
  createHash("sha256").update(compressed).digest().copy(result, 9)
  result.set(compressed, headerSize)
  return result
}

export function decode(data: string | Uint8Array, maximumBytes?: number): Record<string, unknown> {
  if (maximumBytes !== undefined && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1))
    throw new RangeError("Event payload byte limit must be a positive safe integer")
  if (typeof data === "string") {
    if (maximumBytes !== undefined && (data.length > maximumBytes || Buffer.byteLength(data) > maximumBytes))
      throw new LimitError(maximumBytes)
    return JSON.parse(data)
  }
  if (!(data instanceof Uint8Array)) throw new Error("Invalid event payload: expected JSON TEXT or a codec BLOB")
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!buffer.subarray(0, 4).equals(magic)) throw new Error("Unknown event payload BLOB format")
  if (buffer[4] !== version) throw new Error(`Unsupported event payload codec version ${buffer[4]}`)
  if (buffer.length <= headerSize) throw new Error("Corrupted compressed event payload: truncated header or frame")
  const size = buffer.readUInt32LE(5)
  if (maximumBytes !== undefined && size > maximumBytes) throw new LimitError(maximumBytes)
  const compressed = buffer.subarray(headerSize)
  if (!createHash("sha256").update(compressed).digest().equals(buffer.subarray(9, headerSize)))
    throw new Error("Corrupted compressed event payload: checksum mismatch")
  if (!bun && !node)
    throw new Error("Cannot decode Zstandard event payload: this runtime has no native Zstandard support")
  if (maximumBytes !== undefined && !node)
    throw new Error("Cannot decode bounded Zstandard event payload: this runtime has no bounded Zstandard support")
  try {
    // The header is untrusted; cap actual output as well as checking its declared size.
    const json =
      maximumBytes !== undefined
        ? zlib.zstdDecompressSync(compressed, { maxOutputLength: maximumBytes })
        : bun
          ? Bun.zstdDecompressSync(compressed)
          : zlib.zstdDecompressSync(compressed, { maxOutputLength: size })
    if (json.byteLength !== size) throw new Error("Uncompressed size mismatch")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json))
  } catch (cause) {
    if (
      maximumBytes !== undefined &&
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ERR_BUFFER_TOO_LARGE"
    )
      throw new LimitError(maximumBytes)
    throw new Error("Corrupted compressed event payload: invalid Zstandard, UTF-8, or JSON data", { cause })
  }
}
