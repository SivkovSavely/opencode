import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { ManagedLinux } from "../../src/tool/shell/managed-linux"
import { ManagedPidfd } from "../../src/tool/shell/managed-linux-pidfd"

const root = await mkdtemp(path.join(tmpdir(), "opencode-managed-"))
const toolchain = (await Bun.$`rustc --print sysroot`.text()).trim()
const fixture = path.join(root, "probe")

beforeAll(async () => {
  await Bun.write(
    `${fixture}.rs`,
    `
use std::{env, fs, thread, time::Duration, process::Command};
use std::os::unix::net::UnixStream;
use std::net::{TcpListener, TcpStream};
unsafe extern "C" {
  fn fork() -> i32; fn setsid() -> i32; fn signal(n: i32, handler: usize) -> usize;
  fn getppid() -> i32; fn raise(n: i32) -> i32;
  fn ptrace(request: u32, pid: i32, address: usize, data: usize) -> isize;
  fn pidfd_open(pid: i32, flags: u32) -> i32;
  fn pidfd_getfd(pidfd: i32, fd: i32, flags: u32) -> i32;
  fn close(fd: i32) -> i32;
}
fn main() {
  let args: Vec<String> = env::args().collect();
  match args[1].as_str() {
    "tree" | "orphan" => {
      unsafe {
        if fork() == 0 {
          setsid(); signal(15, 1); signal(2, 1);
          if fork() > 0 { std::process::exit(0); }
          fs::write("descendant-ready", "ready").unwrap();
          loop { fs::write("heartbeat", "alive").unwrap(); thread::sleep(Duration::from_millis(10)); }
        }
      }
      while !std::path::Path::new("descendant-ready").exists() { thread::sleep(Duration::from_millis(1)); }
      fs::write("ready", "ready").unwrap();
      if args[1] == "orphan" {
        while !std::path::Path::new("release").exists() { thread::sleep(Duration::from_millis(1)); }
        return;
      }
      loop { thread::sleep(Duration::from_secs(1)); }
    }
    "restrictions" => {
      assert!(!std::path::Path::new(&args[2]).exists());
      assert!(!std::path::Path::new("/run/user").exists());
      assert!(!std::path::Path::new("/sys/fs/cgroup").exists());
      assert!(!std::path::Path::new("/proc/1/root/run/user").exists());
      assert!(env::var("DBUS_SESSION_BUS_ADDRESS").is_err());
      assert!(env::var("XDG_RUNTIME_DIR").is_err());
      assert!(env::var("SSH_AUTH_SOCK").is_err());
      assert!(UnixStream::connect(&args[3]).is_err());
      assert!(fs::write("/usr/bin/managed-test", "no").is_err());
      assert!(!Command::new("unshare").args(["-Ur", "true"]).status().unwrap().success());
      assert!(TcpStream::connect_timeout(&"1.1.1.1:80".parse().unwrap(), Duration::from_millis(100)).is_err());
      let listener = TcpListener::bind("127.0.0.1:0").unwrap();
      TcpStream::connect(listener.local_addr().unwrap()).unwrap();
      fs::write("allowed", "yes").unwrap();
      println!("restricted-loopback-ok");
    }
    "signal" => {
      unsafe { raise(args[2].parse().unwrap()); }
      panic!("signal did not terminate the probe");
    }
    "report-tamper" => {
      for fd in 3..64 {
        assert!(fs::symlink_metadata(format!("/proc/self/fd/{fd}")).is_err(), "inherited fd {fd}");
      }
      let parent = unsafe { getppid() };
      assert_eq!(fs::read_dir(format!("/proc/{parent}/fd")).unwrap_err().raw_os_error(), Some(13));
      assert_eq!(fs::OpenOptions::new().write(true).open(format!("/proc/{parent}/fd/3")).unwrap_err().raw_os_error(), Some(13));
      assert_eq!(unsafe { ptrace(16, parent, 0, 0) }, -1);
      let parentfd = unsafe { pidfd_open(parent, 0) };
      assert!(parentfd >= 0);
      assert_eq!(unsafe { pidfd_getfd(parentfd, 3, 0) }, -1);
      unsafe { close(parentfd); }
      assert!(!std::path::Path::new("/run/managed/result").exists());
      fs::write("/run/managed/result", r#"{"kind":"signal","signal":15,"coreDumped":false}"#).unwrap();
      std::os::unix::fs::symlink(&args[2], "/run/managed/dont-follow").unwrap();
      println!("{}", r#"{"kind":"signal","signal":15,"coreDumped":false}"#);
      eprintln!("{}", r#"{"kind":"exit","exitCode":143}"#);
    }
    _ => panic!("unknown mode")
  }
}
`,
  )
  const compile = Bun.spawn([path.join(toolchain, "bin/rustc"), `${fixture}.rs`, "-o", fixture], { stderr: "pipe" })
  const stderr = await new Response(compile.stderr).text()
  if ((await compile.exited) !== 0) throw new Error(stderr)
}, 30_000)

