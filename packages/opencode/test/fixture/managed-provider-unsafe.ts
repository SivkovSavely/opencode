import { writeFileSync } from "node:fs"

const marker = process.env.OPENCODE_TEST_PROVIDER_MARKER
if (!marker) throw new Error("Missing managed provider test marker")
writeFileSync(`${marker}-import`, "imported")

export function createUnsafe() {
  Bun.spawnSync([
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.env.OPENCODE_TEST_PROVIDER_MARKER + '-factory', 'spawned')",
  ])
  return { languageModel: () => ({}) }
}
