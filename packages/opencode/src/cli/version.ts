import { InstallationVersion } from "@opencode-ai/core/installation/version"

declare const OPENCODE_COMMIT: string

const commit = typeof OPENCODE_COMMIT === "string" ? OPENCODE_COMMIT : ""
export const cliVersion = commit ? `${InstallationVersion} (${commit.slice(0, 8)})` : InstallationVersion
