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

test("logs stay separated by server, including discovered servers without captured output", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-server-logs-"))
  const firstPath = join(root, "first.log")
  const secondPath = join(root, "second.log")
  writeFileSync(firstPath, "first server output")
  writeFileSync(secondPath, "second server output")
  const row = (pid: number, port: number, logPath?: string): ServerRow => ({
    pid, port, logPath, command: "bun dev", worktreePath: root, projectId: "p", owned: Boolean(logPath), state: "running",
  })
  const [rows, setRows] = createSignal([row(1, 5173, firstPath), row(2, 5174, secondPath), row(3, 5175)])
  const [modal, setModal] = createSignal<Modal | null>(null)
  const [, setProjects] = createSignal<Project[]>([])
  const workflow = createServerWorkflow({
    home: () => root,
    workspace: { selectedProject: () => null, selectedTree: () => null, servers: rows,
      activeServers: rows, treeServers: rows, setProjects },
    dialog: { modal, setModal, show: setModal },
    operation: { busy: () => false, setStatus: () => {}, refresh: async () => {}, run: async () => {} },
  })
  try {
    workflow.openLogs()
    expect(modal()).toMatchObject({ kind: "logs", selectedIndex: 0, text: "first server output" })
    workflow.selectLog(1)
    expect(modal()).toMatchObject({ kind: "logs", selectedIndex: 1, text: "second server output" })
    workflow.selectLog(2)
    expect(modal()).toMatchObject({ kind: "logs", selectedIndex: 2, text: "Logs aren't available for servers started outside Workforest." })
    setRows([row(1, 5173, firstPath)])
    workflow.openLogs()
    expect(modal()).toMatchObject({ kind: "logs", selectedIndex: 0, text: "first server output" })
    expect((modal() as Extract<Modal, { kind: "logs" }>).rows).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
