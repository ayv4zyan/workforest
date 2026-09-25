import type { Accessor, Setter } from "solid-js"
import { loadConfig, setProjectStartCommand } from "../lib/config.ts"
import { loadPorts, pickPort } from "../lib/ports.ts"
import { listListeners, readServerLog, startServer, stopServer } from "../lib/servers.ts"
import { vitePort } from "../lib/vite-port.ts"
import type { GitWorktree, Project, ServerRow } from "../lib/types.ts"
import type { Modal } from "./modal-model.ts"
import type { TreeRow } from "./workspace.ts"

export function createServerWorkflow(options: {
  home: () => string
  workspace: {
    selectedProject: () => Project | null
    selectedTree: () => TreeRow | null
    servers: Accessor<ServerRow[]>
    activeServers: () => ServerRow[]
    treeServers: () => ServerRow[]
    setProjects: Setter<Project[]>
  }
  dialog: {
    modal: Accessor<Modal | null>
    setModal: Setter<Modal | null>
    show: (next: Modal) => void
  }
  operation: {
    busy: Accessor<boolean>
    setStatus: Setter<string>
    refresh: () => Promise<void>
    run: (label: string, fn: () => string | void | Promise<string | void>) => Promise<void>
  }
}) {
  const { workspace, dialog, operation } = options

  function openLogs() {
    const rows = workspace.treeServers().filter((row) => row.state !== "failed" || row.logPath)
    const selectedIndex = rows.findIndex((row) => row.logPath)
    if (selectedIndex < 0) return
    dialog.show({ kind: "logs", rows, selectedIndex, text: logText(rows[selectedIndex]!) })
  }

  function logText(row: ServerRow): string {
    if (!row.logPath) return "Logs aren't available for servers started outside Workforest."
    try {
      return readServerLog(row.logPath) || "No output yet."
    } catch (error) {
      return `Couldn't read server logs: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function selectLog(index: number) {
    const current = dialog.modal()
    if (current?.kind !== "logs" || index < 0 || index >= current.rows.length) return
    dialog.setModal({ ...current, selectedIndex: index, text: logText(current.rows[index]!) })
  }

  function stopRows(rows: ServerRow[]) {
    void operation.run("stopping", async () => {
      const results = await Promise.allSettled(rows.map((row) => stopServer(options.home(), row)))
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [`:${rows[index]!.port} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`]
        : [])
      if (failures.length) {
        await operation.refresh()
        throw new Error(`Failed to stop ${failures.join(", ")}`)
      }
      return `stopped ${rows.length} server(s)`
    })
  }

  function openStartPort(project: Project, tree: GitWorktree) {
    const preferred = loadPorts(options.home())[tree.path]
    const used = workspace.servers().filter((row) => row.state !== "failed").map((row) => row.port)
    const port = preferred ?? pickPort([...used, ...listListeners().map((row) => row.port)], undefined, vitePort(tree.path) ?? 5173)
    dialog.show({ kind: "start", value: String(port), project, tree })
  }

  function toggleServer() {
    if (operation.busy() || dialog.modal()) return
    const project = workspace.selectedProject()
    const tree = workspace.selectedTree()
    if (!project || !tree) {
      operation.setStatus("pick a worktree")
      return
    }
    const running = workspace.activeServers()
    if (running.length > 0) {
      if (running.length > 1) {
        dialog.show({ kind: "stop-picker", rows: running, selected: [0], highlighted: 0, treeName: tree.displayName })
        return
      }
      if (running.some((row) => !row.owned)) dialog.show({ kind: "stop", rows: running })
      else stopRows(running)
      return
    }
    if (!project.startCommand?.trim()) {
      dialog.show({ kind: "start-command", value: "", project, tree })
      return
    }
    openStartPort(project, tree)
  }

  function openStartCommand() {
    const project = workspace.selectedProject()
    if (!project || operation.busy()) return
    dialog.show({ kind: "start-command", value: project.startCommand ?? "", project })
  }

  function submit(current: Modal, value: string): boolean {
    if (current.kind === "start-command") {
      const project = setProjectStartCommand(options.home(), current.project.id, value)
      workspace.setProjects(loadConfig(options.home()).projects)
      if (current.tree) openStartPort(project, current.tree)
      else dialog.setModal(null)
      operation.setStatus(`saved start command for ${project.name}`)
      return true
    }
    if (current.kind === "start") {
      if (!/^\d+$/.test(value)) throw new Error("Enter a whole port number from 1024 to 65535")
      const record = startServer({
        home: options.home(), project: current.project, worktree: current.tree, port: Number(value),
        usedPorts: workspace.servers().filter((row) => row.state !== "failed").map((row) => row.port),
      })
      dialog.setModal(null)
      void operation.refresh()
      operation.setStatus(`starting :${record.port}`)
      return true
    }
    return false
  }

  return { openLogs, selectLog, stopRows, toggleServer, openStartCommand, openStartPort, submit }
}
