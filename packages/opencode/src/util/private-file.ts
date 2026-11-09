import { open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export async function writePrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    // The rename must be durable before a consuming request can be sent.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(file), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return
      throw error
    })
  }
}
