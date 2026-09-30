import { serversForWorktree } from "../lib/servers.ts"
import type { GitWorktree, Project, ServerRow } from "../lib/types.ts"
import { settingsFocusOrder, type SettingsFocus } from "./settings-modal.tsx"

export type ModalFocus = "input" | "source" | "rename-folder" | "server" | "stop-all" | "submit" | "cancel" | SettingsFocus

export type Modal =
  | { kind: "settings"; section: "autoRename" | "ship"; provider: "codex"; model: string; reasoning: string; prompt: string; error?: string }
  | { kind: "auto-rename" }
  | { kind: "ship"; source: string; branches: string[]; branchOpen?: boolean; branchQuery?: string; evidence?: string; error?: string; tree: GitWorktree }
  | { kind: "add-project"; value: string; error?: string }
  | { kind: "new-tree"; value: string; source: string; branches: string[]; branchOpen?: boolean; branchQuery?: string; error?: string }
  | { kind: "switch-branch"; source: string; branches: string[]; branchOpen?: boolean; branchQuery?: string; error?: string; tree: GitWorktree }
  | { kind: "rename"; value: string; renameFolder?: boolean; error?: string; target?: { project: Project; tree: GitWorktree } }
  | { kind: "delete"; error?: string }
  | { kind: "unregister" }
  | { kind: "stop"; rows: ServerRow[] }
  | { kind: "stop-picker"; rows: ServerRow[]; selected: number[]; highlighted: number; treeName: string }
  | { kind: "start-command"; value: string; error?: string; project: Project; tree?: GitWorktree }
  | { kind: "start"; value: string; error?: string; project: Project; tree: GitWorktree }
  | { kind: "logs"; rows: ServerRow[]; selectedIndex: number; text: string }

export function modalFocusables(current: Modal): ModalFocus[] {
  if (current.kind === "settings") return settingsFocusOrder(Boolean(current.error))
  if (current.kind === "rename") return ["input", "rename-folder", "submit", "cancel"]
  if (current.kind === "ship" || current.kind === "switch-branch") return ["source", "submit", "cancel"]
  if (current.kind === "new-tree") return ["input", "source", "submit", "cancel"]
  if (current.kind === "stop-picker") return ["server", "submit", "stop-all", "cancel"]
  return "value" in current ? ["input", "submit", "cancel"] : ["submit", "cancel"]
}

export type BranchModal = Extract<Modal, { kind: "new-tree" | "ship" | "switch-branch" }>

export function isBranchModal(current: Modal | null | undefined): current is BranchModal {
  return current?.kind === "new-tree" || current?.kind === "ship" || current?.kind === "switch-branch"
}

export function matchingBranches(current: BranchModal): string[] {
  const query = current.branchQuery?.trim().toLowerCase() ?? ""
  return current.branches.filter((branch) => branch.toLowerCase().includes(query))
}

export function modalArrowFocus(current: Modal, focus: ModalFocus, name: string): ModalFocus | null {
  const hasInput = "value" in current
  if ((current.kind === "rename" || isBranchModal(current)) && (name === "up" || name === "down")) {
    const items = modalFocusables(current)
    const index = Math.max(0, items.indexOf(focus))
    return items[(index + (name === "up" ? -1 : 1) + items.length) % items.length]!
  }
  if (hasInput && focus === "input") return name === "down" ? "submit" : null
  if (name === "up" && hasInput) return "input"
  if (name === "left" || name === "right") {
    if (focus === "submit") return "cancel"
    if (focus === "cancel") return "submit"
  }
  return focus
}

export function modalTitle(current: Modal): string {
  switch (current.kind) {
    case "settings": return "Settings"
    case "auto-rename": return "auto rename"
    case "ship": return "Ship"
    case "add-project": return "add project"
    case "new-tree": return "new worktree"
    case "switch-branch": return "switch branch"
    case "rename": return "rename worktree"
    case "delete": return "delete worktree"
    case "unregister": return "remove project from list"
    case "stop": return "stop servers"
    case "stop-picker": return `stop servers · ${current.treeName}`
    case "start-command": return "project start command"
    case "start": return "start server"
    case "logs": return "server logs"
  }
}

export function modalBody(current: Modal, selectedProject: Project | null, selectedTree: (GitWorktree & { dirty: boolean; displayName: string }) | null, servers: ServerRow[]): string {
  switch (current.kind) {
    case "settings": return ""
    case "auto-rename": return "Reviewing worktree changes. You can edit the suggested name before renaming."
    case "add-project": return "Path to the main checkout"
    case "ship": return `Commit changes, push, and create a PR. Fixes get separate commits. ${current.evidence === "inferred" ? "Target inferred from history; check it." : current.evidence ? `Source: ${current.evidence}.` : "Choose the target branch."}`
    case "new-tree": return "Name is the new directory and branch. Source is the branch it starts from."
    case "switch-branch": return "Pick a local branch. Uncommitted changes stay; the switch stops if Git would overwrite them."
    case "rename": return "Renames the branch. Renaming the folder changes its path; apps using this worktree may need to reopen it."
    case "delete": {
      const extra = selectedTree?.dirty ? " Working tree is dirty; this force-deletes." : ""
      const running = selectedTree ? serversForWorktree(servers, selectedTree.path).filter((row) => row.state !== "failed") : []
      const ports = running.length ? ` Also kills ${running.map((row) => `:${row.port}`).join(", ")}.` : ""
      return `Delete ${selectedTree?.displayName ?? "this worktree"}?${extra}${ports}`
    }
    case "unregister": return `Remove ${selectedProject?.name ?? "this project"} from the list? Worktrees stay on disk.`
    case "start-command": return "Start command (e.g. bun local). Saved for all project worktrees; runs from the selected worktree."
    case "start": return `Port (1024–65535). Command: ${current.project.startCommand}`
    case "logs": return ""
    case "stop": return `Stop ${current.rows.map((row) => `:${row.port} (pid ${row.pid}, ${row.owned ? "Workforest" : "external"})`).join(", ")}? External processes were started outside Workforest.`
    case "stop-picker": return "Select the servers to stop."
  }
}

export function modalPlaceholder(current: Modal): string {
  if (current.kind === "start-command") return "bun local"
  if (current.kind === "add-project") return "~/Projects/Cras"
  if (current.kind === "new-tree" || current.kind === "rename") return "feat-auth"
  return ""
}

export function modalValue(current: Modal): string {
  return "value" in current ? current.value : ""
}

export function modalError(current: Modal): string | undefined {
  return "error" in current ? current.error : undefined
}

export function modalSize(current: Modal, terminalWidth: number, terminalHeight: number, pathListHeight: number) {
  const preferredWidth = current.kind === "logs"
    ? terminalWidth - 16
    : current.kind === "settings" ? 92
    : current.kind === "start-command" ? 88 : 76
  const preferredHeight = current.kind === "logs"
    ? Math.floor(terminalHeight * 0.7)
    : current.kind === "stop-picker" ? Math.min(22, 14 + current.rows.length)
    : current.kind === "settings" ? terminalHeight - 4
    : current.kind === "add-project" ? 12 + pathListHeight : isBranchModal(current) ? 20 : current.kind === "rename" ? 16 : "value" in current ? 14 : 12
  const width = Math.max(1, Math.min(preferredWidth, terminalWidth - 4))
  const height = Math.max(1, Math.min(preferredHeight, terminalHeight - 2))
  return {
    width,
    height,
    left: Math.max(0, Math.floor((terminalWidth - width) / 2)),
    top: Math.max(0, Math.floor((terminalHeight - height) / 2)),
  }
}
