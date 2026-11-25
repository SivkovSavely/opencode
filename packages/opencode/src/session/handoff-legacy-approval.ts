export * as SessionHandoffLegacyApproval from "./handoff-legacy-approval"

import { constants } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { hostname } from "node:os"
import { promisify } from "node:util"
import { Option, Schema } from "effect"
import { SessionHandoffV1 } from "@opencode-ai/schema/v1/session-handoff"

const maxBytes = 64 * 1024
const commandTimeout = 10_000
const execFile = promisify(execFileCallback)
const unitJobMessageID = "39f53479d3a045ac8e11786248231fbf"
const unitResourcesMessageID = "ae8f7b866b0347b9af31fe1c80b127c0"

export type ObservedResource = {
  sessionID: string
  assistantMessageID: string
  partID: string
  resourceRef: SessionHandoffV1.InterruptedResource["resourceRef"]
  callID: string
  tool: string
  liveness: SessionHandoffV1.InterruptedResource["liveness"]
  resourceKind: SessionHandoffV1.InterruptedResource["resourceKind"]
  command: string | null
}

export async function read(reference: SessionHandoffV1.LegacyResourceApprovalReference) {
  if (process.platform !== "linux" || !reference.path.startsWith("/")) return undefined
  const handle = await open(reference.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    () => undefined,
  )
  if (!handle) return undefined
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size > maxBytes
    )
      return undefined
    const bytes = Buffer.alloc(before.size)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) return undefined
      length += result.bytesRead
    }
    const after = await handle.stat()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o7777) !== 0o600
    )
      return undefined
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return undefined
    const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bytes.toString("utf8"))
    if (Option.isNone(parsed)) return undefined
    const decoded = Schema.decodeUnknownOption(SessionHandoffV1.LegacyResourceApprovalFile)(parsed.value)
    if (Option.isNone(decoded) || canonical(decoded.value) !== canonical(reference.content)) return undefined
    return decoded.value
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

