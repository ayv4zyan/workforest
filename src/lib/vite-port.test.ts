import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vitePort } from "./vite-port.ts"

test("reads a literal Vite port from the selected worktree's dev directory", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-vite-config-"))
  try {
    mkdirSync(join(root, "web"))
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
    writeFileSync(join(root, "vite.config.ts"), "export default { server: { port: 3000 } }")
    expect(vitePort(root)).toBe(3000)
    writeFileSync(join(root, "vite.config.ts"), "export default defineConfig({ server: { port: Number(process.env.PORT) } })")
    expect(vitePort(root)).toBeNull()
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "web:dev": "bun --filter web dev" } }))
    writeFileSync(join(root, "web", "vite.config.mts"), "export default defineConfig({ server: { host: true, port: 4200 } })")
    expect(vitePort(root)).toBe(4200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
