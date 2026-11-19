import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { closeSync, createReadStream, openSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises"

process.umask(0o077)
const root = "/home/savochek/ExternalProjects/opencode"
const packageDir = `${root}/packages/opencode`
const script = `${packageDir}/test/server/fixtures/embedded-catalogue-qualification.ts`
const artifacts = "/tmp/opencode/model-handoff-recovery-20261115"
const previous = `${artifacts}/native-candidate-oauth-qualification-r6.json`
const previousPatch = "/tmp/opencode/phase14-oauth.TbD0P8/phase14-harness.patch"
const candidate = "/tmp/opencode/phase13-build.nejsA8/opencode-candidate-r6"
const expected = "737a999e672b91ee9b770a73d598bb3f6cc2e7aa841bcaa4bc421f70a311b7b1"
const catalogue = "/tmp/opencode/models-official-fetch.7s1Cyn/catalogue.json"
assert((await readFile("/proc/self/cgroup", "utf8")).includes("baila-build.slice"))

async function hash(file: string) {
  const result = createHash("sha256")
  for await (const chunk of createReadStream(file)) result.update(chunk)
  return result.digest("hex")
}

async function run(args: string[], cwd = packageDir, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { args, stdout, stderr, exitCode }
}

if (process.argv.includes("--publish")) {
  const directories = process.argv.slice(process.argv.indexOf("--publish") + 1)
  const directory = directories.at(-1)!
  assert(directory.startsWith("/tmp/opencode/phase14-catalogue."))
  const old = JSON.parse(await readFile(previous, "utf8")) as {
    harness: { files: { path: string; sha256: string }[] }
    preservedParent: unknown
    priorNativeBroadFailures: unknown
  }
  assert.equal(await hash(previous), "8cc31ce47c9bf1dbcf436bdfd4522c87c3ca63397d39754bd82b0128d914e4eb")
  assert.equal(await hash(previousPatch), "653198ad80776328d43bb5581d1a458e103a824f163cc528dcaf6c3128e486ac")
  const baseline = `${directory}/baseline`
  const file = "packages/opencode/test/server/handoff-restart.test.ts"
  await mkdir(`${baseline}/packages/opencode/test/server`, { recursive: true })
  const frozenPatch = await readFile(`${artifacts}/native-source-v4-r6.patch`, "utf8")
  const block = frozenPatch.split(`diff --git a/${file} b/${file}\n`)[1].split("\ndiff --git ")[0]
  await writeFile(
    `${baseline}/${file}`,
    block
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
      .map((line) => line.slice(1))
      .join("\n") + "\n",
  )
  const applied = await run(["git", "apply", previousPatch], baseline)
  assert.equal(applied.exitCode, 0, applied.stderr)
  for (const entry of old.harness.files) assert.equal(await hash(`${baseline}/${entry.path}`), entry.sha256, entry.path)
  const files = [
    file,
    "packages/opencode/test/server/embedded-catalogue-restart.test.ts",
    "packages/opencode/test/server/fixtures/embedded-catalogue-qualification.ts",
  ]
  const patch = []
  const identities = []
  await writeFile(`${baseline}/empty`, "")
  for (const entry of files) {
    assert.equal(await realpath(`${root}/${entry}`), `${root}/${entry}`)
    const prior = old.harness.files.find((record) => record.path === entry)
    const diff = await run([
      "/usr/bin/diff",
      "-u",
      "--label",
      prior ? `a/${entry}` : "/dev/null",
      "--label",
      `b/${entry}`,
      prior ? `${baseline}/${entry}` : `${baseline}/empty`,
      `${root}/${entry}`,
    ])
    assert.equal(diff.exitCode, 1)
    patch.push(diff.stdout)
    identities.push({
      path: entry,
      previousHarnessSha256: prior?.sha256 ?? null,
      sha256: await hash(`${root}/${entry}`),
    })
  }
  for (const entry of old.harness.files.filter((entry) => entry.path !== file))
    assert.equal(await hash(`${root}/${entry.path}`), entry.sha256)
  const patchFile = `${directory}/embedded-catalogue-supplement.patch`
  await writeFile(patchFile, patch.join(""), { mode: 0o600, flag: "wx" })
  const attempts = []
  for (const entry of directories) {
    assert(entry.startsWith("/tmp/opencode/phase14-catalogue."))
    attempts.push({
      directory: entry,
      ...JSON.parse(await readFile(`${entry}/attempt.json`, "utf8")),
      evidence: await Promise.all(
        (await readdir(entry))
          .filter((name) => /\.(json|ndjson|log)$/.test(name))
          .map(async (name) => ({ path: `${entry}/${name}`, sha256: await hash(`${entry}/${name}`) })),
      ),
    })
  }
  const tests = JSON.parse(await readFile(`${directory}/tests.json`, "utf8")) as { file: string; exitCode: number }[]
  assert.equal(tests.length, 3)
  assert(tests.every((test) => test.exitCode === 0))
  const typecheck = JSON.parse(await readFile(`${directory}/typecheck.json`, "utf8"))
  assert.equal(typecheck.exitCode, 0)
  assert.equal(attempts.at(-1)!.exitCode, 0)
  assert.equal(await hash(candidate), expected)
  assert.equal(await hash(catalogue), "82eb03a35fac1b36ca09218a3c64126dbf8f1bc08ddd879c5f59fd1987780282")
  const manifest = JSON.parse(await readFile(`${artifacts}/native-source-manifest-v4-r6.json`, "utf8")) as {
    source: { files: { path: string; sha256: string }[] }
  }
  for (const entry of manifest.source.files.filter((entry) => !entry.path.startsWith("packages/opencode/test/")))
    assert.equal(await hash(`${root}/${entry.path}`), entry.sha256, entry.path)
  const result = {
    artifact: "native-candidate-oauth-embedded-catalogue-supplement-r6",
    recordedAt: new Date().toISOString(),
    phase: 14,
    compiledEmbeddedCatalogueOAuthQualified: true,
    claim:
      "HTTP and WSS built-in OAuth same-input recovery against embedded catalogue with no model/capability/limit/effort definitions or provider options in configuration; normal built-in OAuth filtering and limit normalization retained",
    previousQualification: {
      path: previous,
      sha256: await hash(previous),
      patch: previousPatch,
      patchSha256: await hash(previousPatch),
      preservedExactly: true,
      correctedScope:
        "Earlier proof certifies configured model definitions and effort mappings, not unmodified embedded model availability/capabilities/variants.",
    },
    candidate: {
      path: candidate,
      sha256Before: attempts.at(-1)!.before.candidate,
      sha256After: await hash(candidate),
      version: JSON.parse(await readFile(`${directory}/version.json`, "utf8")),
      rebuilt: false,
    },
    source: {
      root,
      commonGitDirectory: `${root}/.git`,
      head: attempts.at(-1)!.before.head,
      status: (await run(["git", "status", "--short", "--branch"], root)).stdout,
      frozenRuntimeFingerprint: "68545e439b0906b4c2ef4cf97cee46839fa0293fb1737a613905d864bab326d2",
      runtimeUnchanged: true,
    },
    catalogue: {
      path: catalogue,
      sha256: await hash(catalogue),
      suppliedToCandidate: false,
      comparisonOnly: true,
      expectedOriginal: "gpt-5.4-mini",
      recoveryTarget: "gpt-5.4",
      followingAction: "gpt-5.5",
      reasoningVariants:
        "none,low,medium,high,xhigh; generated by reasoningVariants/effortVariants/reasoningEffort from public reasoning_options",
      pluginFilter: "gpt-5.3-codex is excluded; chosen gpt-5.4-mini, gpt-5.4 and gpt-5.5 are explicitly allowed",
      builtInNormalization:
        "OAuth plugin changes costs to zero and normalizes gpt-5.5 limits to context400000/input272000/output128000; no harness overrides",
    },
    harness: {
      files: identities,
      patch: patchFile,
      patchSha256: await hash(patchFile),
      previousCasesAndAssertionsPreserved: true,
      originalBudgetsUnchanged: true,
    },
    isolation: JSON.parse(await readFile(`${directory}/isolation.json`, "utf8")),
    processes: (await readFile(`${directory}/processes.ndjson`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    http: {
      catalogue: JSON.parse(await readFile(`${directory}/http-catalogue.json`, "utf8")),
      wire: JSON.parse(await readFile(`${directory}/embedded-catalogue-restart.test.ts.http-wire.json`, "utf8")),
    },
    ws: {
      catalogue: JSON.parse(await readFile(`${directory}/ws-catalogue.json`, "utf8")),
      wire: JSON.parse(await readFile(`${directory}/embedded-catalogue-restart.test.ts.ws-wire.json`, "utf8")),
    },
    tests,
    typecheck,
    attempts,
    diagnosis:
      "Initial supplemental preflight failed before model dispatch because gpt-5.3-codex is absent after the embedded OAuth filter. Selected gpt-5.4-mini from the actual allowed catalogue instead; no capability/model injection or assertion/deadline relaxation.",
    preservedParent: old.preservedParent,
    priorNativeBroadFailures: old.priorNativeBroadFailures,
    limits: [
      "Fake model server does not certify real-provider acceptance or full structured-output API conformance.",
      "Shared scenario is exercised in distinct Bun test processes for configured and catalogue-only cases; original configured definitions, assertions and budgets are unchanged.",
      "Private fixture CA trust only; verification remains enabled. All credential material fabricated. No production credentials/config/state read.",
      "No production ports, public network, external plugin, installation, rebuild, deployment or commit. Denied catalogue-refresh CONNECT attempts cannot leave loopback namespace.",
    ],
    fullPackageSuitesPassed: false,
    productionAuthorized: false,
    namespaceStopped: true,
    noBackgroundWriters: true,
  }
  const output = `${artifacts}/native-candidate-oauth-embedded-catalogue-supplement-r6.json`
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ output, sha256: await hash(output), compiledEmbeddedCatalogueOAuthQualified: true }))
  process.exit(0)
}

