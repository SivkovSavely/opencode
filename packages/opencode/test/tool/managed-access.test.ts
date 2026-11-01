import { expect, test } from "bun:test"
import { ManagedAccess } from "@/tool/managed-access"
import { Permission } from "@/permission"

test("managed read-only identities are exact and edit denies intersect policy layers", () => {
  const allow = Permission.fromConfig({ "*": "allow" })
  const deny = Permission.fromConfig({ edit: "deny" })
  expect(ManagedAccess.readOnly("reviewer", [allow])).toBe(true)
  expect(ManagedAccess.readOnly("reviewer-extra", [allow])).toBe(false)
  expect(ManagedAccess.readOnly("general", [deny, allow])).toBe(true)
  expect(ManagedAccess.readOnly("general", [allow, deny])).toBe(true)
  expect(ManagedAccess.readOnly("general", [allow])).toBe(false)
  expect(ManagedAccess.readOnly("general", [Permission.fromConfig({ edit: { "secret/*": "deny" } }), allow])).toBe(true)
  expect(ManagedAccess.readOnly("general", [Permission.fromConfig({ edit: { "*": "deny", "*.*": "allow" } })])).toBe(
    true,
  )
  expect(ManagedAccess.readOnly("general", [Permission.fromConfig({ "*": "deny", bash: "allow" })])).toBe(true)
  expect(
    ManagedAccess.readOnly("general", [Permission.fromConfig({ "*": "deny", edit: "allow", bash: "allow" })]),
  ).toBe(false)
  expect(
    ManagedAccess.readOnly("general", [Permission.fromConfig({ edit: "allow", "*": "deny", bash: "allow" })]),
  ).toBe(true)
  expect(ManagedAccess.readOnly("general", [Permission.fromConfig({ "*": "deny", bash: "allow" }), allow])).toBe(true)
  expect(ManagedAccess.readOnly("general", [allow, Permission.fromConfig({ "*": "deny", bash: "allow" })])).toBe(true)
})

test("operator identity configuration is captured on import and rejects invalid values", async () => {
  const source = `
    import { ManagedAccess } from "./src/tool/managed-access"
    process.env.OPENCODE_MANAGED_READ_ONLY_AGENTS = '["other"]'
    console.log(JSON.stringify([ManagedAccess.readOnly("audit", []), ManagedAccess.readOnly("reviewer", []), ManagedAccess.readOnly("other", [])]))
  `
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, OPENCODE_MANAGED_READ_ONLY_AGENTS: '["audit"]' },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await proc.exited).toBe(0)
  expect(JSON.parse(await new Response(proc.stdout).text())).toEqual([true, false, false])
  const invalid = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, OPENCODE_MANAGED_READ_ONLY_AGENTS: '["audit",1]' },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await invalid.exited).not.toBe(0)
  expect(await new Response(invalid.stderr).text()).toContain("OPENCODE_MANAGED_READ_ONLY_AGENTS")
})
