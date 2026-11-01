import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ManagedSkill } from "../../src/skill/managed"
import { tmpdir } from "../fixture/fixture"

test("managed skills load only exact, safe operator files outside the workspace", async () => {
  await using operator = await tmpdir()
  await using workspace = await tmpdir()
  const file = path.join(operator.path, "SKILL.md")
  const shadow = path.join(workspace.path, "SKILL.md")
  const content = "---\nname: commit-work\ndescription: Commit work safely.\n---\n\nApproved instructions."
  await Bun.write(file, content)
  await Bun.write(shadow, content.replace("Approved", "Workspace"))
  await Bun.write(path.join(operator.path, "helper.sh"), "secret helper")

  const load = (policy: unknown) => ManagedSkill.load(JSON.stringify(policy), workspace.path, workspace.path)
  const skills = await load({ "commit-work": file })
  expect(skills).toHaveLength(1)
  expect(skills[0]).toEqual({
    name: "commit-work",
    description: "Commit work safely.",
    location: "<managed>",
    content: "\nApproved instructions.",
  })
  expect(JSON.stringify(skills)).not.toContain(operator.path)
  expect(JSON.stringify(skills)).not.toContain("helper")
  expect(await load({ "commit-work": shadow })).toEqual([])
  expect(await load({ alias: file })).toEqual([])
  expect(await load({ "commit-work": "https://example.com/SKILL.md" })).toEqual([])
  expect(await load({ "commit-work": "SKILL.md" })).toEqual([])
  expect(await ManagedSkill.load("not json", workspace.path, workspace.path)).toEqual([])

  const linkdir = path.join(operator.path, "link")
  await fs.symlink(operator.path, linkdir)
  expect(await load({ "commit-work": path.join(linkdir, "SKILL.md") })).toEqual([])
  await fs.link(file, path.join(operator.path, "hardlink"))
  expect(await load({ "commit-work": file })).toEqual([])
})
