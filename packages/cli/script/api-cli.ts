import { OpenApi } from "effect/http-api"
import { ClientApi } from "@opencode/protocol/client"
import { stabilizeOpenApi } from "../../protocol/script/openapi-stabilize"
import { buildCatalog, catalogDifferences, catalogSource } from "../src/api/catalog"
import type { ApiDocument, Catalog } from "../src/api/types"

const target = new URL("../src/api/catalog.generated.json", import.meta.url)
const bundled = (await Bun.file(new URL("../../protocol/openapi.json", import.meta.url)).json()) as ApiDocument
const native = stabilizeOpenApi(OpenApi.fromApi(ClientApi)) as ApiDocument
const catalog = buildCatalog(native)
const expected = catalogSource(catalog)
if (catalogSource(buildCatalog(bundled)) !== expected) {
  throw new Error(
    `Bundled Protocol OpenAPI is stale: ${catalogDifferences(buildCatalog(bundled), catalog).join("; ")}. Run bun run generate from packages/protocol before api:generate`,
  )
}
if (process.argv.includes("--check")) {
  const current = await Bun.file(target)
    .text()
    .catch(() => "")
  if (current !== expected) {
    console.error(
      "API CLI catalog is stale (operation, parameter, or schema metadata changed). Run bun run api:generate from packages/cli.",
    )
    if (current) console.error(catalogDifferences(JSON.parse(current) as Catalog, catalog).join("\n"))
    process.exitCode = 1
  } else console.log(`API CLI catalog is current (${buildCatalog(native).operations.length} operations).`)
} else {
  await Bun.write(target, expected)
  console.log(`Generated API CLI catalog (${buildCatalog(native).operations.length} operations).`)
}
