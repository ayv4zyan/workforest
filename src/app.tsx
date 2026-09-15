import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { suggestWorktreeName } from "./lib/auto-rename.ts"
import { theme } from "./theme.ts"
import { nextIndex } from "./lib/select-hit.ts"
import { ActionButton } from "./ui/button.tsx"
import { addProject, loadConfig, removeProject, setProjectPaneWidth, setProjectStartCommand } from "./lib/config.ts"
import { setupWorktreeDeps } from "./lib/deps.ts"
import {
  createWorktree,
  isDirty,
  listWorktrees,
  removeWorktree,
  renameWorktree,
  worktreeDisplayName,
} from "./lib/git.ts"
import { workforestHome } from "./lib/home.ts"
import { displayPath } from "./lib/display-path.ts"
import { loadPorts, pickPort, movePort } from "./lib/ports.ts"
import {
  collectServers,
  serverStatus,
  readServerLog,
  forgetWorktreeRuntime,
  moveRunRecord,
  serversForWorktree,
  startServer,
  stopServer,
} from "./lib/servers.ts"
import type { GitWorktree, Project, ServerRow } from "./lib/types.ts"

type Pane = "projects" | "trees"
type FocusRow = "header" | "panes" | "pane-actions"
type RowMenu = { pane: Pane; x: number; y: number; renameOpen: boolean }
type ModalFocus = "input" | "submit" | "cancel"
type Action = {
  id: string
  label: string
  trailingLabel?: string
  variant?: "accent" | "danger"
  disabled?: boolean
  onPress: () => void
}

const panes: Pane[] = ["projects", "trees"]
const defaultProjectPaneWidth = 28
const minProjectPaneWidth = 16
const minTreePaneWidth = 24
type TreeRow = GitWorktree & { dirty: boolean; displayName: string }
type Modal =
  | { kind: "add-project"; value: string; error?: string }
  | { kind: "new-tree"; value: string; error?: string }
  | { kind: "rename"; value: string; error?: string; target?: { project: Project; tree: GitWorktree } }
  | { kind: "delete"; error?: string }
  | { kind: "unregister" }
  | { kind: "stop"; rows: ServerRow[] }
  | { kind: "start-command"; value: string; error?: string; project: Project; tree?: GitWorktree }
  | { kind: "start"; value: string; error?: string; project: Project; tree: GitWorktree }
  | { kind: "logs"; text: string }

const dataDir = () => workforestHome()

