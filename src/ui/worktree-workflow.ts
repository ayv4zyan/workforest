import { onCleanup, type Accessor, type Setter } from "solid-js"
import type { CliRenderer } from "@opentui/core"
import { suggestWorktreeName } from "../lib/auto-rename.ts"
import { loadAutoRename } from "../lib/auto-rename-settings.ts"
import { setupWorktreeDepsAsync } from "../lib/deps.ts"
import { displayPath } from "../lib/display-path.ts"
import { createWorktree, listBranches, listWorktrees, mainWorktreeBranch, removeWorktreeAsync, renameWorktree, worktreeDisplayName } from "../lib/git.ts"
import { movePort } from "../lib/ports.ts"
import { forgetWorktreeRuntime, moveRunRecord, serversForWorktree, stopServer } from "../lib/servers.ts"
import type { GitWorktree, Project, ServerRow } from "../lib/types.ts"
import type { Modal, ModalFocus } from "./modal-model.ts"
import type { TreeRow } from "./workspace.ts"

export function createWorktreeWorkflow(options: {
  home: () => string
  renderer: CliRenderer
  workspace: {
    selectedProject: () => Project | null
    selectedTree: () => TreeRow | null
    setSelectedProjectId: Setter<string | null>
    setSelectedTreePath: Setter<string | null>
    loadTreesFor: (projectId: string) => void
    pickTree: (path: string) => void
    servers: Accessor<ServerRow[]>
    refresh: () => Promise<void>
  }
  dialog: {
    modal: Accessor<Modal | null>
    setModal: Setter<Modal | null>
    setModalFocus: Setter<ModalFocus>
    setHighlight: Setter<number>
    show: (next: Modal) => void
  }
  operation: {
    busy: Accessor<boolean>
    setBusy: Setter<boolean>
    setStatus: Setter<string>
    run: (label: string, fn: () => string | void | Promise<string | void>) => Promise<void>
  }
}) {
  const { workspace, dialog, operation } = options
  let renameRequest: AbortController | undefined
  onCleanup(() => renameRequest?.abort())
  const renaming = () => Boolean(renameRequest)
  const abortRename = () => renameRequest?.abort()

  function copyWorktreePath() {
    const tree = workspace.selectedTree()
    if (!tree) return
    const copied = options.renderer.copyToClipboardOSC52(tree.path)
    operation.setStatus(copied ? `copied ${displayPath(tree.path)}` : "terminal clipboard is unavailable")
  }

  async function setupTree(project: Project, tree: GitWorktree, createdName?: string) {
    operation.setBusy(true)
    operation.setStatus(createdName ? `created ${createdName}; setting up dependencies` : `setting up ${worktreeDisplayName(tree)}`)
    try {
      const notes = await setupWorktreeDepsAsync(project.path, tree.path)
      await workspace.refresh()
      operation.setStatus(`${createdName ? `created ${createdName}` : `set up ${worktreeDisplayName(tree)}`}${notes.length ? ` — ${notes.join("; ")}` : ""}`)
    } catch (error) {
      await workspace.refresh()
      const detail = error instanceof Error ? error.message : String(error)
      operation.setStatus(`${createdName ? `created ${createdName}; ` : ""}setup failed. Retry: worktree menu → Set up dependencies. ${detail}`)
    } finally {
      operation.setBusy(false)
    }
  }

  function retryWorktreeSetup() {
    const project = workspace.selectedProject()
    const tree = workspace.selectedTree()
    if (!project || !tree || tree.isMain || operation.busy()) return
    void setupTree(project, tree)
  }

  function openNewTree(sourceBranch?: string) {
    if (operation.busy()) return
    const project = workspace.selectedProject()
    if (!project) {
      operation.setStatus("add a project first")
      return
    }
    const branches = listBranches(project.path)
    const fallback = mainWorktreeBranch(project.path)
    const source = sourceBranch && branches.includes(sourceBranch)
      ? sourceBranch
      : branches.includes(fallback) ? fallback : branches[0] ?? fallback
    dialog.setHighlight(Math.max(0, branches.indexOf(source)))
    dialog.show({ kind: "new-tree", value: "", source, branches })
  }

  function toggleSourceMenu() {
    const current = dialog.modal()
    if (current?.kind !== "new-tree") return
    const branchOpen = !current.branchOpen
    if (branchOpen) dialog.setHighlight(Math.max(0, current.branches.indexOf(current.source)))
    dialog.setModal({ ...current, branchOpen })
    dialog.setModalFocus("source")
  }

  function pickSource(name: string) {
    dialog.setModal((current) => current?.kind === "new-tree" ? { ...current, source: name, branchOpen: false, error: undefined } : current)
    dialog.setModalFocus("source")
  }

  function openRename() {
    if (operation.busy()) return
    const tree = workspace.selectedTree()
    if (!tree || tree.isMain) {
      operation.setStatus("pick a linked worktree to rename")
      return
    }
    openManualRename()
  }

  function openManualRename() {
    const tree = workspace.selectedTree()
    const project = workspace.selectedProject()
    if (!tree || tree.isMain || !project) return
    dialog.show({ kind: "rename", value: tree.displayName, target: { project, tree } })
  }

  async function autoRename() {
    if (operation.busy() || dialog.modal()) return
    const project = workspace.selectedProject()
    const tree = workspace.selectedTree()
    if (!project || !tree || tree.isMain || !tree.branch) {
      operation.setStatus("pick a linked worktree with a branch to auto-rename")
      return
    }
    const request = new AbortController()
    renameRequest = request
    operation.setBusy(true)
    operation.setStatus("")
    dialog.show({ kind: "auto-rename" })
    try {
      const name = await suggestWorktreeName(project.path, tree, request.signal, loadAutoRename(options.home()))
      request.signal.throwIfAborted()
      workspace.setSelectedProjectId(project.id)
      workspace.loadTreesFor(project.id)
      workspace.pickTree(tree.path)
      dialog.show({ kind: "rename", value: name, target: { project, tree } })
      operation.setStatus(`Luna suggested ${name} — edit or submit to rename`)
    } catch (error) {
      dialog.setModal(null)
      operation.setStatus(request.signal.aborted ? "auto-rename cancelled" : error instanceof Error ? error.message : String(error))
    } finally {
      renameRequest = undefined
      operation.setBusy(false)
    }
  }

  function openDelete() {
    if (operation.busy()) return
    const tree = workspace.selectedTree()
    if (!tree || tree.isMain) {
      operation.setStatus("pick a linked worktree to delete")
      return
    }
    dialog.show({ kind: "delete" })
  }

  function submit(current: Modal, value: string): boolean {
    if (current.kind === "new-tree") {
      const project = workspace.selectedProject()
      if (!project) throw new Error("no project selected")
      if (!value) throw new Error("name required")
      const tree = createWorktree({ repoPath: project.path, home: options.home(), projectId: project.id, name: value, startPoint: current.source })
      workspace.setSelectedTreePath(tree.path)
      dialog.setModal(null)
      void workspace.refresh()
      void setupTree(project, tree, value)
      return true
    }
    if (current.kind === "rename") {
      const project = current.target?.project ?? workspace.selectedProject()
      const target = current.target?.tree
      const tree = target && project ? listWorktrees(project.path).find((row) => row.path === target.path && row.branch === target.branch) : workspace.selectedTree()
      if (!project || !tree) throw new Error("nothing to rename")
      if (!value) throw new Error("name required")
      const renamed = renameWorktree({ repoPath: project.path, tree, newName: value, renameFolder: current.renameFolder, home: options.home(), projectId: project.id })
      if (renamed.path !== tree.path) {
        moveRunRecord(options.home(), project.id, tree.path, renamed.path)
        movePort(options.home(), tree.path, renamed.path)
      }
      workspace.setSelectedTreePath(renamed.path)
      dialog.setModal(null)
      void workspace.refresh()
      operation.setStatus(`renamed to ${value}`)
      return true
    }
    return false
  }

  function deleteTree() {
    const project = workspace.selectedProject()
    const tree = workspace.selectedTree()
    if (!project || !tree) return
    void operation.run("deleting", async () => {
      for (const row of serversForWorktree(workspace.servers(), tree.path).filter((row) => row.state !== "failed")) stopServer(options.home(), row)
      await removeWorktreeAsync({ repoPath: project.path, tree, force: tree.dirty })
      forgetWorktreeRuntime(options.home(), project.id, tree.path)
      return `deleted ${tree.displayName}`
    })
    dialog.setModal(null)
  }

  return {
    renaming, abortRename, copyWorktreePath, retryWorktreeSetup,
    openNewTree, toggleSourceMenu, pickSource, openRename, openManualRename, autoRename, openDelete,
    submit, deleteTree,
  }
}
