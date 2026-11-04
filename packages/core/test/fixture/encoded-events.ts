import { createHash } from "node:crypto"

export function encodedEventPayloads() {
  const json = Buffer.from(JSON.stringify({ text: "synthetic \u96ea event\n".repeat(2048), nested: [true, null, 42] }))
  const compressed = Bun.zstdCompressSync(json, { level: 3 })
  const encoded = Buffer.alloc(41 + compressed.length)
  encoded.write("OCEZ")
  encoded[4] = 1
  encoded.writeUInt32LE(json.length, 5)
  createHash("sha256").update(compressed).digest().copy(encoded, 9)
  encoded.set(compressed, 41)
  return [
    { name: "OCEZ v1", value: encoded },
    {
      name: "unknown codec version",
      value: Buffer.concat([encoded.subarray(0, 4), Buffer.of(255), encoded.subarray(5)]),
    },
    { name: "truncated envelope", value: encoded.subarray(0, 15) },
    { name: "corrupt frame", value: Buffer.concat([encoded.subarray(0, -1), Buffer.of(encoded.at(-1)! ^ 1)]) },
    { name: "JSON stored as a BLOB", value: Buffer.from('{"text":"not TEXT"}') },
    { name: "empty BLOB", value: Buffer.alloc(0) },
  ]
}
