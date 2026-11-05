import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import pkg from "../package.json"

const root = path.resolve(import.meta.dir, "../../..")
const fixture = { root: "", version: "" }

// The helper deliberately supports only Linux x64 and GNU installation tools.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("local build and install", () => {
  beforeAll(async () => {
    fixture.root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "opencode-build-fixture-"))
    const commit = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [sha, stderr, code] = await Promise.all([
      new Response(commit.stdout).text(),
      new Response(commit.stderr).text(),
      commit.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    fixture.version = `${pkg.version}+${sha.trim()}`
    await Bun.write(
      path.join(fixture.root, "main.ts"),
      `if (process.env.OPENCODE_FIXTURE_VERSION_EXIT) process.exit(29)
console.log((process.env.OPENCODE_FIXTURE_VERSION ?? ${JSON.stringify(`opencode v${fixture.version}`)}) + (process.env.OPENCODE_FIXTURE_VERSION_SUFFIX ?? ""))`,
    )
    const built = await Bun.build({
      entrypoints: [path.join(fixture.root, "main.ts")],
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        outfile: path.join(fixture.root, "opencode"),
      },
    })
    expect(built.success, built.logs.join("\n")).toBe(true)
    const arm = Buffer.from(await Bun.file(path.join(fixture.root, "opencode")).bytes())
    arm.writeUInt16LE(183, 18)
    await Bun.write(path.join(fixture.root, "arm64"), arm)
  })

  afterAll(async () => {
    if (fixture.root) await fs.rm(fixture.root, { recursive: true, force: true })
  })

  test.each(["--version", "-v"])("native %s retains the version prefix and source fallback", async (flag) => {
    await using directory = await tmpdir()
    const child = Bun.spawn([process.execPath, "run", path.join(root, "packages/cli/src/index.ts"), flag], {
      cwd: path.join(root, "packages/cli"),
      env: isolatedEnv(directory.path, { OPENCODE_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ stdout, stderr, code }).toEqual({ stdout: "opencode vlocal\n", stderr: "", code: 0 })
  })

  test("build-only resolves V2 output outside the checkout and does not install", async () => {
    await using directory = await tmpdir()
    const result = await run(directory.path, ["--build-only"], {
      OPENCODE_TARGET: "win32-arm64",
      OPENCODE_VERSION: "1.18.29",
      OPENCODE_CHANNEL: "latest",
    })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("installation skipped")
    expect(await Bun.file(result.destination).text()).toBe("#!/bin/sh\nprintf 'old executable\\n'\n")
    expect(await Bun.file(path.join(directory.path, "build-env")).text()).toBe(`${fixture.version}\nlocal\nlinux-x64\n`)
    const args = await Bun.file(path.join(directory.path, "build-args")).text()
    expect(args).toContain(path.join(root, "packages/cli/script/build.ts"))
    expect(args).toContain("--single\n--skip-install\n")
    expect(args).toContain(`--outdir=${directory.path}/tmp/opencode-build.`)
    expect(await Bun.file(path.join(directory.path, "move-args")).exists()).toBe(false)
  })

  test.each([{ args: ["--unknown"] }, { args: ["--build-only", "extra"] }, { args: ["", "extra"] }])(
    "rejects unsupported arguments $args",
    async (input) => {
      await using directory = await tmpdir()
      const result = await run(directory.path, input.args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("Usage:")
      expect(await Bun.file(path.join(directory.path, "build-args")).exists()).toBe(false)
      expect(await Bun.file(result.destination).text()).toContain("old executable")
    },
  )

  test.each([
    { name: "failed build", env: { OPENCODE_FIXTURE_BUILD: "fail" } },
    { name: "missing output", env: { OPENCODE_FIXTURE_BUILD: "missing" } },
    { name: "non-executable output", env: { OPENCODE_FIXTURE_BUILD: "non-executable" } },
    { name: "script instead of ELF", env: { OPENCODE_FIXTURE_BUILD: "script" } },
    { name: "wrong architecture", env: { OPENCODE_FIXTURE_BUILD: "arm64" } },
    { name: "wrong version", env: { OPENCODE_FIXTURE_VERSION: "opencode v1.18.29" } },
    { name: "version with extra text", env: { OPENCODE_FIXTURE_VERSION_SUFFIX: " unrelated" } },
    { name: "failed version command", env: { OPENCODE_FIXTURE_VERSION_EXIT: "1" } },
    { name: "missing destination", env: { OPENCODE_FIXTURE_DESTINATION: "missing" } },
    { name: "failed staging", env: { OPENCODE_FIXTURE_STAGE: "fail" } },
    { name: "changed staged bytes", env: { OPENCODE_FIXTURE_STAGE: "bytes" } },
    { name: "changed staged mode", env: { OPENCODE_FIXTURE_STAGE: "mode" } },
    { name: "failed rename", env: { OPENCODE_FIXTURE_MOVE: "fail" } },
    { name: "interruption before rename", env: { OPENCODE_FIXTURE_STAGE: "interrupt" } },
  ])("preserves the old executable after $name", async (input) => {
    await using directory = await tmpdir()
    const result = await run(directory.path, [], input.env)
    expect(result.code).not.toBe(0)
    expect(await Bun.file(result.destination).text()).toContain("old executable")
    const old = Bun.spawn([result.destination], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(old.stdout).text(),
      new Response(old.stderr).text(),
      old.exited,
    ])
    expect({ stdout, stderr, code }).toEqual({ stdout: "old executable\n", stderr: "", code: 0 })
    expect(await Bun.file(path.join(directory.path, "move-args")).exists()).toBe(
      input.env.OPENCODE_FIXTURE_MOVE === "fail",
    )
    expect(
      (await fs.readdir(path.dirname(result.destination))).filter((name) => name.startsWith(".opencode-fork.")),
    ).toEqual([])
  })

  test("installs verified bytes and mode through a same-directory atomic rename", async () => {
    await using directory = await tmpdir()
    const result = await run(directory.path)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    expect(
      Buffer.from(await Bun.file(result.destination).bytes()).equals(
        await Bun.file(path.join(fixture.root, "opencode")).bytes(),
      ),
    ).toBe(true)
    expect((await fs.stat(result.destination)).mode & 0o777).toBe(0o755)
    const args = (await Bun.file(path.join(directory.path, "move-args")).text()).trim().split("\n")
    expect(args.slice(0, 2)).toEqual(["-fT", "--"])
    expect(path.dirname(args[2]!)).toBe(path.dirname(result.destination))
    expect(args[3]).toBe(result.destination)
    expect(
      (await fs.readdir(path.dirname(result.destination))).filter((name) => name.startsWith(".opencode-fork.")),
    ).toEqual([])
    const installed = Bun.spawn([result.destination, "--version"], {
      env: isolatedEnv(directory.path),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(installed.stdout).text(),
      new Response(installed.stderr).text(),
      installed.exited,
    ])
    expect({ stdout, stderr, code }).toEqual({ stdout: `opencode v${fixture.version}\n`, stderr: "", code: 0 })
  })
})

