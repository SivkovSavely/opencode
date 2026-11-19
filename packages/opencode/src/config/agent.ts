export * as ConfigAgent from "./agent"

import path from "path"
import matter from "gray-matter"
import { Option, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { configEntryNameFromPath } from "./entry-name"
import { ConfigMarkdown } from "./markdown"
import { ConfigParse } from "./parse"
import { Filesystem } from "@/util/filesystem"

export async function parseMarkdown(file: string, options?: { strict?: boolean }) {
  if (!options?.strict) return ConfigMarkdown.parse(file).catch(() => undefined)
  const text = await Filesystem.readText(file)
  try {
    // gray-matter caches failed parses too; strict loads must bypass that cache.
    try {
      return matter(text, {})
    } catch {
      return matter(ConfigMarkdown.fallbackSanitization(text), {})
    }
  } catch (cause) {
    throw new FrontmatterError({ path: file, message: "Failed to parse YAML frontmatter" }, { cause })
  }
}

export async function load(dir: string, options?: { strict?: boolean }) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await parseMarkdown(item, options)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string, options?: { strict?: boolean }) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await parseMarkdown(item, options)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = options?.strict
      ? ConfigParse.schema(ConfigAgentV1.Info, config, item)
      : Option.getOrUndefined(
          Schema.decodeUnknownOption(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" }),
        )
    if (parsed) {
      result[config.name] = {
        ...parsed,
        mode: "primary" as const,
      }
    }
  }
  return result
}
