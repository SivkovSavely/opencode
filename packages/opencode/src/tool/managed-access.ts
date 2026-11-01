import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"

const names = (() => {
  const raw = process.env.OPENCODE_MANAGED_READ_ONLY_AGENTS
  if (raw === undefined) return ["reviewer", "verifier", "verifier-openai-luna", "reviewer-openai-luna"]
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name))
    throw new Error("OPENCODE_MANAGED_READ_ONLY_AGENTS must be a JSON array of nonempty strings")
  return value as string[]
})()

export function readOnly(agent: string, policies: readonly PermissionV1.Ruleset[]) {
  return (
    names.includes(agent) ||
    policies.some((policy) =>
      policy.some(
        (rule) => rule.action === "deny" && Permission.evaluate("edit", rule.pattern, policy).action === "deny",
      ),
    )
  )
}

export * as ManagedAccess from "./managed-access"