if (process.argv.includes("--inside")) {
  const directory = process.env.PHASE14_DIR!
  const devices = (await readFile("/proc/net/dev", "utf8"))
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(":")[0])
  assert.deepEqual(devices, ["lo"])
  assert.notEqual(await readlink("/proc/self/ns/net"), process.env.PHASE14_HOST_NET)
  assert.notEqual(await readlink("/proc/self/ns/mnt"), process.env.PHASE14_HOST_MNT)
  assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1)
  const descriptors = await Promise.all(
    (await readdir("/proc/self/fd")).map(async (fd) => ({
      fd,
      target: await readlink(`/proc/self/fd/${fd}`).catch(() => "closed"),
    })),
  )
  assert(descriptors.every((entry) => !entry.target.startsWith("socket:")))
  await writeFile(
    `${directory}/isolation.json`,
    JSON.stringify(
      {
        devices,
        descriptors,
        ipv4: await readFile("/proc/net/route", "utf8"),
        ipv6: await readFile("/proc/net/ipv6_route", "utf8"),
        net: await readlink("/proc/self/ns/net"),
        mount: await readlink("/proc/self/ns/mnt"),
        cgroup: await readFile("/proc/self/cgroup", "utf8"),
      },
      null,
      2,
    ),
  )
  const identity = await run([candidate, "--version"])
  assert.equal(identity.exitCode, 0)
  assert.equal(identity.stdout.trim(), "0.0.0-candidate-r6-68545e439b09-catalogue82eb03a3")
  await writeFile(`${directory}/version.json`, JSON.stringify(identity))
  const results = []
  for (const file of ["compiled-codex.test.ts", "handoff-restart.test.ts", "embedded-catalogue-restart.test.ts"]) {
    const result = await run(
      ["/usr/bin/bun", "--no-env-file", "--no-install", "test", `./test/server/${file}`],
      packageDir,
      {
        ...process.env,
        PHASE14_SUPPLEMENT: file === "embedded-catalogue-restart.test.ts" ? "1" : "0",
      },
    )
    await writeFile(`${directory}/${file}.stdout.log`, result.stdout)
    await writeFile(`${directory}/${file}.stderr.log`, result.stderr)
    // Keep configured and embedded wire evidence separate, even on a failed case.
    for (const transport of ["http", "ws"]) {
      const wire = `${directory}/${transport}-wire.json`
      if (await Bun.file(wire).exists()) {
        await writeFile(`${directory}/${file}.${transport}-wire.json`, await readFile(wire))
      }
    }
    results.push({ file, exitCode: result.exitCode })
    await writeFile(`${directory}/tests.json`, JSON.stringify(results, null, 2))
    if (result.exitCode !== 0) process.exit(result.exitCode)
  }
  const typecheck = await run(["/usr/bin/bun", "typecheck"])
  await writeFile(`${directory}/typecheck.json`, JSON.stringify(typecheck))
  process.exit(typecheck.exitCode)
}