export async function verify(
  reference: SessionHandoffV1.LegacyResourceApprovalReference,
  expected: SessionHandoffV1.Identity,
  expectedRecoveryRevision: number,
  expectedDescendantDigest: string,
  observed: readonly ObservedResource[],
) {
  const approval = await read(reference)
  if (
    !approval ||
    !sameIdentity(approval.expected, expected) ||
    approval.expectedRecoveryRevision !== expectedRecoveryRevision ||
    approval.expectedDescendantDigest !== expectedDescendantDigest
  ) {
    return undefined
  }
  const unknown = observed.filter(
    (resource) => resource.resourceKind === "process" && resource.liveness === "unknown" && ["bash", "shell"].includes(resource.tool),
  )
  if (unknown.length !== approval.resources.length) {
    return undefined
  }
  const bootID = normalizeBootID(
    (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim(),
  )
  const machineID = (await readFile("/etc/machine-id", "utf8").catch(() => "")).trim()
  const uid = process.getuid?.()
  if (!/^[0-9a-f]{32}$/.test(bootID) || !/^[0-9a-f]{32}$/.test(machineID) || uid === undefined) return undefined
  const output = await Promise.all(
    approval.resources.map(async (entry) => {
      const resource = unknown.find(
        (item) =>
          item.sessionID === entry.sessionID &&
          item.assistantMessageID === entry.assistantMessageID &&
          item.partID === entry.partID &&
          (entry.resourceRef ?? null) === item.resourceRef &&
          item.callID === entry.callID &&
          item.tool === entry.tool,
      )
      if (
        !resource ||
        !resource.command ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.scope$/.test(entry.unit) ||
        !/^[0-9a-f]{32}$/.test(entry.invocationID) ||
        entry.host !== hostname() ||
        normalizeBootID(entry.bootID) !== bootID ||
        createHash("sha256").update(resource.command).digest("hex") !== entry.commandSHA256 ||
        !hasExactUnit(resource.command, entry.unit)
      ) {
        return undefined
      }
      const state = await execFile("/usr/bin/systemctl", [
        "--user",
        "show",
        "--property=ActiveState",
        "--property=InvocationID",
        "--value",
        entry.unit,
      ], { timeout: commandTimeout }).catch(() => undefined)
      if (!state || !unitIsInactive(state.stdout, entry.invocationID)) return undefined
      const manager = await execFile("/usr/bin/busctl", [
        "--user",
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetConnectionUnixProcessID",
        "s",
        "org.freedesktop.systemd1",
      ], { timeout: commandTimeout }).catch(() => undefined)
      const managerPID = manager?.stdout.match(/^u (\d+)\s*$/)?.[1]
      if (!managerPID) {
        return undefined
      }
      const managerCgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/init.scope`
      const journal = await execFile("/usr/bin/journalctl", [
        "--user",
        "--no-pager",
        "--output=json",
        `--boot=${bootID}`,
        `--user-unit=${entry.unit}`,
      ], { maxBuffer: maxBytes * 4, timeout: commandTimeout }).catch(() => undefined)
      if (!journal) {
        return undefined
      }
      const lines = journal.stdout.split("\n").filter(Boolean)
      if (
        !verifyJournalRecords(lines, {
          unit: entry.unit,
          invocationID: entry.invocationID,
          bootID,
          host: hostname(),
          uid: String(uid),
          machineID,
          managerPID,
          managerUnit: `user@${uid}.service`,
          managerCgroup,
          evidenceSHA256: entry.evidenceSHA256,
        })
      ) {
        return undefined
      }
      return entry
    }),
  )
  if (output.some((entry) => !entry)) return undefined
  return output as SessionHandoffV1.LegacyResourceApprovalEntry[]
}

export function verifyJournalRecords(
  lines: readonly string[],
  expected: {
    unit: string
    invocationID: string
    bootID: string
    host: string
    uid: string
    machineID: string
    managerPID: string
    managerUnit: string
    managerCgroup: string
    evidenceSHA256: readonly string[]
  },
) {
  const records = lines.map((line) => {
    const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line)
    if (Option.isNone(value) || typeof value.value !== "object" || value.value === null) return undefined
    return value.value as Record<string, unknown>
  })
  if (records.some((record) => !record)) return false
  const entries = records as Record<string, unknown>[]
  const managerRecords = entries.filter((record) => record.USER_UNIT === expected.unit)
  const starts = managerRecords.flatMap((record, index) =>
    record.MESSAGE_ID === unitJobMessageID && record.JOB_TYPE === "start" && record.JOB_RESULT === "done"
      ? [index]
      : [],
  )
  const stops = managerRecords.flatMap((record, index) =>
    record.MESSAGE_ID === unitResourcesMessageID ? [index] : [],
  )
  const validTimestamps = managerRecords.every(
    (record) => typeof record.__MONOTONIC_TIMESTAMP === "string" && /^\d+$/.test(record.__MONOTONIC_TIMESTAMP),
  )
  return (
    managerRecords.length === expected.evidenceSHA256.length &&
    managerRecords.length >= 2 &&
    managerRecords.every(
      (record) =>
        record.USER_INVOCATION_ID === expected.invocationID &&
        record._UID === expected.uid &&
        record._MACHINE_ID === expected.machineID &&
        record._BOOT_ID === expected.bootID &&
        record._HOSTNAME === expected.host &&
        typeof record._EXE === "string" &&
        record._EXE.endsWith("/systemd") &&
        record._COMM === "systemd" &&
        record._PID === expected.managerPID &&
        record._SYSTEMD_UNIT === expected.managerUnit &&
        record._SYSTEMD_USER_UNIT === "init.scope" &&
        record._SYSTEMD_CGROUP === expected.managerCgroup &&
        record._RUNTIME_SCOPE === "system",
    ) &&
    starts.length === 1 &&
    stops.length === 1 &&
    (stops[0] ?? -1) > (starts[0] ?? Number.MAX_SAFE_INTEGER) &&
    managerRecords.every(
      (record, index) =>
        validTimestamps &&
        (index === 0 ||
          BigInt(String(record.__MONOTONIC_TIMESTAMP)) >= BigInt(String(managerRecords[index - 1]?.__MONOTONIC_TIMESTAMP))),
    ) &&
    managerRecords.every(
      (record, index) => journalEvidenceDigest(record) === expected.evidenceSHA256[index],
    )
  )
}

export function journalEvidenceDigest(record: unknown) {
  return createHash("sha256").update(canonical(record)).digest("hex")
}

export function unitIsInactive(stdout: string, invocationID: string) {
  const lines = stdout.trim().split("\n").filter(Boolean)
  return (
    ["inactive", "failed"].includes(lines[0] ?? "") &&
    (lines[1] === undefined || lines[1] === invocationID)
  )
}

function sameIdentity(left: SessionHandoffV1.Identity, right: SessionHandoffV1.Identity) {
  return (
    left.queueID === right.queueID &&
    left.userMessageID === right.userMessageID &&
    left.ownerLineage === right.ownerLineage &&
    left.ownerInstance === right.ownerInstance &&
    left.fence === right.fence &&
    left.revision === right.revision &&
    left.contextDigest === right.contextDigest
  )
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function normalizeBootID(value: string) {
  return value.replaceAll("-", "").toLowerCase()
}

export function hasExactUnit(command: string, unit: string) {
  const tokens = command.trim().split(/\s+/)
  const units = tokens.flatMap((token, index) =>
    token.startsWith("--unit=") ? [token.slice("--unit=".length)] : token === "--unit" ? [tokens[index + 1] ?? ""] : [],
  )
  return (
    tokens.includes("--user") &&
    tokens.includes("--scope") &&
    units.length === 1 &&
    (units[0] === unit || (unit.endsWith(".scope") && units[0] === unit.slice(0, -".scope".length)))
  )
}
