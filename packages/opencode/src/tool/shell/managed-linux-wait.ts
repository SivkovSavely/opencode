import { closeSync, constants, openSync, readSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ManagedPidfd } from "./managed-linux-pidfd"

/** Trusted source only: neither the compiler nor its inputs come from the workspace. */
export async function create(workspace: string, native: Awaited<ReturnType<typeof ManagedPidfd.load>>, check: () => void) {
  check()
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-managed-wait-"))
  const descriptors: number[] = []
  try {
    const canonical = await realpath(dir)
    if (canonical === workspace || canonical.startsWith(`${workspace}/`))
      throw new Error("Managed helper directory must be outside the workspace")
    check()
    const file = path.join(dir, "wait.c")
    await writeFile(file, source, { mode: 0o600 })
    check()
    const control = path.join(dir, "control")
    await mkdir(control, { mode: 0o700 })
    check()
    const fifo = path.join(control, "result")
    native.mkfifo(fifo)
    descriptors.push(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK))
    descriptors.push(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK))
    const [bootstrap, reader] = descriptors as [number, number]
    const state = { released: false, closed: false }
    const release = () => {
      if (state.released) return
      state.released = true
      closeSync(bootstrap)
    }
    descriptors.length = 0
    return {
      file,
      control,
      release,
      async report() {
        // Nonblocking reads make missing/failed reporters cancellable without a stuck I/O worker.
        const bytes = Buffer.alloc(512)
        let used = 0
        while (!state.closed) {
          const size = (() => {
            try {
              return readSync(reader, bytes, used, bytes.length - used, null)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EAGAIN") return undefined
              if ((error as NodeJS.ErrnoException).code === "EINTR") return undefined
              throw error
            }
          })()
          if (size === undefined) {
            await Bun.sleep(5)
            continue
          }
          if (!size) return used ? bytes.subarray(0, used).toString() : undefined
          used += size
          if (used === bytes.length) throw new Error("Oversized managed wait report")
        }
      },
      async close() {
        if (state.closed) return
        state.closed = true
        release()
        closeSync(reader)
        await rm(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    descriptors.forEach((fd) => closeSync(fd))
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

const source = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define MANAGED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define MANAGED_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported managed seccomp architecture
#endif

static int restrict_sockets(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, MANAGED_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_register, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    // Unix datagram socketpairs can reconnect to host pathname sockets.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { .len = sizeof filter / sizeof filter[0], .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int send_bytes(int fd, const void *data, size_t length) {
  const char *bytes = data;
  while (length) {
    ssize_t size = write(fd, bytes, length);
    if (size < 0 && errno == EINTR) continue;
    if (size <= 0) return -1;
    bytes += size;
    length -= size;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 126;
  if (unlink("/tmp/managed-wait") < 0 || restrict_sockets() < 0) return 126;
  // Children must not reopen the reporting channel through /proc or pidfd_getfd.
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) < 0) return 126;
  int report = open("/run/managed/result", O_WRONLY | O_CLOEXEC | O_NONBLOCK);
  if (report < 0 || unlink("/run/managed/result") < 0) return 126;
  if (send_bytes(1, "managed-ready\n", 14) < 0) return 126;
  char permit[6];
  size_t used = 0;
  while (used < sizeof permit) {
    ssize_t size = read(0, permit + used, sizeof permit - used);
    if (size < 0 && errno == EINTR) continue;
    if (size <= 0) return 125;
    used += size;
  }
  if (memcmp(permit, "start\n", sizeof permit) != 0) return 125;
  int input = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (input < 0 || dup2(input, 0) < 0) return 126;
  close(input);
  if (send_bytes(1, "managed-authorized\n", 19) < 0) return 126;
  int failure[2];
  if (pipe2(failure, O_CLOEXEC) < 0) return 126;
  pid_t child = fork();
  if (child < 0) return 126;
  if (child == 0) {
    close(report);
    close(failure[0]);
    int channel = failure[1];
    if (dup3(failure[1], 3, O_CLOEXEC) >= 0) {
      channel = 3;
      if (close_range(4, ~0U, 0) == 0) execvp(argv[1], argv + 1);
    }
    int error = errno;
    send_bytes(channel, &error, sizeof error);
    dprintf(2, "managed exec %s: %s\n", argv[1], strerror(error));
    _exit(127);
  }
  close(failure[1]);
  int exec_error = 0;
  used = 0;
  while (used < sizeof exec_error) {
    ssize_t size = read(failure[0], (char *)&exec_error + used, sizeof exec_error - used);
    if (size < 0 && errno == EINTR) continue;
    if (size < 0) return 126;
    if (!size) break;
    used += size;
  }
  close(failure[0]);
  if (used && used != sizeof exec_error) return 126;
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 126;
  }
  char result[160];
  int length;
  int code;
  if (used) {
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 127) return 126;
    length = snprintf(result, sizeof result, "{\"kind\":\"exec-error\",\"exitCode\":127,\"errno\":%d}\n", exec_error);
    code = 127;
  } else if (WIFEXITED(status)) {
    code = WEXITSTATUS(status);
    length = snprintf(result, sizeof result, "{\"kind\":\"exit\",\"exitCode\":%d}\n", code);
  } else if (WIFSIGNALED(status)) {
    code = 128 + WTERMSIG(status);
    length = snprintf(result, sizeof result, "{\"kind\":\"signal\",\"signal\":%d,\"coreDumped\":%s}\n",
                      WTERMSIG(status), WCOREDUMP(status) ? "true" : "false");
  } else return 126;
  if (length <= 0 || (size_t)length >= sizeof result || send_bytes(report, result, length) < 0) return 126;
  close(report);
  return code;
}
`

export * as ManagedWait from "./managed-linux-wait"