afterAll(() => rm(root, { recursive: true, force: true }))

async function workspace() {
  const dir = await mkdtemp(path.join(root, "work-"))
  await Bun.write(path.join(dir, "probe"), Bun.file(fixture))
  await Bun.$`chmod +x ${path.join(dir, "probe")}`
  return dir
}

async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

async function processes(token: string) {
  const found = await Promise.all(
    (await readdir("/proc"))
      .filter((x) => /^\d+$/.test(x))
      .map(async (pid) => {
        const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
        return cmd.split("\0").includes(token) && cmd.startsWith("/work/probe\0") ? Number(pid) : undefined
      }),
  )
  return found.filter((x): x is number => x !== undefined)
}

async function dead(pids: number[]) {
  await waitFor(
    async () =>
      (
        await Promise.all(
          pids.map(async (pid) => {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
            return !stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")
          }),
        )
      ).every(Boolean),
    "A real descendant survived namespace destruction",
  )
}

test("registration barrier, idempotent start, exit status and bounded combined output", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["/bin/sh", "-c", "touch admitted; yes out | head -c 100000; yes err | head -c 100000 >&2; exit 23"],
    timeoutMs: 10_000,
    outputBytes: 4096,
  })
  expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(false)
  const first = handle.start()
  expect(handle.start()).toBe(first)
  const result = await first
  expect(result.cleanupError).toBeUndefined()
  expect(result.cleanup).toBe("confirmed")
  expect(result.shellStatus).toBe(23)
  expect(result.termination).toEqual({ kind: "exit", exitCode: 23 })
  expect(result.exitCode).toBe(23)
  expect(result.signal).toBeNull()
  expect(result.stdout.length + result.stderr.length).toBe(4096)
  expect(result.truncated).toBe(true)
  expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(true)
})

test("cancellation before admission never starts code", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "unexpected"], timeoutMs: 1000 })
  handle.cancel()
  expect((await handle.start()).cleanup).toBe("confirmed")
  expect(await Bun.file(path.join(dir, "unexpected")).exists()).toBe(false)
})

test("paused namespace requires synchronous authorization and positively acknowledges token consumption", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["/bin/sh", "-c", "touch admitted; printf 'user-output'; exit 23"],
    timeoutMs: 10_000,
  })
  expect(handle.phase).toBe("prepared")
  expect(handle.completion).toBeUndefined()
  expect(handle.authorize()).toBe(false)
  const ready = handle.startPaused()
  expect(handle.startPaused()).toBe(ready)
  expect(handle.authorize()).toBe(false)
  expect(await ready).toBe(true)
  expect(handle.phase).toBe("ready")
  await Bun.sleep(50)
  expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(false)
  // This block contains no await: it can be called inside a synchronous registry transaction.
  expect(handle.authorize()).toBe(true)
  expect(handle.phase).toBe("authorized")
  expect(handle.authorize()).toBe(false)
  expect(await handle.authorizationAcknowledged).toBe(true)
  const result = await handle.completion!
  expect(result.reason).toBe("exit")
  expect(result.shellStatus).toBe(23)
  expect(result.stdout.toString()).toBe("user-output")
  expect(result.cleanup).toBe("confirmed")
  expect(handle.phase).toBe("completed")
  expect(handle.authorize()).toBe(false)
})

test("start remains a standalone shortcut for a previously paused launch", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "admitted"], timeoutMs: 1000 })
  expect(await handle.startPaused()).toBe(true)
  const done = handle.start()
  expect(handle.start()).toBe(done)
  expect((await done).cleanup).toBe("confirmed")
  expect(await handle.authorizationAcknowledged).toBe(true)
  expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(true)
})

