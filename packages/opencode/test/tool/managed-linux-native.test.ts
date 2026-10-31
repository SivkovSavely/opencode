import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readlink, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { ManagedPidfd } from "../../src/tool/shell/managed-linux-pidfd"

for (const mode of ["cancel", "timeout", "gate-inside"] as const) {
  test(`${mode} joins a real stopped compiler worker and leaves no private artifacts`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-native-stall-"))
    try {
      const child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "fixtures/managed-compiler-stall.ts"), root, mode],
        {
          env: { ...process.env, TMPDIR: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(JSON.parse(stdout).tasks).toBeGreaterThanOrEqual(4)
      expect((await readdir(root)).filter((entry) => entry.startsWith("opencode-managed-"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const mode of ["success", "cancelled", "compile-failed"] as const) {
  test(`trusted native compilation ${mode} joins work and removes private artifacts despite poisoned compiler settings`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-native-"))
    try {
      const driver = path.join(root, "driver.ts")
      await Bun.write(
        driver,
        `
import { readdir, mkdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { ManagedWait } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/shell/managed-linux-wait.ts"))};
import { ManagedPidfd } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/shell/managed-linux-pidfd.ts"))};
const root = ${JSON.stringify(root)};
const workspace = root + "/workspace";
await mkdir(workspace);
const native = await ManagedPidfd.load();
let checks = 0;
const failure = new Error(${JSON.stringify(mode)});
const before = performance.now();
try {
  const helper = await ManagedWait.create(workspace, native, () => {
    checks++;
    if (${JSON.stringify(mode)} === "cancelled" && checks >= 4) throw failure;
    if (${JSON.stringify(mode)} === "compile-failed" && checks === 3) {
      const limit = Bun.spawnSync(["/usr/bin/prlimit", "--pid", String(process.pid), "--fsize=0:0"]);
      if (limit.exitCode !== 0) throw new Error("Cannot establish real compiler failure fixture");
    }
  });
  if (${JSON.stringify(mode)} !== "success") throw new Error("cancellation was ignored");
  const bytes = await readFile(helper.file);
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("not ELF");
  if (((await lstat(path.dirname(helper.file))).mode & 0o777) !== 0o700) throw new Error("not private");
  await helper.close();
  await helper.close();
} catch (error) {
  if (${JSON.stringify(mode)} === "compile-failed") {
    if (!String(error).includes("Cannot compile managed helper")) throw error;
  } else if (error !== failure) throw error;
} finally { native.close(); }
if ((await readdir(root)).some(x => x.startsWith("opencode-managed-"))) throw new Error("stale native artifacts");
console.log(JSON.stringify({checks, elapsed: performance.now() - before}));
`,
      )
      const child = Bun.spawn([process.execPath, driver], {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: root,
          PATH: root,
          CC: "/missing-compiler",
          CFLAGS: "--invalid-managed-flag",
          COMPILER_PATH: root,
          GCC_EXEC_PREFIX: `${root}/`,
          CPATH: root,
          LIBRARY_PATH: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(JSON.parse(stdout).checks).toBeGreaterThanOrEqual(4)
      expect((await readdir(root)).filter((entry) => entry.startsWith("opencode-managed-"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("pinned monitor rejects a non-init child in the same PID namespace", async () => {
  const native = await ManagedPidfd.load()
  const child = spawn(
    "/usr/bin/bwrap",
    [
      "--unshare-user",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--json-status-fd",
      "3",
      "--",
      "/usr/bin/sleep",
      "30",
    ],
    { env: {}, stdio: ["ignore", "ignore", "pipe", "pipe"] },
  )
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve())
    child.once("error", reject)
  })
  const monitor = native.monitor(child.pid!)
  try {
    expect(await readlink(`/proc/${child.pid}/ns/pid`)).toBe(await readlink("/proc/self/ns/pid"))
    for await (const line of createInterface({ input: child.stdio[3] as Readable })) {
      const info = JSON.parse(line)
      if (!("child-pid" in info)) continue
      expect(await readFile(`/proc/${info["child-pid"]}/status`, "utf8")).toContain("NSpid:")
      expect(() => monitor.captureNamespace(info["child-pid"])).toThrow("not init in a distinct PID namespace")
      return
    }
    throw new Error("Missing bwrap identity")
  } finally {
    monitor.kill()
    await exited
    expect(monitor.exited()).toBe(true)
    monitor.close()
    native.close()
  }
})