assert.equal(await realpath(root), root)
assert.equal(await hash(previous), "8cc31ce47c9bf1dbcf436bdfd4522c87c3ca63397d39754bd82b0128d914e4eb")
assert.equal(await hash(previousPatch), "653198ad80776328d43bb5581d1a458e103a824f163cc528dcaf6c3128e486ac")
assert.equal(await hash(candidate), expected)
const directory = await mkdtemp("/tmp/opencode/phase14-catalogue.")
console.log(`PHASE14_DIRECTORY=${directory}`)
const before = {
  candidate: await hash(candidate),
  catalogue: await hash(catalogue),
  previous: await hash(previous),
  previousPatch: await hash(previousPatch),
  head: (await run(["git", "rev-parse", "HEAD"], root)).stdout.trim(),
}
const manifest = JSON.parse(await readFile(`${artifacts}/native-source-manifest-v4-r6.json`, "utf8")) as {
  source: { files: { path: string; sha256: string }[] }
}
for (const file of manifest.source.files.filter((file) => !file.path.startsWith("packages/opencode/test/")))
  assert.equal(await hash(`${root}/${file.path}`), file.sha256, file.path)
for (const name of ["home", "config", "data", "cache", "state", "tmp", "managed"])
  await mkdir(`${directory}/${name}`, { mode: 0o700 })
