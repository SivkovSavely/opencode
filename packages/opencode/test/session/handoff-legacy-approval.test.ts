import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, symlink, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hasExactUnit,
  journalEvidenceDigest,
  SessionHandoffLegacyApproval,
  unitIsInactive,
  verifyJournalRecords,
} from "../../src/session/handoff-legacy-approval"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const approval = {
  version: 1,
  expected: {
    queueID: "queue",
    userMessageID: "user",
    ownerLineage: "lineage",
    ownerInstance: "instance",
    fence: 1,
    revision: 2,
    contextDigest: "context",
  },
  expectedRecoveryRevision: 3,
  expectedDescendantDigest: "descendants",
  resources: [],
} as const

test("reads an owner-only approval by exact file digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-approval-"))
  directories.push(directory)
  const file = join(directory, "approval.json")
  const bytes = Buffer.from(JSON.stringify(approval, null, 2))
  await writeFile(file, bytes, { mode: 0o600 })
  const result = await SessionHandoffLegacyApproval.read({
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content: approval,
  })
  expect(result).toEqual(approval)
  expect(
    await SessionHandoffLegacyApproval.read({
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: { ...approval, expectedRecoveryRevision: 4 },
    }),
  ).toBeUndefined()
})

test("rejects symlinks, non-private modes, digest mismatches, and unknown fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-approval-"))
  directories.push(directory)
  const file = join(directory, "approval.json")
  const bytes = Buffer.from(JSON.stringify(approval))
  await writeFile(file, bytes, { mode: 0o600 })
  const reference = { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), content: approval }
  expect(await SessionHandoffLegacyApproval.read({ ...reference, sha256: "0".repeat(64) })).toBeUndefined()
  const oversized = Buffer.concat([bytes, Buffer.alloc(64 * 1024)])
  await writeFile(file, oversized, { mode: 0o600 })
  expect(
    await SessionHandoffLegacyApproval.read({
      path: file,
      sha256: createHash("sha256").update(oversized).digest("hex"),
      content: approval,
    }),
  ).toBeUndefined()
  await writeFile(file, bytes, { mode: 0o600 })
  await chmod(file, 0o644)
  expect(await SessionHandoffLegacyApproval.read(reference)).toBeUndefined()
  await chmod(file, 0o600)
  const link = join(directory, "link.json")
  await symlink(file, link)
  expect(await SessionHandoffLegacyApproval.read({ ...reference, path: link })).toBeUndefined()
  const invalid = Buffer.from(JSON.stringify({ ...approval, unrecognized: true }))
  await writeFile(file, invalid, { mode: 0o600 })
  expect(
    await SessionHandoffLegacyApproval.read({
      path: file,
      sha256: createHash("sha256").update(invalid).digest("hex"),
      content: approval,
    }),
  ).toBeUndefined()
})

