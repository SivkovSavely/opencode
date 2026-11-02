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

export function decode(data: string | Uint8Array): Record<string, unknown> {
  if (typeof data === "string") return JSON.parse(data)
  if (!(data instanceof Uint8Array)) throw new Error("Invalid event payload: expected JSON TEXT or a codec BLOB")
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!buffer.subarray(0, 4).equals(magic)) throw new Error("Unknown event payload BLOB format")
  if (buffer[4] !== version) throw new Error(`Unsupported event payload codec version ${buffer[4]}`)
  if (buffer.length <= headerSize) throw new Error("Corrupted compressed event payload: truncated header or frame")
  const compressed = buffer.subarray(headerSize)
  if (!createHash("sha256").update(compressed).digest().equals(buffer.subarray(9, headerSize)))
    throw new Error("Corrupted compressed event payload: checksum mismatch")
  if (!bun && !node)
    throw new Error("Cannot decode Zstandard event payload: this runtime has no native Zstandard support")
  try {
    const json = bun
      ? Bun.zstdDecompressSync(compressed)
      : zlib.zstdDecompressSync(compressed, { maxOutputLength: buffer.readUInt32LE(5) })
    if (json.byteLength !== buffer.readUInt32LE(5)) throw new Error("Uncompressed size mismatch")
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json))
  } catch (cause) {
    throw new Error("Corrupted compressed event payload: invalid Zstandard, UTF-8, or JSON data", { cause })
  }
}
