import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { closeSync, createReadStream, openSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

process.umask(0o077)
const root = "/home/savochek/ExternalProjects/opencode"
const candidate = "/tmp/opencode/phase13-build.nejsA8/opencode-candidate-r6"
const expected = "737a999e672b91ee9b770a73d598bb3f6cc2e7aa841bcaa4bc421f70a311b7b1"
const version = "0.0.0-candidate-r6-68545e439b09-catalogue82eb03a3"
const packageDir = `${root}/packages/opencode`
const script = `${packageDir}/test/server/fixtures/compiled-qualification.ts`
assert((await readFile("/proc/self/cgroup", "utf8")).includes("baila-build.slice"))

async function hash(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function run(args: string[], cwd = packageDir) {
  const child = Bun.spawn(args, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { args, exitCode, stdout, stderr }
}

if (process.argv.includes("--publish")) {
  const directories = process.argv.slice(process.argv.indexOf("--publish") + 1)
  const directory = directories.at(-1)
  assert(directory && directory.startsWith("/tmp/opencode/phase14-oauth."))
  assert.equal(await realpath(root), root)
  const artifactDir = "/tmp/opencode/model-handoff-recovery-20261115"
  const manifest = JSON.parse(await readFile(`${artifactDir}/native-source-manifest-v4-r6.json`, "utf8")) as {
    source: { files: { path: string; sha256: string }[] }
  }
  const frozenPatch = await readFile(`${artifactDir}/native-source-v4-r6.patch`, "utf8")
  const files = [
    "packages/opencode/test/server/handoff-restart.test.ts",
    "packages/opencode/test/server/compiled-codex.test.ts",
    "packages/opencode/test/server/fixtures/compiled-codex.ts",
    "packages/opencode/test/server/fixtures/compiled-qualification.ts",
  ]
  const harness = []
  const patch = []
  for (const file of files) {
    assert.equal(await realpath(`${root}/${file}`), `${root}/${file}`)
    const recorded = manifest.source.files.find((entry) => entry.path === file)
    const block = frozenPatch.split(`diff --git a/${file} b/${file}\n`)[1]?.split("\ndiff --git ")[0]
    const baseline =
      recorded && block
        ? block
            .split("\n")
            .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
            .map((line) => line.slice(1))
            .join("\n") + "\n"
        : ""
    const baselineFile: string = `${directory}/baseline-${path.basename(file)}`
    await writeFile(baselineFile, baseline, { mode: 0o600, flag: "wx" })
    if (recorded) assert.equal(await hash(baselineFile), recorded.sha256, `frozen test baseline: ${file}`)
    const diff = await run([
      "/usr/bin/diff",
      "-u",
      "--label",
      recorded ? `a/${file}` : "/dev/null",
      "--label",
      `b/${file}`,
      baselineFile,
      `${root}/${file}`,
    ])
    assert.equal(diff.exitCode, 1, `expected harness-only diff for ${file}`)
    patch.push(diff.stdout)
    harness.push({ path: file, frozenTestSha256: recorded?.sha256 ?? null, sha256: await hash(`${root}/${file}`) })
  }
  const patchFile = `${directory}/phase14-harness.patch`
  await writeFile(patchFile, patch.join(""), { mode: 0o600, flag: "wx" })
  const attempts = []
  for (const item of directories) {
    assert(item.startsWith("/tmp/opencode/phase14-oauth."))
    const evidence = await Promise.all(
      (await readdir(item))
        .filter((name) => /\.(json|ndjson|log)$/.test(name))
        .map(async (name) => ({ path: `${item}/${name}`, sha256: await hash(`${item}/${name}`) })),
    )
    attempts.push({ ...JSON.parse(await readFile(`${item}/attempt.json`, "utf8")), evidence })
  }
  const tests = JSON.parse(await readFile(`${directory}/tests.json`, "utf8")) as { file: string; exitCode: number }[]
  assert.equal(tests.length, 2)
  assert(tests.every((test) => test.exitCode === 0))
  const finalAttempt = attempts.at(-1)!
  assert.equal(finalAttempt.exitCode, 0)
  assert.equal(JSON.parse(await readFile(`${directory}/typecheck.json`, "utf8")).exitCode, 0)
  const frozen = manifest.source.files.filter((file) => !file.path.startsWith("packages/opencode/test/"))
  for (const file of frozen) assert.equal(await hash(`${root}/${file.path}`), file.sha256, file.path)
  assert.equal(await hash(candidate), expected)
  const parentFile = `${artifactDir}/parent-compiled-cross-qualification-r6-20261116.json`
  const parent = JSON.parse(await readFile(parentFile, "utf8"))
  const result = {
    artifact: "native-candidate-oauth-qualification-r6",
    phase: 14,
    recordedAt: new Date().toISOString(),
    compiledOAuthQualified: true,
    qualification: "exact compiled built-in OAuth HTTP and WSS recovery paths; not full package/API certification",
    candidate: {
      path: candidate,
      sha256Before: finalAttempt.before.candidate,
      sha256After: await hash(candidate),
      expectedVersion: version,
      versionEvidence: `${directory}/version.json`,
      rebuilt: false,
    },
    source: {
      root,
      commonGitDirectory: `${root}/.git`,
      head: finalAttempt.before.head,
      status: (await run(["git", "status", "--short", "--branch"], root)).stdout,
      frozenRuntimeFingerprint: "68545e439b0906b4c2ef4cf97cee46839fa0293fb1737a613905d864bab326d2",
      frozenManifestSha256: await hash(`${artifactDir}/native-source-manifest-v4-r6.json`),
      frozenNonHarnessFilesChecked: frozen.length,
      unchanged: true,
    },
    harness: { files: harness, patch: patchFile, patchSha256: await hash(patchFile), separateFromFrozenR6: true },
    isolation: JSON.parse(await readFile(`${directory}/isolation.json`, "utf8")),
    compiledServeProcesses: (await readFile(`${directory}/processes.ndjson`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    http: JSON.parse(await readFile(`${directory}/http-wire.json`, "utf8")),
    ws: JSON.parse(await readFile(`${directory}/ws-wire.json`, "utf8")),
    tests,
    typecheck: JSON.parse(await readFile(`${directory}/typecheck.json`, "utf8")),
    attempts,
    harnessFailuresAndCorrections: [
      "First bootstrap: test harness parse error (await in Effect generator), no candidate Serve launched; corrected to yield Effect.promise.",
      "First bootstrap stdout/stderr were Bun-created inherited socketpairs, not network connections. Subsequent launches use regular mode0600 files and assert zero inherited socket descriptors before any candidate execution.",
      "Second run: candidate WS scenario passed; HTTP client SIGKILL exposed uncaught AbortError in new TLS bridge. Dedicated client-disconnect regression reproduced RED in third run. Only the bridge's own AbortError cancellation is consumed; other stream failures are recorded and asserted absent. Fourth run passed both cases.",
      "Fifth run: both scenarios and safety regressions passed, but package typecheck found two test-only typing errors (DOM stream iteration and temporary filename inference). Switched to typed stream pipeTo and explicit filename type; final run includes package typecheck.",
    ],
    preservedParent: {
      path: parentFile,
      sha256: await hash(parentFile),
      combinedCompiled: parent.combinedCompiled,
      focusedCompiled: parent.focusedCompiled,
      limits: parent.limits,
    },
    priorNativeBroadFailures: {
      source: `${artifactDir}/native-implementation-result-v4-r6.json`,
      sha256: await hash(`${artifactDir}/native-implementation-result-v4-r6.json`),
      fullCoreTimeouts: 10,
      fullOpenCodeFailures: 129,
      interruptedR5CoreAndOpenCode: "exact exits and final totals unknown; not green",
      earlierIsolationIncident:
        "Earlier synthetic OAuth attempt reached nonloopback endpoint and received 401; denial proxy rejected npm attempts. Unwaived; not repeated here.",
      artifactIncident:
        "Original v4 manifest overwrite remains unrecovered and disclosed; no original or prior artifacts overwritten in Phase14.",
    },
    limits: [
      "All credentials and model data fabricated; no production state inspected.",
      "Proxy rejects public destinations other than auth.openai.com:443 and chatgpt.com:443 and terminates both locally; even allowed names never reach external DNS/network.",
      "Private CA added only to compiled candidate trust; TLS verification and hostname checks retained. Fixture negative tests reject untrusted certificate, wrong certificate name, wrong Host and disallowed CONNECT. Native candidate HTTPS refresh and WSS wire observed at owned endpoint.",
      "OPENCODE_PURE suppresses only external plugin loading; embedded Codex plugin remains enabled. No source Codex plugin injected.",
      "Credential refresh observed, not certified exactly-once.",
      "Historical raw structured-output failures and native broad-suite failures remain unwaived. No package green or production authorization claimed.",
    ],
    fullPackageSuitesPassed: false,
    productionAuthorized: false,
    productionDeployed: false,
    noBackgroundWriters: true,
    namespaceStopped: true,
  }
  const output = `${artifactDir}/native-candidate-oauth-qualification-r6.json`
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  console.log(JSON.stringify({ output, sha256: await hash(output), compiledOAuthQualified: true }))
  process.exit(0)
}

if (process.argv.includes("--inside")) {
  const directory = process.env.PHASE14_DIR
  assert(directory)
  assert.equal((await readlink("/proc/self/ns/net")) === process.env.PHASE14_HOST_NET, false)
  assert.equal((await readlink("/proc/self/ns/mnt")) === process.env.PHASE14_HOST_MNT, false)
  const devices = (await readFile("/proc/net/dev", "utf8"))
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.trim().split(":")[0])
  assert.deepEqual(devices, ["lo"])
  assert.equal((await readFile("/proc/net/route", "utf8")).trim().split("\n").length, 1)
  const isolation = {
    net: await readlink("/proc/self/ns/net"),
    mount: await readlink("/proc/self/ns/mnt"),
    cgroup: await readFile("/proc/self/cgroup", "utf8"),
    devices,
    ipv4Routes: await readFile("/proc/net/route", "utf8"),
    ipv6Routes: await readFile("/proc/net/ipv6_route", "utf8"),
    openDescriptors: await Promise.all(
      (await readdir("/proc/self/fd")).map(async (fd) => ({
        fd,
        target: await readlink(`/proc/self/fd/${fd}`).catch(() => "closed"),
      })),
    ),
  }
  assert(
    isolation.openDescriptors.every((entry) => !entry.target.startsWith("socket:")),
    "inherited socket",
  )
  await writeFile(`${directory}/isolation.json`, JSON.stringify(isolation, null, 2), { mode: 0o600 })
  const results = []
  const identity = await run([candidate, "--version"])
  assert.equal(identity.exitCode, 0)
  assert.equal(identity.stdout.trim(), version)
  await writeFile(`${directory}/version.json`, JSON.stringify(identity), { mode: 0o600 })
  for (const file of ["compiled-codex.test.ts", "handoff-restart.test.ts"]) {
    const result = await run(["/usr/bin/bun", "--no-env-file", "--no-install", "test", `./test/server/${file}`])
    await writeFile(`${directory}/${file}.stdout.log`, result.stdout, { mode: 0o600 })
    await writeFile(`${directory}/${file}.stderr.log`, result.stderr, { mode: 0o600 })
    results.push({ file, exitCode: result.exitCode })
    await writeFile(`${directory}/tests.json`, JSON.stringify(results, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(results.at(-1)))
    if (result.exitCode !== 0) process.exit(1)
  }
  const typecheck = await run(["/usr/bin/bun", "typecheck"])
  await writeFile(`${directory}/typecheck.stdout.log`, typecheck.stdout, { mode: 0o600 })
  await writeFile(`${directory}/typecheck.stderr.log`, typecheck.stderr, { mode: 0o600 })
  await writeFile(
    `${directory}/typecheck.json`,
    JSON.stringify({ exitCode: typecheck.exitCode, args: typecheck.args }),
    { mode: 0o600 },
  )
  process.exit(typecheck.exitCode)
}

const directory = await mkdtemp("/tmp/opencode/phase14-oauth.")
await chmod(directory, 0o700)
console.log(`PHASE14_DIRECTORY=${directory}`)
assert.equal(await hash(candidate), expected)
const before = {
  candidate: await hash(candidate),
  head: (await run(["git", "rev-parse", "HEAD"], root)).stdout.trim(),
  status: (await run(["git", "status", "--short", "--branch"], root)).stdout,
  manifest: await hash("/tmp/opencode/model-handoff-recovery-20261115/native-source-manifest-v4-r6.json"),
}
const manifest = JSON.parse(
  await readFile("/tmp/opencode/model-handoff-recovery-20261115/native-source-manifest-v4-r6.json", "utf8"),
) as { source: { files: { path: string; sha256: string }[] } }
const frozen = manifest.source.files.filter((file) => !file.path.startsWith("packages/opencode/test/"))
for (const file of frozen) assert.equal(await hash(path.join(root, file.path)), file.sha256, file.path)
await writeFile(`${directory}/before.json`, JSON.stringify(before, null, 2), { mode: 0o600 })
for (const dir of ["home", "config", "data", "cache", "state", "tmp", "managed"])
  await mkdir(`${directory}/${dir}`, { mode: 0o700 })
for (const args of [
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${directory}/ca.key`,
    "-out",
    `${directory}/ca.pem`,
    "-days",
    "1",
    "-subj",
    "/CN=Phase14 disposable CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ],
  [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${directory}/server.key`,
    "-out",
    `${directory}/server.csr`,
    "-subj",
    "/CN=auth.openai.com",
    "-addext",
    "subjectAltName=DNS:auth.openai.com,DNS:chatgpt.com",
  ],
  [
    "x509",
    "-req",
    "-in",
    `${directory}/server.csr`,
    "-CA",
    `${directory}/ca.pem`,
    "-CAkey",
    `${directory}/ca.key`,
    "-CAcreateserial",
    "-out",
    `${directory}/server.pem`,
    "-days",
    "1",
    "-copy_extensions",
    "copy",
  ],
]) {
  const result = await run(["/usr/bin/openssl", ...args])
  assert.equal(result.exitCode, 0, result.stderr)
}
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
  PHASE14_HOST_NET: await readlink("/proc/self/ns/net"),
  PHASE14_HOST_MNT: await readlink("/proc/self/ns/mnt"),
}
const args = [
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
const child = Bun.spawn(args, { cwd: packageDir, env: process.env, stdin: "ignore", stdout, stderr })
const result = { exitCode: await child.exited }
closeSync(stdout)
closeSync(stderr)
const unchanged = []
for (const file of frozen)
  unchanged.push({ path: file.path, unchanged: (await hash(path.join(root, file.path))) === file.sha256 })
const after = {
  candidate: await hash(candidate),
  status: (await run(["git", "status", "--short", "--branch"], root)).stdout,
  frozenFiles: unchanged,
}
assert.equal(after.candidate, expected)
assert(unchanged.every((file) => file.unchanged))
await writeFile(`${directory}/after.json`, JSON.stringify(after, null, 2), { mode: 0o600 })
await writeFile(
  `${directory}/attempt.json`,
  JSON.stringify(
    { directory, before, after, command: args, exitCode: result.exitCode, namespaceStopped: true },
    null,
    2,
  ),
  { mode: 0o600 },
)
console.log(
  JSON.stringify({
    directory,
    exitCode: result.exitCode,
    candidateUnchanged: true,
    runtimeUnchanged: true,
    namespaceStopped: true,
  }),
)
process.exitCode = result.exitCode