test("start invokes the ownership callback once and opens synchronously under its fence", async () => {
  const dir = await workspace()
  const calls: string[] = []
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["/bin/sh", "-c", "touch admitted; exit 23"],
    timeoutMs: 1000,
    authorize: async (open) => {
      calls.push("checking")
      expect(handle.phase).toBe("ready")
      expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(false)
      open()
      expect(handle.phase).toBe("authorized")
      calls.push("opened")
      return true
    },
  })
  const started = handle.start()
  expect(handle.start()).toBe(started)
  const result = await started
  expect(calls).toEqual(["checking", "opened"])
  expect(result.reason).toBe("exit")
  expect(result.shellStatus).toBe(23)
  expect(result.cleanup).toBe("confirmed")
  expect(await handle.authorizationAcknowledged).toBe(true)
  expect(await Bun.file(path.join(dir, "admitted")).exists()).toBe(true)
})

for (const decision of ["denied", "rejected", "throw", "missing-open"] as const) {
  test(`ownership callback ${decision} cannot start code and joins namespace cleanup`, async () => {
    const dir = await workspace()
    const failure = new Error("retired ownership")
    await using handle = await ManagedLinux.prepare({
      workspace: dir,
      argv: ["touch", "escaped"],
      timeoutMs: 1000,
      authorize: () => {
        expect(handle.phase).toBe("ready")
        if (decision === "throw") throw failure
        if (decision === "rejected") return Promise.reject(failure)
        return Promise.resolve(decision === "missing-open")
      },
    })
    const started = handle.start()
    if (decision === "rejected" || decision === "throw") await expect(started).rejects.toBe(failure)
    if (decision === "denied" || decision === "missing-open") expect((await started).reason).toBe("cancelled")
    const result = await handle.completion!
    expect(result.cleanupError).toBeUndefined()
    expect(result.cleanup).toBe("confirmed")
    expect(handle.phase).toBe("completed")
    expect(await handle.authorizationAcknowledged).toBe(false)
    expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
  })
}

test("retirement wins a delayed ownership transaction and denies its closed gate", async () => {
  const dir = await workspace()
  const entered = Promise.withResolvers<void>()
  const transaction = Promise.withResolvers<void>()
  const ownership = { retired: false }
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["touch", "escaped"],
    timeoutMs: 1000,
    authorize: async (open) => {
      entered.resolve()
      await transaction.promise
      // Simulate the durable retirement check and synchronous gate write under one lock.
      if (ownership.retired) return false
      open()
      return true
    },
  })
  const started = handle.start()
  await entered.promise
  expect(handle.phase).toBe("ready")
  ownership.retired = true
  transaction.resolve()
  const result = await started
  expect(result.reason).toBe("cancelled")
  expect(result.cleanup).toBe("confirmed")
  expect(await handle.authorizationAcknowledged).toBe(false)
  expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
})

test("rejection after irreversible publication still destroys and joins already-running descendants", async () => {
  const dir = await workspace()
  const token = crypto.randomUUID()
  const observed = { pids: [] as number[] }
  const failure = new Error("transaction failed after publication")
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["/work/probe", "tree", token],
    timeoutMs: 10_000,
    authorize: async (open) => {
      open()
      await waitFor(() => Bun.file(path.join(dir, "ready")).exists(), "Authorized probe did not start")
      observed.pids = await processes(token)
      throw failure
    },
  })
  await expect(handle.start()).rejects.toBe(failure)
  expect(observed.pids.length).toBeGreaterThanOrEqual(2)
  expect((await handle.completion!).cleanup).toBe("confirmed")
  await dead(observed.pids)
  expect(await processes(token)).toEqual([])
}, 20_000)

for (const stop of ["cancel", "timeout"] as const) {
  test(`${stop} joins a namespace without waiting for a stalled ownership callback and revokes late open`, async () => {
    const dir = await workspace()
    const entered = Promise.withResolvers<() => void>()
    const transaction = Promise.withResolvers<boolean>()
    await using handle = await ManagedLinux.prepare({
      workspace: dir,
      argv: ["touch", "escaped"],
      timeoutMs: stop === "timeout" ? 250 : 1000,
      authorize: (open) => {
        entered.resolve(open)
        return transaction.promise
      },
    })
    const started = handle.start()
    const open = await entered.promise
    if (stop === "cancel") handle.cancel()
    const result = await started
    expect(result.reason).toBe(stop === "cancel" ? "cancelled" : "timeout")
    expect(result.cleanup).toBe("confirmed")
    expect(open).toThrow("authorization is no longer valid")
    transaction.reject(new Error("late database rejection"))
    await Bun.sleep(10)
    expect(await handle.authorizationAcknowledged).toBe(false)
    expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
  })
}