async function run(directory: string, args: readonly string[] = [], env: Record<string, string | undefined> = {}) {
  const tools = path.join(directory, "tools")
  const destination = path.join(directory, ".local/bin/opencode-fork")
  await fs.mkdir(tools)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.mkdir(path.join(directory, "tmp"))
  await Bun.write(destination, "#!/bin/sh\nprintf 'old executable\\n'\n")
  await fs.chmod(destination, 0o755)
  if (env.OPENCODE_FIXTURE_DESTINATION === "missing") {
    await fs.rename(path.dirname(destination), path.join(directory, "preserved-bin"))
  }
  await Bun.write(
    path.join(tools, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1-}" != run || "\${2-}" != */packages/cli/script/build.ts ]]; then
  exec "$OPENCODE_FIXTURE_BUN" "$@"
fi
printf '%s\\n' "$@" > "$HOME/build-args"
printf '%s\\n' "$OPENCODE_VERSION" "$OPENCODE_CHANNEL" "$OPENCODE_TARGET" > "$HOME/build-env"
[[ "\${OPENCODE_FIXTURE_BUILD-}" != fail ]] || exit 23
[[ "\${OPENCODE_FIXTURE_BUILD-}" != missing ]] || exit 0
for arg in "$@"; do
  if [[ "$arg" == --outdir=* ]]; then output="\${arg#--outdir=}"; fi
done
[[ "$(dirname "$output")" == "$TMPDIR" ]]
artifact="$output/cli-linux-x64/bin/opencode"
mkdir -p -- "$(dirname "$artifact")"
cp -- "$OPENCODE_FIXTURE_ARTIFACT" "$artifact"
chmod 755 -- "$artifact"
case "\${OPENCODE_FIXTURE_BUILD-}" in
  non-executable) chmod 644 -- "$artifact" ;;
  script) printf '#!/bin/sh\\necho not-an-ELF\\n' > "$artifact" ;;
esac
`,
  )
  await Bun.write(
    path.join(tools, "install"),
    `#!/usr/bin/env bash
set -euo pipefail
/usr/bin/install "$@"
staged="\${@: -1}"
case "\${OPENCODE_FIXTURE_STAGE-}" in
  fail) exit 24 ;;
  bytes) printf changed >> "$staged" ;;
  mode) chmod 644 -- "$staged" ;;
  interrupt) kill -TERM "$PPID" ;;
esac
`,
  )
  await Bun.write(
    path.join(tools, "mv"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$HOME/move-args"
[[ "\${OPENCODE_FIXTURE_MOVE-}" != fail ]] || exit 25
exec /usr/bin/mv "$@"
`,
  )
  await Promise.all(["bun", "install", "mv"].map((name) => fs.chmod(path.join(tools, name), 0o755)))
  const child = Bun.spawn(["bash", path.join(root, "build-and-install.sh"), ...args], {
    cwd: directory,
    env: isolatedEnv(directory, {
      PATH: `${tools}:${process.env.PATH}`,
      TMPDIR: path.join(directory, "tmp"),
      OPENCODE_DISABLE_TELEMETRY: "1",
      TURBO_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      OPENCODE_FIXTURE_BUN: process.execPath,
      OPENCODE_FIXTURE_ARTIFACT: path.join(fixture.root, env.OPENCODE_FIXTURE_BUILD === "arm64" ? "arm64" : "opencode"),
      ...env,
    }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    stdout,
    stderr,
    code,
    destination:
      env.OPENCODE_FIXTURE_DESTINATION === "missing"
        ? path.join(directory, "preserved-bin/opencode-fork")
        : destination,
  }
}