test("journal evidence must bind the exact boot, unit invocation, and closed invocation records", () => {
  expect(journalEvidenceDigest({ a: 1, b: 2 })).toBe(journalEvidenceDigest({ b: 2, a: 1 }))
  expect(journalEvidenceDigest({ a: [1, 2] })).not.toBe(journalEvidenceDigest({ a: [2, 1] }))
  const manager = {
    USER_UNIT: "job.scope",
    USER_INVOCATION_ID: "0123456789abcdef0123456789abcdef",
    _UID: "1000",
    _MACHINE_ID: "machine",
    _EXE: "/usr/lib/systemd/systemd",
    _COMM: "systemd",
    _HOSTNAME: "host",
    _BOOT_ID: "boot",
    _RUNTIME_SCOPE: "system",
    _SYSTEMD_USER_UNIT: "init.scope",
    _SYSTEMD_UNIT: "user@1000.service",
    _SYSTEMD_CGROUP: "/user.slice/user-1000.slice/user@1000.service/init.scope",
    _PID: "2544",
    SYSLOG_IDENTIFIER: "systemd",
  }
  const records: Record<string, unknown>[] = [
    {
      ...manager,
      __MONOTONIC_TIMESTAMP: "100",
      MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf",
      JOB_TYPE: "start",
      JOB_RESULT: "done",
    },
    {
      COREDUMP_USER_UNIT: "job.scope",
      COREDUMP_CGROUP: "/user.slice/user-1000.slice/user@1000.service/baila.slice/job.scope",
      _UID: "1000",
      _EXE: "/usr/lib/systemd/systemd-coredump",
      _HOSTNAME: "host",
      _BOOT_ID: "boot",
      _RUNTIME_SCOPE: "system",
      _SYSTEMD_UNIT: "systemd-coredump@test.service",
      _SYSTEMD_CGROUP: "/system.slice/system-systemd\\x2dcoredump.slice/systemd-coredump@test.service",
      _PID: "3000",
      COREDUMP_UID: "1000",
      __MONOTONIC_TIMESTAMP: "150",
      MESSAGE_ID: "fc2e22bc6ee647b6b90729ab34a250b1",
    },
    {
      ...manager,
      __MONOTONIC_TIMESTAMP: "200",
      MESSAGE_ID: "ae8f7b866b0347b9af31fe1c80b127c0",
    },
  ]
  const expected = {
    unit: "job.scope",
    invocationID: manager.USER_INVOCATION_ID,
    bootID: "boot",
    host: "host",
    uid: "1000",
    machineID: "machine",
    managerPID: "2544",
    managerUnit: "user@1000.service",
    managerCgroup: manager._SYSTEMD_CGROUP,
  }
  const verify = (values: typeof records, overrides: Partial<typeof expected> & { evidenceSHA256?: string[] } = {}) => {
    const lines = values.map((record) => JSON.stringify(record))
    return verifyJournalRecords(lines, {
      ...expected,
      ...overrides,
      evidenceSHA256:
        overrides.evidenceSHA256 ?? values.filter((record) => record.USER_UNIT === expected.unit).map(journalEvidenceDigest),
    })
  }
  expect(verify(records)).toBe(true)
  expect(verify(records.map((record) => ({ ...record, SYSLOG_IDENTIFIER: "forged" })))).toBe(true)
  expect(verify(records.map((record, index) => index === 1 ? { ...record, SYSLOG_IDENTIFIER: "systemd", _EXE: "/tmp/fake" } : record))).toBe(true)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, SYSLOG_IDENTIFIER: "systemd", _PID: "1", _EXE: "/tmp/fake" } : record))).toBe(false)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, _UID: "1001" } : record))).toBe(false)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, USER_UNIT: "other.scope" } : record))).toBe(false)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, USER_INVOCATION_ID: "other" } : record))).toBe(false)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, _BOOT_ID: "other" } : record))).toBe(false)
  expect(verify(records.map((record, index) => index === 0 ? { ...record, _PID: "1" } : record))).toBe(false)
  expect(verify(records, { unit: "other.scope" })).toBe(false)
  expect(verify(records, { evidenceSHA256: ["0".repeat(64)] })).toBe(false)
  const coredump = {
    COREDUMP_USER_UNIT: "job.scope",
    MESSAGE_ID: "ae8f7b866b0347b9af31fe1c80b127c0",
  }
  expect(verify([...records.slice(0, 1), coredump])).toBe(false)
})

test("unit state must be inactive or absent and may not name a conflicting invocation", () => {
  expect(unitIsInactive("inactive\n", "invocation")).toBe(true)
  expect(unitIsInactive("failed\ninvocation\n", "invocation")).toBe(true)
  expect(unitIsInactive("", "invocation")).toBe(false)
  expect(unitIsInactive("unknown\n", "invocation")).toBe(false)
  expect(unitIsInactive("active\ninvocation\n", "invocation")).toBe(false)
  expect(unitIsInactive("inactive\nother\n", "invocation")).toBe(false)
})

test("the frozen command must contain exactly one matching unit option", () => {
  expect(hasExactUnit("systemd-run --user --scope --unit=job.scope -- true", "job.scope")).toBe(true)
  expect(hasExactUnit("systemd-run --user --scope --unit job.scope -- true", "job.scope")).toBe(true)
  expect(hasExactUnit("git status --short && systemd-run --user --scope --unit=job -- true && git status --short", "job.scope")).toBe(true)
  expect(hasExactUnit("systemd-run --user --scope --unit=job.scope --unit=other.scope -- true", "job.scope")).toBe(false)
  expect(hasExactUnit("systemd-run --user --scope --unit=job.scope-extra -- true", "job.scope")).toBe(false)
  expect(hasExactUnit("systemd-run --scope --unit=job -- true", "job.scope")).toBe(false)
  expect(hasExactUnit("echo --unit=job.scope", "job.scope")).toBe(false)
})