test("cancellation before launch and while paused permanently denies authorization", async () => {
  for (const launch of [false, true]) {
    const dir = await workspace()
    await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "escaped"], timeoutMs: 1000 })
    if (launch) expect(await handle.startPaused()).toBe(true)
    const done = handle.cancel()
    expect(handle.authorize()).toBe(false)
    expect((await done).cleanup).toBe("confirmed")
    expect(await handle.authorizationAcknowledged).toBe(false)
    expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
    expect(await handle.startPaused()).toBe(launch)
    expect(await handle.start()).toBe(await done)
  }
})

test("paused timeout destroys the namespace without ever starting user code", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "escaped"], timeoutMs: 1000 })
  expect(await handle.startPaused()).toBe(true)
  const result = await handle.completion!
  expect(result.reason).toBe("timeout")
  expect(result.termination).toEqual({ kind: "unreported" })
  // The gate may exit on EOF (125), be killed (137), or lose its status report.
  expect([null, 125, 137]).toContain(result.shellStatus)
  expect([null, "SIGKILL"]).toContain(result.supervisorSignal)
  expect(result.cleanup).toBe("confirmed")
  expect(handle.authorize()).toBe(false)
  expect(await handle.authorizationAcknowledged).toBe(false)
  expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
})

test("synchronous authorization checks the deadline even when timer callbacks cannot run", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "escaped"], timeoutMs: 1000 })
  expect(await handle.startPaused()).toBe(true)
  const until = performance.now() + 1100
  while (performance.now() < until) {}
  expect(handle.authorize()).toBe(false)
  expect((await handle.completion!).reason).toBe("timeout")
  expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
})

test("missing command reports an actual child exit 127 plus exec failure errno", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({ workspace: dir, argv: ["/missing-program"], timeoutMs: 1000 })
  const result = await handle.start()
  expect(result.reason).toBe("exit")
  expect(result.shellStatus).toBe(127)
  expect(result.exitCode).toBe(127)
  expect(result.signal).toBeNull()
  expect(result.termination).toEqual({ kind: "exec-error", exitCode: 127, errno: 2 })
  expect(result.stderr.toString()).toContain("/missing-program")
  expect(result.cleanup).toBe("confirmed")
})

test("cancellation during startup never executes code and cannot hide unobserved cleanup", async () => {
  const dir = await workspace()
  const handle = await ManagedLinux.prepare({ workspace: dir, argv: ["touch", "unexpected"], timeoutMs: 1000 })
  const started = handle.start()
  const result = await handle.cancel()
  expect(await started).toBe(result)
  expect(result.reason).toBe("cancelled")
  expect(await Bun.file(path.join(dir, "unexpected")).exists()).toBe(false)
  if (result.cleanup === "failed") {
    expect(result.cleanupError).toBeDefined()
    await expect(handle[Symbol.asyncDispose]()).rejects.toThrow()
  }
})

test("retains shell-style signal status without confusing it with cancellation", async () => {
  const dir = await workspace()
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    argv: ["/bin/sh", "-c", "kill -TERM $$"],
    timeoutMs: 1000,
  })
  const result = await handle.start()
  expect(result.reason).toBe("exit")
  expect(result.shellStatus).toBe(143)
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBe(15)
  expect(result.termination).toEqual({ kind: "signal", signal: 15, coreDumped: false })
  expect(result.supervisorSignal).toBeNull()
  expect(result.cleanup).toBe("confirmed")
})

test("raw wait distinguishes explicit exit 143 from SIGTERM despite identical bwrap JSON", async () => {
  const results = await Promise.all(
    ["exit 143", "kill -TERM $$"].map(async (command) => {
      await using handle = await ManagedLinux.prepare({
        workspace: await workspace(),
        argv: ["/bin/sh", "-c", command],
        timeoutMs: 1000,
      })
      return await handle.start()
    }),
  )
  for (const result of results) {
    expect(result.reason).toBe("exit")
    expect(result.shellStatus).toBe(143)
    expect(result.supervisorSignal).toBeNull()
    expect(result.cleanup).toBe("confirmed")
  }
  expect(results[0]!.termination).toEqual({ kind: "exit", exitCode: 143 })
  expect(results[0]!.exitCode).toBe(143)
  expect(results[0]!.signal).toBeNull()
  expect(results[1]!.termination).toEqual({ kind: "signal", signal: 15, coreDumped: false })
  expect(results[1]!.exitCode).toBeNull()
  expect(results[1]!.signal).toBe(15)
})

