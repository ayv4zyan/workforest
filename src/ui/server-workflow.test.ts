import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rememberPort } from "../lib/ports.ts"
import type { GitWorktree, Project, ServerRow } from "../lib/types.ts"
import type { Modal } from "./modal-model.ts"
import { createServerWorkflow } from "./server-workflow.ts"

test("first start uses Vite port; later starts retain the remembered port", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-modal-port-"))
  const home = join(root, "home")
  const project: Project = { id: "p", name: "p", path: root, basePort: 5173, startCommand: "bun dev" }
  const tree: GitWorktree = { path: root, head: "a", branch: "main", bare: false, detached: false, locked: false, prunable: false, isMain: true }
  const [modal, setModal] = createSignal<Modal | null>(null)
  const [servers] = createSignal<ServerRow[]>([])
  const [, setProjects] = createSignal<Project[]>([])
  const workflow = createServerWorkflow({
    home: () => home,
    workspace: { selectedProject: () => project, selectedTree: () => ({ ...tree, dirty: false, displayName: "main" }), servers,
      activeServers: () => [], treeServers: () => [], setProjects },
    dialog: { modal, setModal, show: setModal },
    operation: { busy: () => false, setStatus: () => {}, refresh: async () => {}, run: async () => {} },
  })
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
    writeFileSync(join(root, "vite.config.ts"), "export default defineConfig({ server: { port: 3210 } })")
    workflow.openStartPort(project, tree)
    expect(modal()).toMatchObject({ kind: "start", value: "3210" })
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("busy") })
    try {
      writeFileSync(join(root, "vite.config.ts"), `export default { server: { port: ${occupied.port} } }`)
      workflow.openStartPort(project, tree)
      expect(Number((modal() as Extract<Modal, { kind: "start" }>).value)).toBeGreaterThan(occupied.port!)
    } finally {
      occupied.stop(true)
    }
    rememberPort(home, root, 4321)
    workflow.openStartPort(project, tree)
    expect(modal()).toMatchObject({ kind: "start", value: "4321" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
