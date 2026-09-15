import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import type { MouseEvent, SelectOption } from "@opentui/core"
import { theme } from "./theme.ts"
import { nextIndex, pickSelectIndex } from "./lib/select-hit.ts"
import { ActionButton } from "./ui/button.tsx"
import { addProject, loadConfig, removeProject } from "./lib/config.ts"
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
import { movePort } from "./lib/ports.ts"
import {
  collectServers,
  forgetWorktreeRuntime,
  moveRunRecord,
  serversForWorktree,
  startServer,
  stopServer,
} from "./lib/servers.ts"
import type { GitWorktree, Project, ServerRow } from "./lib/types.ts"

type Pane = "projects" | "trees" | "servers"
type FocusRow = "panes" | "footer"
type FooterAction = {
  id: string
  label: string
  variant?: "accent" | "danger"
  disabled?: boolean
  onPress: () => void
}

const panes: Pane[] = ["projects", "trees", "servers"]
type TreeRow = GitWorktree & { dirty: boolean; displayName: string }
type Modal =
  | { kind: "add-project"; value: string; error?: string }
  | { kind: "new-tree"; value: string; error?: string }
  | { kind: "rename"; value: string; error?: string }
  | { kind: "delete"; error?: string }
  | { kind: "unregister" }
  | { kind: "kill" }

const dataDir = () => workforestHome()