test("raw wait preserves explicit high exit codes without inferring signals", async () => {
  for (const code of [0, 128, 129, 192, 193, 255]) {
    await using handle = await ManagedLinux.prepare({
      workspace: await workspace(),
      argv: ["/bin/sh", "-c", `exit ${code}`],
      timeoutMs: 1000,
    })
    const result = await handle.start()
    expect(result.shellStatus).toBe(code)
    expect(result.termination).toEqual({ kind: "exit", exitCode: code })
    expect(result.exitCode).toBe(code)
    expect(result.signal).toBeNull()
    expect(result.cleanup).toBe("confirmed")
  }
})

for (const signal of [9, 15, 64]) {
  test(`raw wait reports actual signal ${signal} separately from an exit code`, async () => {
    await using handle = await ManagedLinux.prepare({
      workspace: await workspace(),
      argv: ["/work/probe", "signal", String(signal)],
      timeoutMs: 1000,
      outputBytes: 0,
    })
    const result = await handle.start()
    expect(result.reason).toBe("exit")
    expect(result.termination).toEqual({ kind: "signal", signal, coreDumped: false })
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe(signal)
    expect(result.shellStatus).toBe(128 + signal)
    expect(result.supervisorSignal).toBeNull()
    expect(result.cleanup).toBe("confirmed")
  })
}

test("report channel resists fd inheritance, proc reopen, ptrace, path replacement and forged output", async () => {
  const secret = path.join(root, "report-host-secret")
  await Bun.write(secret, "untouched")
  await using handle = await ManagedLinux.prepare({
    workspace: await workspace(),
    argv: ["/work/probe", "report-tamper", secret],
    timeoutMs: 10_000,
  })
  expect(await handle.startPaused()).toBe(true)
  const commands = await Promise.all(
    (await readdir("/proc"))
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0")),
  )
  const monitor = commands.find((args) => args[0] === "/usr/bin/bwrap" && args.includes(secret))
  expect(monitor).toBeDefined()
  const image = monitor![monitor!.indexOf("/managed-wait") - 1]!
  const privateDir = path.dirname(image)
  expect(await readdir(privateDir)).toContain("wait")
  const result = await handle.start()
  expect(result.reason).toBe("exit")
  expect(result.termination).toEqual({ kind: "exit", exitCode: 0 })
  expect(result.exitCode).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.stdout.toString()).toContain('"signal":15')
  expect(result.stderr.toString()).toContain('"exitCode":143')
  expect(result.cleanup).toBe("confirmed")
  expect(await Bun.file(secret).text()).toBe("untouched")
  await expect(readdir(privateDir)).rejects.toMatchObject({ code: "ENOENT" })
})

test("killing the wait reporter produces unreported status, never an inferred command signal", async () => {
  await using handle = await ManagedLinux.prepare({
    workspace: await workspace(),
    argv: ["/bin/sh", "-c", "kill -KILL $PPID; while :; do :; done"],
    timeoutMs: 1000,
  })
  const result = await handle.start()
  expect(result.reason).toBe("setup-failed")
  expect(result.termination).toEqual({ kind: "unreported" })
  expect(result.exitCode).toBeNull()
  expect(result.signal).toBeNull()
  expect(result.shellStatus).toBe(137)
  expect(result.cleanup).toBe("confirmed")
})

for (const mode of ["cancel", "timeout", "normal-exit"] as const) {
  test(`${mode} destroys double-forked setsid descendants ignoring signals`, async () => {
    const dir = await workspace()
    const token = crypto.randomUUID()
    await using handle = await ManagedLinux.prepare({
      workspace: dir,
      argv: ["/work/probe", mode === "normal-exit" ? "orphan" : "tree", token],
      timeoutMs: mode === "timeout" ? 1500 : 10_000,
    })
    const result = handle.start()
    await waitFor(() => Bun.file(path.join(dir, "ready")).exists(), "Probe did not become ready")
    const pids = await processes(token)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    if (mode === "normal-exit") await Bun.write(path.join(dir, "release"), "release")
    if (mode === "cancel") handle.cancel()
    const done = await result
    expect(done.cleanupError).toBeUndefined()
    expect(done.cleanup).toBe("confirmed")
    expect(done.reason).toBe(mode === "normal-exit" ? "exit" : mode === "cancel" ? "cancelled" : "timeout")
    await dead(pids)
    expect(await processes(token)).toEqual([])
  }, 20_000)
}

