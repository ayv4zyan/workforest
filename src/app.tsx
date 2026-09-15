import { Show, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
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

type View = "trees" | "servers"
type Pane = "projects" | "trees" | "servers"
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
  const [view, setView] = createSignal<View>("trees")
  const [pane, setPane] = createSignal<Pane>("projects")
  const [projects, setProjects] = createSignal<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [trees, setTrees] = createSignal<TreeRow[]>([])
  const [selectedTreePath, setSelectedTreePath] = createSignal<string | null>(null)
  const [servers, setServers] = createSignal<ServerRow[]>([])
  const [selectedServerPid, setSelectedServerPid] = createSignal<number | null>(null)
  const [status, setStatus] = createSignal("register a project with a")
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal<Modal | null>(null)

  const selectedProject = () => projects().find((project) => project.id === selectedProjectId()) ?? null
  const selectedTree = () => trees().find((tree) => tree.path === selectedTreePath()) ?? null
  const selectedServer = () => servers().find((row) => row.pid === selectedServerPid()) ?? null
  const treeServers = () => {
    const tree = selectedTree()
    return tree ? serversForWorktree(servers(), tree.path) : []
  }

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
    servers().map((row) => ({
      name: `:${row.port}  ${projectName(row.projectId)}  ${displayForPath(row.worktreePath)}`,
      description: `${row.owned ? "owned" : "discovered"}  pid ${row.pid}  ${row.command}`,
      value: String(row.pid),
    }))

  function projectName(id: string): string {
    return projects().find((project) => project.id === id)?.name ?? id
  }

  function displayForPath(path: string): string {
    const tree = trees().find((row) => row.path === path)
    if (tree) return tree.displayName
    const parts = path.split("/").filter(Boolean)
    return parts[parts.length - 1] ?? path
  }

  function refresh(quiet = false) {
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
    if (project) {
      const listed = (treesByProject.get(project.id) ?? []).map((tree) => ({
        ...tree,
        dirty: isDirty(tree.path),
        displayName: worktreeDisplayName(tree),
      }))
      setTrees(listed)
      const currentPath = listed.some((tree) => tree.path === selectedTreePath())
        ? selectedTreePath()
        : (listed[0]?.path ?? null)
      setSelectedTreePath(currentPath)
    } else {
      setTrees([])
      setSelectedTreePath(null)
    }

    const rows = collectServers({ home: dataDir(), projects: config.projects, treesByProject })
    setServers(rows)
    if (!rows.some((row) => row.pid === selectedServerPid())) {
      setSelectedServerPid(rows[0]?.pid ?? null)
    }
    if (!quiet) setStatus(`${config.projects.length} project(s)`)
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
    if (!listed.some((tree) => tree.path === selectedTreePath())) {
      setSelectedTreePath(listed[0]?.path ?? null)
    }
  }

  function runOp(label: string, fn: () => string | void) {
    if (busy()) return
    setBusy(true)
    setStatus(label)
    try {
      const message = fn()
      refresh(true)
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
        refresh(true)
      } catch {
        // keep last status
      }
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  function goTrees() {
    setView("trees")
    setPane("projects")
  }

  function goServers() {
    setView("servers")
    setPane("servers")
  }

  function quit() {
    renderer.destroy()
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
    const fromTree = view() === "trees" ? treeServers()[0] : undefined
    const row = fromTree ?? selectedServer()
    if (!row) {
      setStatus("no server selected")
      return
    }
    setSelectedServerPid(row.pid)
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
    if (key.name === "1") {
      goTrees()
      return
    }
    if (key.name === "2") {
      goServers()
      return
    }
    if (key.name === "tab") {
      if (view() === "servers") {
        setPane("servers")
        return
      }
      setPane(pane() === "projects" ? "trees" : "projects")
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
        refresh(true)
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
        refresh(true)
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
        refresh(true)
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
  const serverIndex = () => Math.max(0, servers().findIndex((row) => row.pid === selectedServerPid()))

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

  const canRename = () => {
    const tree = selectedTree()
    return Boolean(tree && !tree.isMain)
  }
  const canDelete = () => canRename()
  const canKill = () => Boolean(view() === "trees" ? treeServers()[0] : selectedServer())
  const startLabel = () => (treeServers().length > 0 ? "stop" : "start")

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box height={3} zIndex={2} paddingLeft={1} paddingRight={1} flexDirection="row" alignItems="center" justifyContent="space-between" backgroundColor={theme.header}>
        <text fg={theme.accent} selectable={false}>Workforest</text>
        <box flexDirection="row" gap={1}>
          <ActionButton id="tab-worktrees" label="worktrees" variant={view() === "trees" ? "accent" : "default"} onPress={goTrees} />
          <ActionButton id="tab-servers" label="servers" variant={view() === "servers" ? "accent" : "default"} onPress={goServers} />
        </box>
        <ActionButton id="btn-quit" label="quit" onPress={quit} />
      </box>

      {view() === "trees" ? (
        <box flexGrow={1} flexDirection="row">
          <box
            width={28}
            border
            borderColor={pane() === "projects" ? theme.borderFocus : theme.border}
            title="projects"
            titleColor={pane() === "projects" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) setPane("projects")
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
                focused={pane() === "projects" && !modal()}
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
                  setPane("projects")
                  clickSelect(event, projectIndex(), projects().length, (index, activate) => {
                    const project = projects()[index]
                    if (!project) return
                    setSelectedProjectId(project.id)
                    loadTreesFor(project.id)
                    if (activate) setPane("trees")
                  })
                }}
                onMouseScroll={(event) => {
                  setPane("projects")
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
                    setPane("trees")
                  }
                }}
              />
            </Show>
          </box>

          <box
            flexGrow={1}
            border
            borderColor={pane() === "trees" ? theme.borderFocus : theme.border}
            title="worktrees"
            titleColor={pane() === "trees" ? theme.accent : theme.muted}
            backgroundColor={theme.panel}
            onMouseDown={() => {
              if (!modal()) setPane("trees")
            }}
          >
            <Show
              when={trees().length > 0}
              fallback={<text fg={theme.muted} selectable={false}>no worktrees</text>}
            >
              <select
                focused={pane() === "trees" && !modal()}
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
                  setPane("trees")
                  clickSelect(event, treeIndex(), trees().length, (index, activate) => {
                    const tree = trees()[index]
                    if (!tree) return
                    setSelectedTreePath(tree.path)
                    if (activate) toggleServer()
                  })
                }}
                onMouseScroll={(event) => {
                  setPane("trees")
                  wheelSelect(event, treeIndex(), trees().length, (index) => {
                    const tree = trees()[index]
                    if (tree) setSelectedTreePath(tree.path)
                  })
                }}
                onChange={(_index, option) => {
                  if (option?.value) setSelectedTreePath(String(option.value))
                }}
                onSelect={() => toggleServer()}
              />
            </Show>
          </box>

          <box width={36} border borderColor={theme.border} title="detail" titleColor={theme.muted} backgroundColor={theme.panel} padding={1} flexDirection="column" gap={1}>
            <Show when={selectedTree()} fallback={<text fg={theme.muted} selectable={false}>pick a worktree</text>}>
              {(tree: Accessor<TreeRow>) => (
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text} selectable={false}>{tree().displayName}</text>
                  <text fg={theme.muted} selectable={false}>{`branch  ${tree().branch ?? "detached"}`}</text>
                  <text fg={theme.muted} selectable={false}>{`path    ${tree().path}`}</text>
                  <text fg={tree().dirty ? theme.warn : theme.accent} selectable={false}>{tree().dirty ? "dirty" : "clean"}</text>
                  <text fg={theme.muted} selectable={false}>
                    {`servers  ${
                      treeServers().length === 0
                        ? "none"
                        : treeServers()
                            .map((row) => `:${row.port}`)
                            .join(" ")
                    }`}
                  </text>
                  <box flexDirection="row" gap={1}>
                    <ActionButton label={startLabel()} variant="accent" onPress={toggleServer} />
                    <ActionButton label="rename" disabled={!canRename()} onPress={openRename} />
                    <ActionButton label="delete" variant="danger" disabled={!canDelete()} onPress={openDelete} />
                  </box>
                </box>
              )}
            </Show>
          </box>
        </box>
      ) : (
        <box
          flexGrow={1}
          border
          borderColor={theme.borderFocus}
          title="servers"
          titleColor={theme.accent}
          backgroundColor={theme.panel}
          onMouseDown={() => {
            if (!modal()) setPane("servers")
          }}
        >
          <Show when={servers().length > 0} fallback={<text fg={theme.muted} selectable={false}>no listeners in registered worktrees</text>}>
            <select
              focused={!modal()}
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
                clickSelect(event, serverIndex(), servers().length, (index, activate) => {
                  const row = servers()[index]
                  if (!row) return
                  setSelectedServerPid(row.pid)
                  if (activate) openKill()
                })
              }}
              onMouseScroll={(event) => {
                wheelSelect(event, serverIndex(), servers().length, (index) => {
                  const row = servers()[index]
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
      )}

      <box height={5} zIndex={2} paddingLeft={1} paddingRight={1} backgroundColor={theme.header} flexDirection="column">
        <text fg={status().match(/fail|error|not |invalid|already|no /i) ? theme.danger : theme.muted} selectable={false}>{status()}</text>
        <box flexDirection="row" gap={1} height={3}>
          <ActionButton id="btn-add" label="add" onPress={openAddProject} />
          <ActionButton label="new" disabled={!selectedProject()} onPress={openNewTree} />
          <ActionButton label="rename" disabled={!canRename()} onPress={openRename} />
          <ActionButton label="delete" variant="danger" disabled={!canDelete()} onPress={openDelete} />
          <ActionButton label="unregister" disabled={!selectedProject()} onPress={openUnregister} />
          <ActionButton label={startLabel()} variant="accent" disabled={!selectedTree()} onPress={toggleServer} />
          <ActionButton label="kill" variant="danger" disabled={!canKill()} onPress={openKill} />
          <ActionButton label="refresh" onPress={() => refresh()} />
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