export function App() {
  const renderer = useRenderer()
  const [pane, setPane] = createSignal<Pane>("projects")
  const [focusRow, setFocusRow] = createSignal<FocusRow>("panes")
  const [footerIndex, setFooterIndex] = createSignal(0)
  const [projects, setProjects] = createSignal<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [trees, setTrees] = createSignal<TreeRow[]>([])
  const [selectedTreePath, setSelectedTreePath] = createSignal<string | null>(null)
  const [servers, setServers] = createSignal<ServerRow[]>([])
  const [selectedServerPid, setSelectedServerPid] = createSignal<number | null>(null)
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal<Modal | null>(null)

  const selectedProject = () => projects().find((project) => project.id === selectedProjectId()) ?? null
  const selectedTree = () => trees().find((tree) => tree.path === selectedTreePath()) ?? null
  const treeServers = () => {
    const tree = selectedTree()
    return tree ? serversForWorktree(servers(), tree.path) : []
  }
  const selectedServer = () => treeServers().find((row) => row.pid === selectedServerPid()) ?? null

  const projectOptions = (): SelectOption[] =>
    projects().map((project) => ({
      name: project.name,
      description: project.path,
      value: project.id,
    }))

  const treeOptions = (): SelectOption[] =>
    trees().map((tree) => ({
      name: `${tree.displayName}${tree.isMain ? "  (main)" : ""}${tree.dirty ? "  *" : ""}`,
      description: `${tree.branch ?? "detached"}  ${tree.path}`,
      value: tree.path,
    }))

  const serverOptions = (): SelectOption[] =>
    treeServers().map((row) => ({
      name: `:${row.port}  ${row.owned ? "owned" : "discovered"}`,
      description: `pid ${row.pid}  ${row.command}`,
      value: String(row.pid),
    }))

  function syncSelectedServer(treePath: string | null, rows: ServerRow[] = servers()) {
    const visible = treePath ? serversForWorktree(rows, treePath) : []
    if (!visible.some((row) => row.pid === selectedServerPid())) {
      setSelectedServerPid(visible[0]?.pid ?? null)
    }
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
    syncSelectedServer(currentPath, rows)
  }

  function loadTreesFor(projectId: string) {
    const project = projects().find((row) => row.id === projectId) ?? loadConfig(dataDir()).projects.find((row) => row.id === projectId)
    if (!project) {
      setTrees([])
      setSelectedTreePath(null)
      syncSelectedServer(null)
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
    syncSelectedServer(path)
  }

  function pickTree(path: string) {
    setSelectedTreePath(path)
    syncSelectedServer(path)
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
      refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
    const timer = setInterval(() => {
      if (busy() || modal()) return
      try {
        refresh()
      } catch {
        // keep last status
      }
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  function quit() {
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
    setFooterIndex(0)
  }

  function footerActions(): FooterAction[] {
    const refreshAction: FooterAction = { id: "btn-refresh", label: "refresh", onPress: () => refresh() }
    if (pane() === "projects") {
      return [
        { id: "btn-add", label: "add", onPress: openAddProject },
        { id: "btn-unregister", label: "unregister", disabled: !selectedProject(), onPress: openUnregister },
        refreshAction,
      ]
    }
    if (pane() === "trees") {
      const tree = selectedTree()
      const linked = Boolean(tree && !tree.isMain)
      return [
        { id: "btn-new", label: "new", disabled: !selectedProject(), onPress: openNewTree },
        { id: "btn-rename", label: "rename", disabled: !linked, onPress: openRename },
        { id: "btn-delete", label: "delete", variant: "danger", disabled: !linked, onPress: openDelete },
        {
          id: "btn-start",
          label: treeServers().length > 0 ? "stop" : "start",
          variant: "accent",
          disabled: !tree,
          onPress: toggleServer,
        },
        refreshAction,
      ]
    }
    return [
      { id: "btn-kill", label: "kill", variant: "danger", disabled: !selectedServer(), onPress: openKill },
      refreshAction,
    ]
  }

  function cycleFooter(delta: number) {
    const actions = footerActions()
    if (actions.length === 0) return
    const current = Math.min(footerIndex(), actions.length - 1)
    setFooterIndex((current + delta + actions.length) % actions.length)
  }

  function pressFooter() {
    const actions = footerActions()
    const action = actions[Math.min(footerIndex(), Math.max(0, actions.length - 1))]
    if (!action || action.disabled) return
    action.onPress()
  }

  function openAddProject() {
    if (busy()) return
    setModal({ kind: "add-project", value: "" })
  }

  function openUnregister() {
    if (busy()) return
    if (!selectedProject()) {
      setStatus("no project selected")
      return
    }
    setModal({ kind: "unregister" })
  }

  function openNewTree() {
    if (busy()) return
    if (!selectedProject()) {
      setStatus("add a project first")
      return
    }
    setModal({ kind: "new-tree", value: "" })
  }

  function openRename() {
    if (busy()) return
    const tree = selectedTree()
    if (!tree || tree.isMain) {
      setStatus("pick a linked worktree to rename")
      return
    }
    setModal({ kind: "rename", value: tree.displayName })
  }

  function openDelete() {
    if (busy()) return
    const tree = selectedTree()
    if (!tree || tree.isMain) {
      setStatus("pick a linked worktree to delete")
      return
    }
    setModal({ kind: "delete" })
  }

  function openKill() {
    if (busy()) return
    const row = selectedServer()
    if (!row) {
      setStatus("no server selected")
      return
    }
    setModal({ kind: "kill" })
  }

  function cancelModal() {
    setModal(null)
  }

  function acceptModal() {
    const current = modal()
    if (!current) return
    if ("value" in current) {
      submitModal(current.value)
      return
    }
    confirmModal()
  }

  function clickSelect(
    event: MouseEvent,
    selectedIndex: number,
    count: number,
    onPick: (index: number, activate: boolean) => void,
  ) {
    event.stopPropagation()
    event.preventDefault()
    const target = event.currentTarget
    if (!target) return
    const index = pickSelectIndex(event.y - target.y, target.height, selectedIndex, count, 2)
    if (index == null) return
    onPick(index, index === selectedIndex)
  }

  function wheelSelect(event: MouseEvent, selectedIndex: number, count: number, onPick: (index: number) => void) {
    event.stopPropagation()
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
    if (modal()) {
      if (key.name === "escape") {
        cancelModal()
        return
      }
      if (key.name === "return" || key.name === "enter") {
        const kind = modal()?.kind
        if (kind === "delete" || kind === "unregister" || kind === "kill") confirmModal()
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
      if (focusRow() === "footer") cycleFooter(key.shift ? -1 : 1)
      else cyclePane(key.shift ? -1 : 1)
      return
    }
    if (key.name === "left") {
      if (focusRow() === "footer") cycleFooter(-1)
      else cyclePane(-1)
      return
    }
    if (key.name === "right") {
      if (focusRow() === "footer") cycleFooter(1)
      else cyclePane(1)
      return
    }
    if (key.name === "down") {
      key.preventDefault()
      if (focusRow() !== "footer") {
        setFocusRow("footer")
        setFooterIndex(0)
      }
      return
    }
    if (key.name === "up") {
      if (focusRow() === "footer") {
        key.preventDefault()
        setFocusRow("panes")
      }
      return
    }
    if ((key.name === "return" || key.name === "enter") && focusRow() === "footer") {
      key.preventDefault()
      pressFooter()
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
      openRename()
      return
    }
    if (key.name === "d") {
      openDelete()
      return
    }
    if (key.name === "k") {
      openKill()
      return
    }
  })

  function submitModal(raw: string) {
    const current = modal()
    if (!current) return
    const value = raw.trim()
    try {
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
        const project = selectedProject()
        const tree = selectedTree()
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
        for (const row of serversForWorktree(servers(), tree.path)) stopServer(dataDir(), row)
        removeWorktree({ repoPath: project.path, tree, force: tree.dirty })
        forgetWorktreeRuntime(dataDir(), project.id, tree.path)
        return `deleted ${tree.displayName}`
      })
      setModal(null)
      return
    }
    if (current.kind === "kill") {
      const row = selectedServer()
      if (!row) return
      runOp("killing", () => {
        stopServer(dataDir(), row)
        return `killed pid ${row.pid} on :${row.port}`
      })
      setModal(null)
      return
    }
  }

  function toggleServer() {
    const project = selectedProject()
    const tree = selectedTree()
    if (!project || !tree) {
      setStatus("pick a worktree")
      return
    }
    const running = treeServers()
    if (running.length > 0) {
      runOp("stopping", () => {
        for (const row of running) stopServer(dataDir(), row)
        return `stopped ${running.length} server(s)`
      })
      return
    }
    runOp("starting", () => {
      const record = startServer({
        home: dataDir(),
        project,
        worktree: tree,
        usedPorts: servers().map((row) => row.port),
      })
      return `started :${record.port} (pid ${record.pid})`
    })
  }

  const projectIndex = () => Math.max(0, projects().findIndex((project) => project.id === selectedProjectId()))
  const treeIndex = () => Math.max(0, trees().findIndex((tree) => tree.path === selectedTreePath()))
  const serverIndex = () => Math.max(0, treeServers().findIndex((row) => row.pid === selectedServerPid()))

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
        return "unregister project"
      case "kill":
        return "kill server"
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
        const running = tree ? serversForWorktree(servers(), tree.path) : []
        const ports = running.length ? ` Also kills ${running.map((row) => `:${row.port}`).join(", ")}.` : ""
        return `Delete ${tree?.displayName ?? "this worktree"}?${extra}${ports}`
      }
      case "unregister":
        return `Remove ${selectedProject()?.name ?? "this project"} from the list? Worktrees stay on disk.`
      case "kill": {
        const row = selectedServer()
        return row ? `Kill pid ${row.pid} on :${row.port}?` : "Nothing to kill"
      }
    }
  }

  function modalPlaceholder(current: Modal): string {
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

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box height={3} zIndex={2} paddingLeft={1} paddingRight={1} flexDirection="row" alignItems="center" justifyContent="space-between" backgroundColor={theme.header}>
        <text fg={theme.accent} selectable={false}>Workforest</text>
        <ActionButton id="btn-quit" label="quit" onPress={quit} />
      </box>

      <box flexGrow={1} flexDirection="row">
          <box
            width={28}
            border
            borderColor={pane() === "projects" ? theme.borderFocus : theme.border}
            title={`projects (${projects().length})`}
            titleColor={pane() === "projects" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) focusPane("projects")
            }}
          >
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
              <select
                focused={pane() === "projects" && focusRow() === "panes" && !modal()}
                options={projectOptions()}
                selectedIndex={projectIndex()}
                showDescription
                backgroundColor={theme.panel}
                focusedBackgroundColor={theme.panel}
                selectedBackgroundColor={theme.selectedBg}
                selectedTextColor={theme.selectedFg}
                textColor={theme.text}
                descriptionColor={theme.muted}
                onMouseDown={(event) => {
                  focusPane("projects")
                  clickSelect(event, projectIndex(), projects().length, (index, activate) => {
                    const project = projects()[index]
                    if (!project) return
                    setSelectedProjectId(project.id)
                    loadTreesFor(project.id)
                    if (activate) focusPane("trees")
                  })
                }}
                onMouseScroll={(event) => {
                  focusPane("projects")
                  wheelSelect(event, projectIndex(), projects().length, (index) => {
                    const project = projects()[index]
                    if (!project) return
                    setSelectedProjectId(project.id)
                    loadTreesFor(project.id)
                  })
                }}
                onChange={(_index, option) => {
                  if (option?.value) {
                    setSelectedProjectId(String(option.value))
                    loadTreesFor(String(option.value))
                  }
                }}
                onSelect={(_index, option) => {
                  if (option?.value) {
                    setSelectedProjectId(String(option.value))
                    loadTreesFor(String(option.value))
                    focusPane("trees")
                  }
                }}
              />
            </Show>
          </box>

          <box
            id="pane-trees"
            flexGrow={1}
            border
            borderColor={pane() === "trees" ? theme.borderFocus : theme.border}
            title={`worktrees (${trees().length})`}
            titleColor={pane() === "trees" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) focusPane("trees")
            }}
          >
            <Show
              when={trees().length > 0}
              fallback={<text fg={theme.muted} selectable={false}>no worktrees</text>}
            >
              <select
                focused={pane() === "trees" && focusRow() === "panes" && !modal()}
                options={treeOptions()}
                selectedIndex={treeIndex()}
                showDescription
                backgroundColor={theme.panel}
                focusedBackgroundColor={theme.panel}
                selectedBackgroundColor={theme.selectedBg}
                selectedTextColor={theme.selectedFg}
                textColor={theme.text}
                descriptionColor={theme.muted}
                onMouseDown={(event) => {
                  focusPane("trees")
                  clickSelect(event, treeIndex(), trees().length, (index, activate) => {
                    const tree = trees()[index]
                    if (!tree) return
                    pickTree(tree.path)
                    if (activate) toggleServer()
                  })
                }}
                onMouseScroll={(event) => {
                  focusPane("trees")
                  wheelSelect(event, treeIndex(), trees().length, (index) => {
                    const tree = trees()[index]
                    if (tree) pickTree(tree.path)
                  })
                }}
                onChange={(_index, option) => {
                  if (option?.value) pickTree(String(option.value))
                }}
                onSelect={() => toggleServer()}
              />
            </Show>
          </box>

          <box
            id="pane-servers"
            width={36}
            border
            borderColor={pane() === "servers" ? theme.borderFocus : theme.border}
            title={`servers (${treeServers().length})`}
            titleColor={pane() === "servers" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) focusPane("servers")
            }}
          >
            <Show
              when={treeServers().length > 0}
              fallback={
                <text fg={theme.muted} selectable={false}>
                  {selectedTree() ? "no listeners on this worktree" : "pick a worktree"}
                </text>
              }
            >
              <select
                focused={pane() === "servers" && focusRow() === "panes" && !modal()}
                options={serverOptions()}
                selectedIndex={serverIndex()}
                showDescription
                backgroundColor={theme.panel}
                focusedBackgroundColor={theme.panel}
                selectedBackgroundColor={theme.selectedBg}
                selectedTextColor={theme.selectedFg}
                textColor={theme.text}
                descriptionColor={theme.muted}
                onMouseDown={(event) => {
                  focusPane("servers")
                  clickSelect(event, serverIndex(), treeServers().length, (index, activate) => {
                    const row = treeServers()[index]
                    if (!row) return
                    setSelectedServerPid(row.pid)
                    if (activate) openKill()
                  })
                }}
                onMouseScroll={(event) => {
                  focusPane("servers")
                  wheelSelect(event, serverIndex(), treeServers().length, (index) => {
                    const row = treeServers()[index]
                    if (row) setSelectedServerPid(row.pid)
                  })
                }}
                onChange={(_index, option) => {
                  if (option?.value) setSelectedServerPid(Number(option.value))
                }}
                onSelect={() => openKill()}
              />
            </Show>
          </box>
      </box>

      <box height={status() ? 6 : 5} zIndex={2} flexDirection="column">
        <Show when={status()}>
          <box paddingLeft={1} paddingRight={1}>
            <text fg={status().match(/fail|error|not |invalid|already|no /i) ? theme.danger : theme.muted} selectable={false}>{status()}</text>
          </box>
        </Show>
        <box
          id="footer-actions"
          border
          borderColor={focusRow() === "footer" ? theme.borderFocus : theme.border}
          title="actions"
          titleColor={focusRow() === "footer" ? theme.accent : theme.muted}
          backgroundColor={theme.panel}
          flexDirection="row"
          gap={1}
          height={5}
          alignItems="center"
          onMouseDown={() => {
            if (!modal()) setFocusRow("footer")
          }}
        >
          <For each={footerActions()}>
            {(action, index) => (
              <ActionButton
                id={action.id}
                label={action.label}
                variant={action.variant}
                disabled={action.disabled}
                active={focusRow() === "footer" && footerIndex() === index()}
                onPress={() => {
                  setFocusRow("footer")
                  setFooterIndex(index())
                  action.onPress()
                }}
              />
            )}
          </For>
        </box>
      </box>

      {modal() ? (
        <box
          position="absolute"
          left={8}
          right={8}
          top={6}
          height={12}
          zIndex={20}
          border
          borderColor={theme.accent}
          title={modalTitle(modal()!)}
          titleColor={theme.accent}
          backgroundColor={theme.header}
          padding={1}
          flexDirection="column"
          gap={1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <text fg={theme.text} selectable={false}>{modalBody(modal()!)}</text>
          {"value" in modal()! ? (
            <input
              focused
              value={modalValue(modal()!)}
              placeholder={modalPlaceholder(modal()!)}
              width="100%"
              backgroundColor={theme.panel}
              focusedBackgroundColor="#21262d"
              textColor={theme.text}
              cursorColor={theme.accent}
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
            <text fg={theme.muted} selectable={false}>click confirm or cancel</text>
          )}
          <text fg={theme.danger} selectable={false}>{modalError(modal()!) ?? ""}</text>
          <box flexDirection="row" gap={1}>
            <ActionButton id="btn-submit" label={"value" in modal()! ? "submit" : "confirm"} variant="accent" onPress={acceptModal} />
            <ActionButton id="btn-cancel" label="cancel" onPress={cancelModal} />
          </box>
        </box>
      ) : (
        <box width={0} height={0} />
      )}
    </box>
  )
}