test("pidfd destroys an orphan namespace even when init has no parent-death signal", async () => {
  const dir = await workspace()
  const token = crypto.randomUUID()
  const native = await ManagedPidfd.load()
  const child = spawn(
    "/usr/bin/bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup",
      "--disable-userns",
      "--assert-userns-disabled",
      "--cap-drop",
      "ALL",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr/bin",
      "/usr/bin",
      "--ro-bind",
      "/usr/lib",
      "/usr/lib",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      dir,
      "/work",
      "--chdir",
      "/work",
      "--json-status-fd",
      "3",
      "--",
      "/work/probe",
      "tree",
      token,
    ],
    { env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  )
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve())
    child.once("error", reject)
  })
  const errors: Buffer[] = []
  child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk))
  child.stdout!.resume()
  const observed: { target?: ReturnType<typeof native.monitor>; closed?: boolean } = {}
  try {
    for await (const line of createInterface({ input: child.stdio[3] as Readable })) {
      const info: unknown = JSON.parse(line)
      if (typeof info !== "object" || !info || !("child-pid" in info) || typeof info["child-pid"] !== "number") continue
      observed.target = native.monitor(info["child-pid"])
      break
    }
    if (!observed.target) {
      await exited
      throw new Error(`No namespace identity: ${Buffer.concat(errors)}`)
    }
    await waitFor(() => Bun.file(path.join(dir, "ready")).exists(), "Namespace probe did not start")
    const pids = await processes(token)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    child.kill("SIGKILL")
    await exited
    await Bun.sleep(25)
    // Deliberately no --die-with-parent: monitor-only termination really leaves these alive.
    expect((await processes(token)).length).toBeGreaterThanOrEqual(2)
    observed.target!.kill()
    await dead(pids)
    expect(await processes(token)).toEqual([])
    // Signalling the old handle again cannot target a numerically reused PID.
    observed.target!.kill()
    observed.target!.close()
    observed.closed = true
    expect(() => observed.target!.kill()).toThrow("Closed namespace pidfd")
  } finally {
    if (!observed.closed) observed.target?.kill()
    observed.target?.close()
    native.close()
    child.kill("SIGKILL")
    await exited
  }
}, 20_000)