await writeFile(`${directory}/catalogue.json`, await readFile(catalogue))
// Reuse only the disposable CA fixture material, never credentials or state.
for (const name of ["ca.pem", "server.pem", "server.key"])
  await writeFile(`${directory}/${name}`, await readFile(`/tmp/opencode/phase14-oauth.TbD0P8/${name}`))
const env = {
  PATH: "/usr/bin:/bin",
  HOME: `${directory}/home`,
  TMPDIR: `${directory}/tmp`,
  XDG_CONFIG_HOME: `${directory}/config`,
  XDG_DATA_HOME: `${directory}/data`,
  XDG_CACHE_HOME: `${directory}/cache`,
  XDG_STATE_HOME: `${directory}/state`,
  OPENCODE_TEST_HOME: `${directory}/home`,
  OPENCODE_TEST_MANAGED_CONFIG_DIR: `${directory}/managed`,
  OPENCODE_DB: `${directory}/qualification.sqlite`,
  OPENCODE_CONFIG_CONTENT: "{}",
  BUN_OPTIONS: "--no-env-file --no-install",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: `${directory}/cache/transpiler`,
  PHASE14_DIR: directory,
  PHASE14_COMPILED: "1",
  PHASE14_ISOLATED: "1",
  PHASE14_PINNED_CATALOGUE: `${directory}/catalogue.json`,
  PHASE14_HOST_NET: await readlink("/proc/self/ns/net"),
  PHASE14_HOST_MNT: await readlink("/proc/self/ns/mnt"),
}
const command = [
  "/usr/bin/bwrap",
  "--unshare-net",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--die-with-parent",
  "--new-session",
  "--ro-bind",
  "/",
  "/",
  "--tmpfs",
  "/home",
  "--ro-bind",
  root,
  root,
  "--tmpfs",
  "/tmp",
  "--bind",
  directory,
  directory,
  "--ro-bind",
  candidate,
  candidate,
  "--tmpfs",
  "/run",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--clearenv",
  ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
  "--chdir",
  packageDir,
  "/usr/bin/bun",
  "--no-env-file",
  "--no-install",
  script,
  "--inside",
]
const stdout = openSync(`${directory}/namespace.stdout.log`, "wx", 0o600)
const stderr = openSync(`${directory}/namespace.stderr.log`, "wx", 0o600)
const child = Bun.spawn(command, { cwd: packageDir, env: process.env, stdin: "ignore", stdout, stderr })
const exitCode = await child.exited
closeSync(stdout)
closeSync(stderr)
const after = {
  candidate: await hash(candidate),
  catalogue: await hash(catalogue),
  previous: await hash(previous),
  previousPatch: await hash(previousPatch),
}
for (const file of manifest.source.files.filter((file) => !file.path.startsWith("packages/opencode/test/")))
  assert.equal(await hash(`${root}/${file.path}`), file.sha256, file.path)
assert.equal(after.candidate, before.candidate)
assert.equal(after.catalogue, before.catalogue)
assert.equal(after.previous, before.previous)
assert.equal(after.previousPatch, before.previousPatch)
await writeFile(
  `${directory}/attempt.json`,
  JSON.stringify({ before, after, command, exitCode, namespaceStopped: true }, null, 2),
)
console.log(
  JSON.stringify({
    directory,
    exitCode,
    candidateUnchanged: true,
    previousArtifactsUnchanged: true,
    namespaceStopped: true,
  }),
)
process.exitCode = exitCode
