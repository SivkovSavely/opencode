import { expect, test } from "bun:test"
import { tmpdir } from "os"
import path from "path"

test.each(["--version", "-v"])("%s displays the build commit", async (flag) => {
  const process = Bun.spawn(
    [
      "bun",
      "--define",
      'OPENCODE_VERSION:"1.18.29"',
      "--define",
      'OPENCODE_COMMIT:"abcdef1234567890"',
      path.resolve(import.meta.dir, "../../src/index.ts"),
      flag,
    ],
    { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" },
  )
  expect(await new Response(process.stdout).text()).toBe("1.18.29 (abcdef12)\n")
  expect(await process.exited).toBe(0)
})

test("version without build metadata remains usable", async () => {
  const process = Bun.spawn(["bun", path.resolve(import.meta.dir, "../../src/index.ts"), "--version"], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await new Response(process.stdout).text()).toBe("local\n")
  expect(await process.exited).toBe(0)
})