test("supervisor SIGKILL destroys admitted descendants independently of launcher reporting", async () => {
  const dir = await workspace()
  const token = crypto.randomUUID()
  const driver = path.join(root, "driver.ts")
  await Bun.write(
    driver,
    `import { ManagedLinux } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/shell/managed-linux.ts"))};
const h = await ManagedLinux.prepare({ workspace: ${JSON.stringify(dir)}, argv: ["/work/probe", "tree", ${JSON.stringify(token)}], timeoutMs: 60000 }); await h.start();`,
  )
  const parent = Bun.spawn([process.execPath, driver], {
    env: { ...process.env, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    await waitFor(() => Bun.file(path.join(dir, "ready")).exists(), "Child supervisor did not start probe")
    const pids = await processes(token)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    parent.kill("SIGKILL")
    await parent.exited
    await dead(pids)
    expect(await processes(token)).toEqual([])
  } finally {
    parent.kill("SIGKILL")
    await parent.exited
  }
}, 20_000)

test("supervisor death immediately after requesting launch cannot release the startup gate on EOF", async () => {
  for (const iteration of Array.from({ length: 5 }, (_, i) => i)) {
    const dir = await workspace()
    const token = crypto.randomUUID()
    const driver = path.join(root, `early-driver-${iteration}.ts`)
    await Bun.write(
      driver,
      `import { ManagedLinux } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/shell/managed-linux.ts"))};
const h = await ManagedLinux.prepare({ workspace: ${JSON.stringify(dir)}, argv: ["/bin/sh", "-c", "touch escaped", ${JSON.stringify(token)}], timeoutMs: 60000 }); h.start(); process.kill(process.pid, "SIGKILL");`,
    )
    const parent = Bun.spawn([process.execPath, driver], {
      env: { ...process.env, TMPDIR: root },
      stdout: "pipe",
      stderr: "pipe",
    })
    await parent.exited
    await waitFor(
      async () =>
        !(
          await Promise.all(
            (await readdir("/proc"))
              .filter((x) => /^\d+$/.test(x))
              .map(async (pid) =>
                (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").includes(token),
              ),
          )
        ).some(Boolean),
      "Early startup left a supervisor or sandbox alive",
    )
    expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
  }
}, 20_000)

test("supervisor death with an acknowledged paused namespace never permits user code", async () => {
  const dir = await workspace()
  const token = crypto.randomUUID()
  const driver = path.join(root, "paused-driver.ts")
  await Bun.write(
    driver,
    `
import { ManagedLinux } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/shell/managed-linux.ts"))};
const h = await ManagedLinux.prepare({ workspace: ${JSON.stringify(dir)}, argv: ["/bin/sh", "-c", "touch escaped", ${JSON.stringify(token)}], timeoutMs: 60000 });
if (!(await h.startPaused())) throw new Error("not ready");
console.log("paused");
await h.completion;
`,
  )
  const parent = Bun.spawn([process.execPath, driver], {
    env: { ...process.env, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = parent.stdout.getReader()
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("paused")
    // The trusted gate helper and bwrap carry the token, but user code has not executed.
    const pids = (await readdir("/proc")).filter((x) => /^\d+$/.test(x))
    const matching = (
      await Promise.all(
        pids.map(async (pid) =>
          (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").includes(token)
            ? Number(pid)
            : undefined,
        ),
      )
    ).filter((pid): pid is number => pid !== undefined)
    expect(matching.length).toBeGreaterThanOrEqual(2)
    parent.kill("SIGKILL")
    await parent.exited
    await dead(matching)
    expect(await Bun.file(path.join(dir, "escaped")).exists()).toBe(false)
  } finally {
    reader.releaseLock()
    parent.kill("SIGKILL")
    await parent.exited
  }
}, 20_000)

test("targeted mounts deny host IPC, cgroups, userns and external network but allow loopback", async () => {
  const dir = await workspace()
  const secret = path.join(root, "secret")
  const socket = path.join(root, "control.sock")
  await Bun.write(secret, "host-only")
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    await using handle = await ManagedLinux.prepare({
      workspace: dir,
      argv: ["/work/probe", "restrictions", secret, socket],
      timeoutMs: 10_000,
    })
    const result = await handle.start()
    expect(result.stderr.toString()).toContain("unshare failed")
    expect(result.stdout.toString()).toContain("restricted-loopback-ok")
    expect(result.shellStatus).toBe(0)
    expect(result.cleanup).toBe("confirmed")
    expect(await Bun.file(path.join(dir, "allowed")).text()).toBe("yes")
  } finally {
    server.close()
  }
})

test("rejects socket-bearing workspace and unsafe options", async () => {
  const dir = await workspace()
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(path.join(dir, "control.sock"), resolve))
  try {
    await expect(ManagedLinux.prepare({ workspace: dir, argv: ["true"], timeoutMs: 1000 })).rejects.toThrow(
      "Special file",
    )
  } finally {
    server.close()
  }
  await expect(ManagedLinux.prepare({ workspace: "/", argv: ["true"], timeoutMs: 1000 })).rejects.toThrow(
    "root or home",
  )
  await expect(ManagedLinux.prepare({ workspace: dir, argv: ["true"], timeoutMs: Infinity })).rejects.toThrow(
    "timeoutMs",
  )
})

test("compiles and runs a disposable offline Rust Cargo project", async () => {
  const dir = await workspace()
  await mkdir(path.join(dir, "src"))
  await Bun.write(
    path.join(dir, "Cargo.toml"),
    '[package]\nname = "managed_probe"\nversion = "0.1.0"\nedition = "2021"\n',
  )
  await Bun.write(path.join(dir, "src/main.rs"), 'fn main() { println!("rust-sandbox-ok"); }')
  await using handle = await ManagedLinux.prepare({
    workspace: dir,
    rustToolchain: toolchain,
    argv: ["cargo", "run", "--offline"],
    timeoutMs: 30_000,
  })
  const result = await handle.start()
  expect(result.stderr.toString()).toContain("Finished")
  expect(result.stdout.toString()).toContain("rust-sandbox-ok")
  expect(result.shellStatus).toBe(0)
  expect(result.cleanup).toBe("confirmed")
}, 40_000)
