import { defineConfig } from "vite"
import plugins from "../../vite.js"

const root = process.env.OPENCODE_E2E_ROOT
if (!root) throw new Error("OPENCODE_E2E_ROOT is required")

export default defineConfig({
  cacheDir: `${root}/vite-cache`,
  envDir: root,
  optimizeDeps: { exclude: ["@shikijs/stream", "katex", "remend"], include: ["marked", "marked-shiki"] },
  plugins: [plugins],
})