export function App() {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [menu, setMenu] = createSignal<RowMenu | null>(null)
  const [menuIndex, setMenuIndex] = createSignal(0)
  const [submenuIndex, setSubmenuIndex] = createSignal(0)
  const [projectListHeight, setProjectListHeight] = createSignal(0)
  const [treeListHeight, setTreeListHeight] = createSignal(0)
  let projectList: BoxRenderable | undefined
  let treeList: BoxRenderable | undefined
  const [pane, setPane] = createSignal<Pane>("projects")
  const [focusRow, setFocusRow] = createSignal<FocusRow>("panes")
  const [headerIndex, setHeaderIndex] = createSignal(0)
  const [modalFocus, setModalFocus] = createSignal<ModalFocus>("input")
  const [projects, setProjects] = createSignal<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [trees, setTrees] = createSignal<TreeRow[]>([])
  const [selectedTreePath, setSelectedTreePath] = createSignal<string | null>(null)
  const [servers, setServers] = createSignal<ServerRow[]>([])
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let renameRequest: AbortController | undefined
  onCleanup(() => renameRequest?.abort())
  const [modal, setModal] = createSignal<Modal | null>(null)
  const [projectPaneWidth, setProjectPaneWidthState] = createSignal(defaultProjectPaneWidth)
  const [hoveredProjectIndex, setHoveredProjectIndex] = createSignal<number | null>(null)
  const [hoveredTreeIndex, setHoveredTreeIndex] = createSignal<number | null>(null)
  const [dividerHovered, setDividerHovered] = createSignal(false)
  const [dividerDragging, setDividerDragging] = createSignal(false)
  let lastDividerClick = 0
  let dividerMoved = false

  const clampProjectPaneWidth = (width: number) => {
    const available = dimensions().width - 1
    const maximum = Math.max(8, Math.min(Math.floor(available / 2), available - minTreePaneWidth))
    const minimum = Math.min(minProjectPaneWidth, maximum)
    return Math.max(minimum, Math.min(maximum, Math.round(width)))
  }

  const visibleProjectPaneWidth = () => clampProjectPaneWidth(projectPaneWidth())
  const dividerColor = () => dividerDragging() || dividerHovered() || focusRow() === "panes" ? theme.accent : theme.border

  function persistProjectPaneWidth() {
    try {
      setProjectPaneWidth(dataDir(), projectPaneWidth())
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const selectedProject = () => projects().find((project) => project.id === selectedProjectId()) ?? null
  const selectedTree = () => trees().find((tree) => tree.path === selectedTreePath()) ?? null
  const treeServers = () => {
    const tree = selectedTree()
    return tree ? serversForWorktree(servers(), tree.path) : []
  }
  const activeServers = () => treeServers().filter((row) => row.state !== "failed")

  const visibleRows = <T,>(rows: T[], selected: number, height: number, linesPerItem: number) => {
    const count = Math.max(1, Math.floor(height / linesPerItem))
    const offset = Math.max(0, Math.min(selected - Math.floor(count / 2), rows.length - count))
    return rows.slice(offset, offset + count).map((row, index) => ({ row, index: offset + index }))
  }

  function refresh() {
    const config = loadConfig(dataDir())
    setProjects(config.projects)
    const currentId =
      config.projects.some((project) => project.id === selectedProjectId())
        ? selectedProjectId()
        : (config.projects[0]?.id ?? null)
    setSelectedProjectId(currentId)

    const treesByProject = new Map<string, GitWorktree[]>()
    for (const project of config.projects) {
      try {
        treesByProject.set(project.id, listWorktrees(project.path))
      } catch {
        treesByProject.set(project.id, [])
      }
    }

    const project = config.projects.find((row) => row.id === currentId)
    let currentPath: string | null = null
    if (project) {
      const listed = (treesByProject.get(project.id) ?? []).map((tree) => ({
        ...tree,
        dirty: isDirty(tree.path),
        displayName: worktreeDisplayName(tree),
      }))
      setTrees(listed)
      currentPath = listed.some((tree) => tree.path === selectedTreePath())
        ? selectedTreePath()
        : (listed[0]?.path ?? null)
      setSelectedTreePath(currentPath)
    } else {
      setTrees([])
      setSelectedTreePath(null)
    }

    const rows = collectServers({ home: dataDir(), projects: config.projects, treesByProject })
    setServers(rows)
  }

  function loadTreesFor(projectId: string) {
    const project = projects().find((row) => row.id === projectId) ?? loadConfig(dataDir()).projects.find((row) => row.id === projectId)
    if (!project) {
      setTrees([])
      setSelectedTreePath(null)
      return
    }
    const listed = listWorktrees(project.path).map((tree) => ({
      ...tree,
      dirty: isDirty(tree.path),
      displayName: worktreeDisplayName(tree),
    }))
    setTrees(listed)
    const path = listed.some((tree) => tree.path === selectedTreePath())
      ? selectedTreePath()
      : (listed[0]?.path ?? null)
    setSelectedTreePath(path)
  }

  function pickTree(path: string) {
    setSelectedTreePath(path)
  }

  function runOp(label: string, fn: () => string | void) {
    if (busy()) return
    setBusy(true)
    setStatus(label)
    try {
      const message = fn()
      refresh()
      setStatus(message ?? "ok")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    try {
      const savedWidth = loadConfig(dataDir()).ui?.projectPaneWidth
      if (typeof savedWidth === "number" && Number.isFinite(savedWidth)) {
        setProjectPaneWidthState(Math.round(savedWidth))
      }
      refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
    const timer = setInterval(() => {
      if (busy() || modal() || menu()) return
      try {
        refresh()
      } catch {
        // keep last status
      }
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  function quit() {
    renameRequest?.abort()
    renderer.destroy()
  }

  function focusPane(next: Pane) {
    setPane(next)
    setFocusRow("panes")
  }

  function cyclePane(delta: number) {
    const index = panes.indexOf(pane())
    const next = (index + delta + panes.length) % panes.length
    focusPane(panes[next]!)
  }

  function movePaneSelection(delta: number) {
    if (pane() === "projects") {
      const next = Math.max(0, Math.min(projectIndex() + delta, projects().length - 1))
      const project = projects()[next]
      if (!project || project.id === selectedProjectId()) return
      setSelectedProjectId(project.id)
      loadTreesFor(project.id)
      return
    }
    const next = Math.max(0, Math.min(treeIndex() + delta, trees().length - 1))
    const tree = trees()[next]
    if (tree) pickTree(tree.path)
  }

  function headerActions(): Action[] {
    const serverActions: Action[] = selectedTree() ? [
      {
        id: "btn-start",
        label: activeServers().length > 0 ? "■" : "▶",
        variant: activeServers().length > 0 ? "danger" : "accent",
        disabled: busy(),
        onPress: toggleServer,
      },
      { id: "btn-logs", label: "logs", disabled: !treeServers().some((row) => row.logPath), onPress: openLogs },
    ] : []
    return [
      { id: "btn-refresh", label: "refresh", onPress: () => refresh() },
      ...serverActions,
      ...(busy() && renameRequest ? [{ id: "btn-cancel-generation", label: "cancel rename", onPress: () => renameRequest?.abort() }] : []),
      { id: "btn-quit", label: "quit", onPress: quit },
    ]
  }

  function cycleHeader(delta: number) {
    const actions = headerActions()
    const current = Math.min(headerIndex(), actions.length - 1)
    setHeaderIndex((current + delta + actions.length) % actions.length)
  }

  function pressHeader() {
    const actions = headerActions()
    const action = actions[Math.min(headerIndex(), Math.max(0, actions.length - 1))]
    if (!action || action.disabled) return
    action.onPress()
  }

  function menuActions(): Action[] {
    if (menu()?.pane === "projects") {
      return [
        { id: "btn-command", label: "Edit start command", disabled: busy(), onPress: openStartCommand },
        { id: "btn-unregister", label: "Remove from list", variant: "danger", disabled: busy(), onPress: openUnregister },
      ]
    }
    const tree = selectedTree()
    const linked = Boolean(tree && !tree.isMain) && !busy()
    return [
      { id: "btn-rename", label: "Rename", trailingLabel: "›", disabled: !linked, onPress: openRenameSubmenu },
      { id: "btn-copy-path", label: "Copy path", disabled: !tree, onPress: copyWorktreePath },
      { id: "btn-delete", label: "Delete", variant: "danger", disabled: !linked, onPress: openDelete },
    ]
  }

  function selectedRowTop(index: number, count: number, height: number, linesPerItem: number) {
    // Keep the selected row centered when the list is longer than its viewport.
    const visible = Math.max(1, Math.floor(height / linesPerItem))
    const offset = Math.max(0, Math.min(index - Math.floor(visible / 2), count - visible))
    return (index - offset) * linesPerItem
  }

  function openMenu(target: Pane, x?: number, y?: number) {
    if (modal() || busy()) return
    if (target === "projects" ? !selectedProject() : !selectedTree()) return
    focusPane(target)
    const list = target === "projects" ? projectList : treeList
    const row = target === "projects"
      ? selectedRowTop(projectIndex(), projects().length, projectListHeight(), 1)
      : selectedRowTop(treeIndex(), trees().length, treeListHeight(), 2)
    setMenuIndex(0)
    setSubmenuIndex(0)
    setMenu({ pane: target, x: x ?? (list?.x ?? 0) + (list?.width ?? 0), y: y ?? (list?.y ?? 4) + row, renameOpen: false })
  }

  function openRenameSubmenu() {
    const current = menu()
    if (!current || current.pane !== "trees" || menuActions()[0]?.disabled) return
    setMenu({ ...current, renameOpen: true })
    setSubmenuIndex(0)
  }

  function submenuActions(): Action[] {
    return [
      { id: "btn-manual-rename", label: "Manual", onPress: openManualRename },
      { id: "btn-auto-rename", label: "Auto", disabled: !selectedTree()?.branch, onPress: () => void autoRename() },
    ]
  }

  function actionMenuWidth(actions: Action[], maxWidth = 24): number {
    const contentWidth = Math.max(...actions.map((action) => action.label.length + (action.trailingLabel ? action.trailingLabel.length + 1 : 0)))
    return Math.min(dimensions().width, maxWidth, Math.max(12, contentWidth + 4))
  }

  const contextMenuWidth = () => actionMenuWidth(menuActions())
  const contextMenuHeight = () => menuActions().length + 2
  const renameSubmenuWidth = () => actionMenuWidth(submenuActions(), 20)

  function pressSubmenu(index = submenuIndex()) {
    const action = submenuActions()[index]
    if (!action || action.disabled) return
    setMenu(null)
    action.onPress()
  }

  function copyWorktreePath() {
    const tree = selectedTree()
    if (!tree) return
    const copied = renderer.copyToClipboardOSC52(tree.path)
    setStatus(copied ? `copied ${displayPath(tree.path)}` : "terminal clipboard is unavailable")
  }

  function pressMenu(index = menuIndex()) {
    const action = menuActions()[index]
    if (!action || action.disabled) return
    if (menu()?.pane === "trees" && index === 0) {
      openRenameSubmenu()
      return
    }
    setMenu(null)
    action.onPress()
  }

  function pressPaneAction() {
    if (pane() === "projects") openAddProject()
    else openNewTree()
  }

  function cycleRow(delta: number) {
    if (focusRow() === "header") cycleHeader(delta)
    else if (focusRow() === "pane-actions") return
    else cyclePane(delta)
  }

  function showModal(next: Modal) {
    setMenu(null)
    setModal(next)
    setModalFocus("value" in next ? "input" : "submit")
  }

  function modalFocusables(): ModalFocus[] {
    const current = modal()
    if (!current) return []
    return "value" in current ? ["input", "submit", "cancel"] : ["submit", "cancel"]
  }

  function cycleModalFocus(delta: number) {
    const items = modalFocusables()
    if (items.length === 0) return
    const index = items.indexOf(modalFocus())
    const start = index < 0 ? 0 : index
    setModalFocus(items[(start + delta + items.length) % items.length]!)
  }

  function handleModalArrow(name: string, preventDefault: () => void) {
    const current = modal()
    if (!current) return
    const hasInput = "value" in current
    const focus = modalFocus()

    if (hasInput && focus === "input") {
      if (name === "down") {
        preventDefault()
        setModalFocus("submit")
      }
      return
    }

    preventDefault()
    if (name === "up" && hasInput) {
      setModalFocus("input")
      return
    }
    if (name === "left" || name === "right") {
      if (focus === "submit") setModalFocus("cancel")
      else if (focus === "cancel") setModalFocus("submit")
    }
  }

  function openAddProject() {
    if (busy()) return
    showModal({ kind: "add-project", value: "" })
  }

  function openUnregister() {
    if (busy()) return
    if (!selectedProject()) {
      setStatus("no project selected")
      return
    }
    showModal({ kind: "unregister" })
  }

  function openNewTree() {
    if (busy()) return
    if (!selectedProject()) {
      setStatus("add a project first")
      return
    }
    showModal({ kind: "new-tree", value: "" })
  }

  function openRename() {
    if (busy()) return
    const tree = selectedTree()
    if (!tree || tree.isMain) {
      setStatus("pick a linked worktree to rename")
      return
    }
    openManualRename()
  }

  function openManualRename() {
    const tree = selectedTree()
    const project = selectedProject()
    if (!tree || tree.isMain || !project) return
    showModal({ kind: "rename", value: tree.displayName, target: { project, tree } })
  }

  async function autoRename() {
    if (busy() || modal()) return
    const project = selectedProject()
    const tree = selectedTree()
    if (!project || !tree || tree.isMain || !tree.branch) {
      setStatus("pick a linked worktree with a branch to auto-rename")
      return
    }
    setModal(null)
    const request = new AbortController()
    renameRequest = request
    setBusy(true)
    setStatus(`asking Luna High for a name for ${tree.displayName}… (esc to cancel)`)
    try {
      const name = await suggestWorktreeName(project.path, tree, request.signal)
      setSelectedProjectId(project.id)
      loadTreesFor(project.id)
      pickTree(tree.path)
      showModal({ kind: "rename", value: name, target: { project, tree } })
      setStatus(`Luna suggested ${name} — edit or submit to rename`)
    } catch (error) {
      setStatus(request.signal.aborted ? "auto-rename cancelled" : error instanceof Error ? error.message : String(error))
    } finally {
      renameRequest = undefined
      setBusy(false)
    }
  }

  function openDelete() {
    if (busy()) return
    const tree = selectedTree()
    if (!tree || tree.isMain) {
      setStatus("pick a linked worktree to delete")
      return
    }
    showModal({ kind: "delete" })
  }

  function openLogs() {
    const path = treeServers().find((row) => row.logPath)?.logPath
    if (!path) return
    try {
      const text = readServerLog(path)
      showModal({ kind: "logs", text: text || "No output yet." })
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  function cancelModal() {
    setModal(null)
  }

  function acceptModal() {
    const current = modal()
    if (!current) return
    if (current.kind === "logs") {
      cancelModal()
      return
    }
    if ("value" in current) {
      submitModal(current.value)
      return
    }
    confirmModal()
  }

  function wheelSelect(event: MouseEvent, selectedIndex: number, count: number, onPick: (index: number) => void) {
    event.stopPropagation()
    if (modal() || menu()) return
    const direction = event.scroll?.direction
    const delta = direction === "down" || direction === "right" ? 1 : direction === "up" || direction === "left" ? -1 : 0
    if (!delta) return
    onPick(nextIndex(selectedIndex, count, delta))
  }

  useKeyboard((key) => {
    if (key.name === "q" && key.ctrl) {
      quit()
      return
    }
    if (menu()) {
      key.preventDefault()
      if (menu()?.renameOpen) {
        if (key.name === "escape" || key.name === "left") {
          setMenu((current) => current ? { ...current, renameOpen: false } : null)
        } else if (["up", "down", "tab"].includes(key.name)) {
          const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1
          setSubmenuIndex((submenuIndex() + delta + submenuActions().length) % submenuActions().length)
        } else if (["return", "enter"].includes(key.name)) pressSubmenu()
        return
      }
      if (key.name === "escape") setMenu(null)
      else if (["up", "down", "tab"].includes(key.name)) {
        const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1
        setMenuIndex((menuIndex() + delta + menuActions().length) % menuActions().length)
      } else if (key.name === "right" && menu()?.pane === "trees" && menuIndex() === 0) openRenameSubmenu()
      else if (["return", "enter"].includes(key.name)) pressMenu()
      return
    }
    if (key.name === "escape" && renameRequest) {
      renameRequest.abort()
      return
    }
    if (modal()) {
      if (modal()?.kind === "logs") {
        if (["escape", "enter", "return"].includes(key.name)) {
          key.preventDefault()
          cancelModal()
        }
        return
      }
      if (key.name === "escape") {
        cancelModal()
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        cycleModalFocus(key.shift ? -1 : 1)
        return
      }
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") {
        handleModalArrow(key.name, () => key.preventDefault())
        return
      }
      if (key.name === "return" || key.name === "enter") {
        if (modalFocus() === "cancel") {
          key.preventDefault()
          cancelModal()
        } else if (modalFocus() === "submit") {
          key.preventDefault()
          acceptModal()
        }
      }
      return
    }
    if (key.name === "q") {
      quit()
      return
    }
    if (key.name === "g") {
      refresh()
      return
    }
    if (key.name === "tab") {
      cycleRow(key.shift ? -1 : 1)
      return
    }
    if (key.name === "left") {
      cycleRow(-1)
      return
    }
    if (key.name === "right") {
      cycleRow(1)
      return
    }
    if (key.name === "down") {
      key.preventDefault()
      if (focusRow() === "header") setFocusRow("panes")
      else if (focusRow() === "pane-actions") setFocusRow("panes")
      else movePaneSelection(1)
      return
    }
    if (key.name === "up") {
      key.preventDefault()
      if (focusRow() === "pane-actions") setFocusRow("panes")
      else if (focusRow() === "panes") {
        const index = pane() === "projects" ? projectIndex() : treeIndex()
        if (index === 0) {
          setFocusRow("header")
          setHeaderIndex(0)
        } else {
          movePaneSelection(-1)
        }
      }
      return
    }
    if (key.name === "return" || key.name === "enter") {
      if (focusRow() === "pane-actions") {
        key.preventDefault()
        pressPaneAction()
      } else if (focusRow() === "header") {
        key.preventDefault()
        pressHeader()
      }
      return
    }
    if (key.name === "m" || (key.name === "f10" && key.shift)) {
      key.preventDefault()
      openMenu(pane())
      return
    }
    if (busy()) return
    if (key.name === "a") {
      openAddProject()
      return
    }
    if (key.name === "u") {
      openUnregister()
      return
    }
    if (key.name === "n") {
      openNewTree()
      return
    }
    if (key.name === "r") {
      if (key.shift) void autoRename()
      else openRename()
      return
    }
    if (key.name === "d") {
      openDelete()
      return
    }
  })

  function submitModal(raw: string) {
    const current = modal()
    if (!current) return
    const value = raw.trim()
    try {
      if (current.kind === "start-command") {
        const project = setProjectStartCommand(dataDir(), current.project.id, value)
        setProjects(loadConfig(dataDir()).projects)
        if (current.tree) openStartPort(project, current.tree)
        else setModal(null)
        setStatus(`saved start command for ${project.name}`)
        return
      }
      if (current.kind === "start") {
        if (!/^\d+$/.test(value)) throw new Error("Enter a whole port number from 1024 to 65535")
        const record = startServer({
          home: dataDir(),
          project: current.project,
          worktree: current.tree,
          port: Number(value),
          usedPorts: servers().filter((row) => row.state !== "failed").map((row) => row.port),
        })
        setModal(null)
        refresh()
        setStatus(`starting :${record.port}`)
        return
      }
      if (current.kind === "add-project") {
        if (!value) throw new Error("path required")
        const project = addProject(dataDir(), value)
        setSelectedProjectId(project.id)
        setModal(null)
        refresh()
        setStatus(`added ${project.name}`)
        return
      }
      if (current.kind === "new-tree") {
        const project = selectedProject()
        if (!project) throw new Error("no project selected")
        if (!value) throw new Error("name required")
        const tree = createWorktree({
          repoPath: project.path,
          home: dataDir(),
          projectId: project.id,
          name: value,
        })
        const notes = setupWorktreeDeps(project.path, tree.path)
        setSelectedTreePath(tree.path)
        setModal(null)
        refresh()
        setStatus(`created ${value}${notes.length ? ` — ${notes.join("; ")}` : ""}`)
        return
      }
      if (current.kind === "rename") {
        const project = current.target?.project ?? selectedProject()
        const target = current.target?.tree
        const tree = target && project ? listWorktrees(project.path).find((row) => row.path === target.path && row.branch === target.branch) : selectedTree()
        if (!project || !tree) throw new Error("nothing to rename")
        if (!value) throw new Error("name required")
        const renamed = renameWorktree({
          repoPath: project.path,
          tree,
          newName: value,
          home: dataDir(),
          projectId: project.id,
        })
        moveRunRecord(dataDir(), project.id, tree.path, renamed.path)
        movePort(dataDir(), tree.path, renamed.path)
        setSelectedTreePath(renamed.path)
        setModal(null)
        refresh()
        setStatus(`renamed to ${value}`)
        return
      }
    } catch (error) {
      setModal({ ...current, value: current.kind === "delete" ? "" : "value" in current ? current.value : value, error: error instanceof Error ? error.message : String(error) } as Modal)
    }
  }

  function confirmModal() {
    const current = modal()
    if (!current) return
    if (current.kind === "unregister") {
      const project = selectedProject()
      if (!project) return
      runOp("unregistering", () => {
        removeProject(dataDir(), project.id)
        return `unregistered ${project.name}`
      })
      setModal(null)
      return
    }
    if (current.kind === "delete") {
      const project = selectedProject()
      const tree = selectedTree()
      if (!project || !tree) return
      runOp("deleting", () => {
        for (const row of serversForWorktree(servers(), tree.path).filter((row) => row.state !== "failed")) stopServer(dataDir(), row)
        removeWorktree({ repoPath: project.path, tree, force: tree.dirty })
        forgetWorktreeRuntime(dataDir(), project.id, tree.path)
        return `deleted ${tree.displayName}`
      })
      setModal(null)
      return
    }
    if (current.kind === "stop") {
      stopRows(current.rows)
      setModal(null)
    }
  }

  function stopRows(rows: ServerRow[]) {
    runOp("stopping", () => {
      for (const row of rows) stopServer(dataDir(), row)
      return `stopped ${rows.length} server(s)`
    })
  }

  function toggleServer() {
    if (busy() || modal()) return
    const project = selectedProject()
    const tree = selectedTree()
    if (!project || !tree) {
      setStatus("pick a worktree")
      return
    }
    const running = activeServers()
    if (running.length > 0) {
      if (running.some((row) => !row.owned)) showModal({ kind: "stop", rows: running })
      else stopRows(running)
      return
    }
    if (!project.startCommand?.trim()) {
      showModal({ kind: "start-command", value: "", project, tree })
      return
    }
    openStartPort(project, tree)
  }

  function openStartCommand() {
    const project = selectedProject()
    if (!project || busy()) return
    showModal({ kind: "start-command", value: project.startCommand ?? "", project })
  }

  function openStartPort(project: Project, tree: GitWorktree) {
    const preferred = loadPorts(dataDir())[tree.path]
    const port = preferred ?? pickPort(servers().filter((row) => row.state !== "failed").map((row) => row.port), undefined, project.basePort)
    showModal({ kind: "start", value: String(port), project, tree })
  }

  const projectIndex = () => Math.max(0, projects().findIndex((project) => project.id === selectedProjectId()))
  const treeIndex = () => Math.max(0, trees().findIndex((tree) => tree.path === selectedTreePath()))

  function modalTitle(current: Modal): string {
    switch (current.kind) {
      case "add-project":
        return "add project"
      case "new-tree":
        return "new worktree"
      case "rename":
        return "rename worktree"
      case "delete":
        return "delete worktree"
      case "unregister":
        return "remove project from list"
      case "stop":
        return "stop servers"
      case "start-command":
        return "project start command"
      case "start":
        return "start server"
      case "logs":
        return "server logs"
    }
  }

  function modalBody(current: Modal): string {
    switch (current.kind) {
      case "add-project":
        return "Path to the main checkout"
      case "new-tree":
        return "Name is used for the directory and the branch"
      case "rename":
        return "Renames the directory and the branch"
      case "delete": {
        const tree = selectedTree()
        const extra = tree?.dirty ? " Working tree is dirty; this force-deletes." : ""
        const running = tree ? serversForWorktree(servers(), tree.path).filter((row) => row.state !== "failed") : []
        const ports = running.length ? ` Also kills ${running.map((row) => `:${row.port}`).join(", ")}.` : ""
        return `Delete ${tree?.displayName ?? "this worktree"}?${extra}${ports}`
      }
      case "unregister":
        return `Remove ${selectedProject()?.name ?? "this project"} from the list? Worktrees stay on disk.`
      case "start-command":
        return "Start command (e.g. bun local). Saved for all project worktrees; runs from the selected worktree."
      case "start":
        return `Port (1024–65535). Command: ${current.project.startCommand}`
      case "logs":
        return "Recent output"
      case "stop":
        return `Stop ${current.rows.map((row) => `:${row.port} (pid ${row.pid}, ${row.owned ? "Workforest" : "external"})`).join(", ")}? External processes were started outside Workforest.`
    }
  }

  function modalPlaceholder(current: Modal): string {
    if (current.kind === "start-command") return "bun local"
    if (current.kind === "add-project") return "~/Projects/Cras"
    if (current.kind === "new-tree" || current.kind === "rename") return "feat-auth"
    return ""
  }

  function modalValue(current: Modal): string {
    return "value" in current ? current.value : ""
  }

  function modalError(current: Modal): string | undefined {
    return "error" in current ? current.error : undefined
  }

  function modalSize(current: Modal) {
    const terminalWidth = dimensions().width
    const terminalHeight = dimensions().height
    const preferredWidth = current.kind === "logs"
      ? terminalWidth - 16
      : current.kind === "stop" ? 116
      : current.kind === "start-command" ? 88 : 76
    const preferredHeight = current.kind === "logs"
      ? Math.floor(terminalHeight * 0.7)
      : 12
    const width = Math.max(1, Math.min(preferredWidth, terminalWidth - 4))
    const height = Math.max(1, Math.min(preferredHeight, terminalHeight - 2))
    return {
      width,
      height,
      left: Math.max(0, Math.floor((terminalWidth - width) / 2)),
      top: Math.max(0, Math.floor((terminalHeight - height) / 2)),
    }
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box height={3} zIndex={2} paddingLeft={1} paddingRight={1} flexDirection="row" alignItems="center" justifyContent="space-between" backgroundColor={theme.header}>
        <text fg={theme.accent} selectable={false}>Workforest</text>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (!modal()) setFocusRow("header")
          }}
        >
          <For each={headerActions()}>
            {(action, index) => (
              <ActionButton
                id={action.id}
                label={action.label}
                variant={action.variant}
                disabled={action.disabled}
                active={focusRow() === "header" && headerIndex() === index()}
                onPress={() => {
                  setFocusRow("header")
                  setHeaderIndex(index())
                  action.onPress()
                }}
              />
            )}
          </For>
        </box>
      </box>

      <box
        flexGrow={1}
        flexDirection="row"
        onMouseDrag={(event) => {
          if (!dividerDragging()) return
          event.stopPropagation()
          event.preventDefault()
          dividerMoved = true
          setProjectPaneWidthState(clampProjectPaneWidth(event.x))
        }}
        onMouseUp={() => {
          if (dividerDragging() && !dividerMoved) lastDividerClick = Date.now()
          setDividerDragging(false)
        }}
        onMouseDragEnd={() => {
          if (!dividerDragging()) return
          setDividerDragging(false)
          lastDividerClick = 0
          persistProjectPaneWidth()
        }}
      >
          <box
            id="pane-projects"
            width={visibleProjectPaneWidth()}
            border={["top", "bottom", "left"]}
            borderColor={pane() === "projects" && focusRow() === "panes" ? theme.borderFocus : theme.border}
            titleColor={pane() === "projects" && focusRow() === "panes" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) focusPane("projects")
            }}
          >
            <box height={1} flexDirection="row" gap={1}>
              <ActionButton id="btn-add" label="+" compact disabled={busy()}
                active={pane() === "projects" && focusRow() === "pane-actions"}
                onPress={() => { focusPane("projects"); openAddProject() }} />
              <text fg={pane() === "projects" ? theme.accent : theme.muted} selectable={false}>{`projects (${projects().length})`}</text>
            </box>
            <Show
              when={projects().length > 0}
              fallback={
                <box
                  onMouseDown={(event) => {
                    event.stopPropagation()
                    openAddProject()
                  }}
                >
                  <text fg={theme.muted} selectable={false}>no projects</text>
                </box>
              }
            >
              <box flexGrow={1} flexDirection="row" ref={(node) => {
                node.onSizeChange = () => setProjectListHeight(node.height)
                setProjectListHeight(node.height)
              }}>
                <box
                  ref={(node) => { projectList = node }}
                  flexGrow={1}
                  flexDirection="column"
                  overflow="hidden"
                  onMouseScroll={(event) => {
                    focusPane("projects")
                    wheelSelect(event, projectIndex(), projects().length, (index) => {
                      const project = projects()[index]
                      if (!project) return
                      setSelectedProjectId(project.id)
                      loadTreesFor(project.id)
                    })
                  }}
                >
                  <For each={visibleRows(projects(), projectIndex(), projectListHeight(), 1)}>{({ row: project, index }) => {
                    const selected = () => index === projectIndex()
                    return <box height={1} flexShrink={0} overflow="hidden"
                      backgroundColor={selected()
                        ? hoveredProjectIndex() === index ? theme.selectedHoverBg : theme.selectedBg
                        : hoveredProjectIndex() === index ? theme.hoverBg : theme.panel}
                      onMouseOver={() => { setHoveredProjectIndex(index); renderer.setMousePointer("pointer") }}
                      onMouseOut={() => { setHoveredProjectIndex(null); renderer.setMousePointer("default") }}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        if (modal() || menu() || (event.button !== 0 && event.button !== 2)) return
                        const activate = event.button === 0 && selected()
                        focusPane("projects")
                        setSelectedProjectId(project.id)
                        loadTreesFor(project.id)
                        if (event.button === 2) openMenu("projects", event.x, event.y)
                        if (activate) focusPane("trees")
                      }}
                    ><text width="100%" height={1} overflow="hidden" fg={selected() ? theme.selectedFg : theme.text} selectable={false}>{`${selected() ? "▶" : " "} ${project.name}`}</text></box>
                  }}</For>
                </box>
              </box>
            </Show>
          </box>

          <box
            id="pane-divider"
            width={1}
            border={["top", "bottom", "left"]}
            borderColor={dividerColor()}
            customBorderChars={{
              topLeft: pane() === "projects" ? "┐" : "┌",
              topRight: pane() === "projects" ? "┐" : "┌",
              bottomLeft: pane() === "projects" ? "┘" : "└",
              bottomRight: pane() === "projects" ? "┘" : "└",
              horizontal: "─",
              vertical: "│",
              topT: "┬",
              bottomT: "┴",
              leftT: "├",
              rightT: "┤",
              cross: "┼",
            }}
            onMouseOver={() => setDividerHovered(true)}
            onMouseOut={() => setDividerHovered(false)}
            onMouseDown={(event) => {
              if (modal() || event.button !== 0) return
              event.stopPropagation()
              event.preventDefault()
              const now = Date.now()
              if (now - lastDividerClick < 350) {
                setProjectPaneWidthState(defaultProjectPaneWidth)
                setDividerDragging(false)
                persistProjectPaneWidth()
                lastDividerClick = 0
                return
              }
              dividerMoved = false
              setDividerDragging(true)
            }}
          />

          <box
            id="pane-trees"
            flexGrow={1}
            border={["top", "right", "bottom"]}
            borderColor={pane() === "trees" && focusRow() === "panes" ? theme.borderFocus : theme.border}
            titleColor={pane() === "trees" && focusRow() === "panes" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) focusPane("trees")
            }}
          >
            <box height={1} flexDirection="row" gap={1}>
              <ActionButton id="btn-new" label="+" compact disabled={!selectedProject() || busy()}
                active={pane() === "trees" && focusRow() === "pane-actions"}
                onPress={() => { focusPane("trees"); openNewTree() }} />
              <text fg={pane() === "trees" ? theme.accent : theme.muted} selectable={false}>{`worktrees (${trees().length})`}</text>
            </box>
            <Show
              when={trees().length > 0}
              fallback={<text fg={theme.muted} selectable={false}>no worktrees</text>}
            >
              <box flexGrow={1} flexDirection="row" ref={(node) => {
                node.onSizeChange = () => setTreeListHeight(node.height)
                setTreeListHeight(node.height)
              }}>
                <box
                  ref={(node) => { treeList = node }}
                  flexGrow={1}
                  flexDirection="column"
                  overflow="hidden"
                  onMouseScroll={(event) => {
                    focusPane("trees")
                    wheelSelect(event, treeIndex(), trees().length, (index) => {
                      const tree = trees()[index]
                      if (tree) pickTree(tree.path)
                    })
                  }}
                >
                  <For each={visibleRows(trees(), treeIndex(), treeListHeight(), 2)}>{({ row: tree, index }) => {
                    const selected = () => index === treeIndex()
                    const name = () => {
                      const [indicator, ...statusParts] = serverStatus(serversForWorktree(servers(), tree.path)).split(" ")
                      const status = statusParts.join(" ")
                      return `${indicator} ${tree.displayName}${tree.isMain ? "  (main)" : ""}${tree.dirty ? "  *" : ""}${status ? `  ${status}` : ""}`
                    }
                    return <box height={2} flexShrink={0} flexDirection="column" overflow="hidden"
                      backgroundColor={selected()
                        ? hoveredTreeIndex() === index ? theme.selectedHoverBg : theme.selectedBg
                        : hoveredTreeIndex() === index ? theme.hoverBg : theme.panel}
                      onMouseOver={() => { setHoveredTreeIndex(index); renderer.setMousePointer("pointer") }}
                      onMouseOut={() => { setHoveredTreeIndex(null); renderer.setMousePointer("default") }}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        if (modal() || menu() || (event.button !== 0 && event.button !== 2)) return
                        focusPane("trees")
                        pickTree(tree.path)
                        if (event.button === 2) openMenu("trees", event.x, event.y)
                      }}
                    >
                      <text width="100%" height={1} overflow="hidden" fg={selected() ? theme.selectedFg : theme.text} selectable={false}>{`${selected() ? "▶" : " "} ${name()}`}</text>
                      <text width="100%" height={1} overflow="hidden" fg={selected() ? theme.selectedFg : theme.muted} selectable={false}>{`   ${tree.branch ?? "detached"}  ${displayPath(tree.path)}`}</text>
                    </box>
                  }}</For>
                </box>
              </box>
            </Show>
          </box>

      </box>

      <Show when={status()}>
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={status().match(/fail|error|not |invalid|already|no /i) ? theme.danger : theme.muted} selectable={false}>{status()}</text>
        </box>
      </Show>

      <Show when={menu()}>
        {(current: () => RowMenu) => <>
          <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={29}
            onMouseDown={(event) => { event.stopPropagation(); event.preventDefault(); setMenu(null) }}
            onMouseScroll={(event) => { event.stopPropagation(); event.preventDefault() }} />
          <box id="context-menu" position="absolute"
            left={Math.max(0, Math.min(current().x, dimensions().width - contextMenuWidth()))}
            top={Math.max(0, Math.min(current().y, dimensions().height - contextMenuHeight()))}
            width={contextMenuWidth()} height={contextMenuHeight()} zIndex={30}
            border borderColor={theme.accent} backgroundColor={theme.panel}
            onMouseDown={(event) => event.stopPropagation()}>
            <For each={menuActions()}>{(action, index) =>
              <ActionButton id={action.id} label={action.label} compact variant={action.variant}
                trailingLabel={action.trailingLabel}
                disabled={action.disabled} active={menuIndex() === index()} onPress={() => pressMenu(index())}
                onHover={() => {
                  setMenuIndex(index())
                  const now = menu()
                  if (!now) return
                  if (now.pane === "trees" && index() === 0) openRenameSubmenu()
                  else if (now.renameOpen) setMenu({ ...now, renameOpen: false })
                }} />
            }</For>
          </box>
          <Show when={current().renameOpen}>
            <box id="rename-submenu" position="absolute"
              left={(() => {
                const mainLeft = Math.max(0, Math.min(current().x, dimensions().width - contextMenuWidth()))
                return mainLeft + contextMenuWidth() + renameSubmenuWidth() - 1 <= dimensions().width
                  ? mainLeft + contextMenuWidth() - 1
                  : Math.max(0, mainLeft - renameSubmenuWidth() + 1)
              })()}
              top={Math.max(0, Math.min(current().y, dimensions().height - contextMenuHeight()))}
              width={renameSubmenuWidth()} height={4} zIndex={31}
              border borderColor={theme.accent} backgroundColor={theme.panel}
              onMouseDown={(event) => event.stopPropagation()}>
              <For each={submenuActions()}>{(action, index) =>
                <ActionButton id={action.id} label={action.label} compact disabled={action.disabled}
                  active={submenuIndex() === index()} onPress={() => pressSubmenu(index())}
                  onHover={() => setSubmenuIndex(index())} />
              }</For>
            </box>
          </Show>
        </>}
      </Show>

      <Show when={modal()} fallback={<box width={0} height={0} />}>
        {(current: () => Modal) => (
          <box
            position="absolute"
            left={modalSize(current()).left}
            top={modalSize(current()).top}
            width={modalSize(current()).width}
            height={modalSize(current()).height}
            zIndex={20}
            border
            borderColor={theme.accent}
            title={modalTitle(current())}
            titleColor={theme.accent}
            backgroundColor={theme.header}
            padding={1}
            flexDirection="column"
            gap={1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <text height={current().kind === "logs" ? 1 : 2} overflow="hidden" fg={theme.text} selectable={false}>{modalBody(current())}</text>
            {current().kind === "logs" ? (
              <>
                <scrollbox flexGrow={1} focused={true}>
                  <text fg={theme.text}>{(current() as Extract<Modal, { kind: "logs" }>).text}</text>
                </scrollbox>
                <ActionButton id="btn-close-logs" label="close" onPress={cancelModal} />
              </>
            ) : (
              <>
                {"value" in current() ? (
                  <input
                    id="modal-input"
                    focused={modalFocus() === "input"}
                    value={modalValue(current())}
                    placeholder={modalPlaceholder(current())}
                    width="100%"
                    backgroundColor={theme.panel}
                    focusedBackgroundColor="#21262d"
                    textColor={theme.text}
                    cursorColor={theme.accent}
                    onMouseDown={() => setModalFocus("input")}
                    onInput={(value) => {
                      const now = modal()
                      if (now && "value" in now) setModal({ ...now, value, error: undefined })
                    }}
                    onSubmit={() => {
                      const now = modal()
                      if (now && "value" in now) submitModal(now.value)
                    }}
                  />
                ) : (
                  <text fg={theme.muted} selectable={false}>confirm or cancel</text>
                )}
                <text fg={theme.danger} selectable={false}>{modalError(current()) ?? ""}</text>
                <box flexDirection="row" gap={1}>
                  <ActionButton
                    id="btn-submit"
                    label={"value" in current() ? "submit" : "confirm"}
                    variant="accent"
                    active={modalFocus() === "submit"}
                    onPress={() => {
                      setModalFocus("submit")
                      acceptModal()
                    }}
                  />
                  <ActionButton
                    id="btn-cancel"
                    label="cancel"
                    active={modalFocus() === "cancel"}
                    onPress={() => {
                      setModalFocus("cancel")
                      cancelModal()
                    }}
                  />
                </box>
              </>
            )}
          </box>
        )}
      </Show>
    </box>
  )
}
