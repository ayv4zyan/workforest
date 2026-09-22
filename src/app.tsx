import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { BoxRenderable, InputRenderable } from "@opentui/core"
import { theme } from "./theme.ts"
import { ActionButton } from "./ui/button.tsx"
import { ModalLayer } from "./ui/modal-layer.tsx"
import { handleModalKey } from "./ui/modal-keyboard.ts"
import { navigationKey, type NavigationAction } from "./ui/navigation-keyboard.ts"
import { createServerWorkflow } from "./ui/server-workflow.ts"
import { createProjectWorkflow } from "./ui/project-workflow.ts"
import { createWorktreeWorkflow } from "./ui/worktree-workflow.ts"
import { ProjectPane } from "./ui/project-pane.tsx"
import { TreePane } from "./ui/tree-pane.tsx"
import { createContextMenu, type MenuAction } from "./ui/context-menu.tsx"
import { createWorkspace, type Pane } from "./ui/workspace.ts"
import { modalArrowFocus, modalFocusables, type Modal, type ModalFocus } from "./ui/modal-model.ts"
import { createSettingsWorkflow } from "./ui/settings-workflow.ts"
import { createPathWorkflow } from "./ui/path-workflow.ts"
import { loadConfig, setProjectPaneWidth } from "./lib/config.ts"
import { workforestHome } from "./lib/home.ts"

type FocusRow = "header" | "panes" | "pane-actions"
type Action = MenuAction

const panes: Pane[] = ["projects", "trees"]
const defaultProjectPaneWidth = 28
const minProjectPaneWidth = 16
const minTreePaneWidth = 24
const dataDir = () => workforestHome()

export function App() {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const {
    menu, setMenu, open: openContextMenu, openRenameSubmenu,
    handleKey: handleMenuKey, Layer: ContextMenuLayer,
  } = createContextMenu({ dimensions, actions: () => menuActions(), submenuActions: () => submenuActions() })
  const [projectListHeight, setProjectListHeight] = createSignal(0)
  const [treeListHeight, setTreeListHeight] = createSignal(0)
  let projectList: BoxRenderable | undefined
  let treeList: BoxRenderable | undefined
  const [pane, setPane] = createSignal<Pane>("projects")
  const [searchEditing, setSearchEditing] = createSignal(false)
  const [queries, setQueries] = createSignal<Record<Pane, string>>({ projects: "", trees: "" })
  const [focusRow, setFocusRow] = createSignal<FocusRow>("panes")
  const [headerIndex, setHeaderIndex] = createSignal(0)
  const [modalFocus, setModalFocus] = createSignal<ModalFocus>("input")
  const [status, setStatus] = createSignal("")
  const {
    setProjects, selectedProjectId, setSelectedProjectId,
    selectedTreePath, setSelectedTreePath, focusedGroup, collapsedGroups, servers,
    filteredProjects, selectedProject, selectedTree,
    treeServers, activeServers, treeEntries, toggleGroup, pickEntry,
    pickTree, refresh, loadTreesFor,
  } = createWorkspace({ home: dataDir, queries, onError: setStatus })
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal<Modal | null>(null)
  const { openAddProject, openUnregister, submitAddProject, unregister } = createProjectWorkflow({
    home: dataDir,
    workspace: { selectedProject, setSelectedProjectId, refresh },
    dialog: { setModal, show: showModal },
    operation: { busy, setStatus, run: runOp },
  })
  const { openLogs, stopRows, toggleServer, openStartCommand, submit: submitServer } = createServerWorkflow({
    home: dataDir,
    workspace: { selectedProject, selectedTree, servers, activeServers, treeServers, setProjects },
    dialog: { modal, setModal, show: showModal },
    operation: { busy, setStatus, refresh, run: runOp },
  })
  const settingsWorkflow = createSettingsWorkflow({ home: dataDir, modal, setModal, setModalFocus, setStatus })
  const {
    settingsOpen, setSettingsOpen, settingsHighlight, setSettingsHighlight,
    openSettings: openSettingsWorkflow, toggleSettings, pickSettings, saveSettings,
  } = settingsWorkflow
  const {
    renaming, abortRename, copyWorktreePath, retryWorktreeSetup,
    openNewTree, toggleSourceMenu, pickSource, openRename, openManualRename,
    autoRename, openDelete, submit: submitWorktree, deleteTree,
  } = createWorktreeWorkflow({
    home: dataDir, renderer,
    workspace: { selectedProject, selectedTree, setSelectedProjectId, setSelectedTreePath,
      loadTreesFor, pickTree, servers, refresh },
    dialog: { modal, setModal, setModalFocus, setHighlight: setSettingsHighlight, show: showModal },
    operation: { busy, setBusy, setStatus, run: runOp },
  })
  let modalInput: InputRenderable | undefined
  const pathWorkflow = createPathWorkflow({
    modal, setModal, setModalFocus, terminalHeight: () => dimensions().height, input: () => modalInput,
  })
  const { pathSuggestions, pathIndex, setPathIndex, applyPath } = pathWorkflow
  const [projectPaneWidth, setProjectPaneWidthState] = createSignal(defaultProjectPaneWidth)
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

  function openSearch() {
    if (modal() || menu()) return
    setFocusRow("panes")
    setSearchEditing(true)
  }

  function clearSearch() {
    setQueries((current) => ({ ...current, [pane()]: "" }))
    setSearchEditing(false)
    setFocusRow("panes")
  }

  async function runOp(label: string, fn: () => string | void | Promise<string | void>) {
    if (busy()) return
    setBusy(true)
    setStatus(label)
    try {
      const message = await fn()
      await refresh()
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
      void refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
    const timer = setInterval(() => {
      if (busy() || modal() || menu()) return
      try {
        void refresh(true)
      } catch {
        // keep last status
      }
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })

  function quit() {
    abortRename()
    renderer.destroy()
  }

  function focusPane(next: Pane) {
    setSearchEditing(false)
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
      const next = Math.max(0, Math.min(projectIndex() + delta, filteredProjects().length - 1))
      const project = filteredProjects()[next]
      if (!project || project.id === selectedProjectId()) return
      setSelectedProjectId(project.id)
      loadTreesFor(project.id)
      return
    }
    const next = Math.max(0, Math.min(treeIndex() + delta, treeEntries().length - 1))
    pickEntry(next)
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
      { id: "btn-refresh", label: "↻", onPress: () => refresh() },
      ...serverActions,
      { id: "btn-settings", label: "⚙", onPress: openSettings },
      { id: "btn-quit", label: "✕", variant: "danger", onPress: quit },
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
      { id: "btn-create-tree", label: "Create worktree", disabled: !tree || busy(), onPress: () => openNewTree(tree?.branch ?? undefined) },
      { id: "btn-delete", label: "Delete", variant: "danger", disabled: !linked, onPress: openDelete },
      { id: "btn-setup-tree", label: "Set up dependencies", disabled: !linked, onPress: retryWorktreeSetup },
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
      ? selectedRowTop(projectIndex(), filteredProjects().length, projectListHeight(), 1)
      : selectedRowTop(treeIndex(), treeEntries().length, treeListHeight() - 1, 1)
    openContextMenu({ pane: target, x: x ?? (list?.x ?? 0) + (list?.width ?? 0), y: y ?? (list?.y ?? 4) + row, renameOpen: false })
  }

  function submenuActions(): Action[] {
    return [
      { id: "btn-manual-rename", label: "Manual", onPress: openManualRename },
      { id: "btn-auto-rename", label: "Auto", disabled: !selectedTree()?.branch, onPress: () => void autoRename() },
    ]
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

  function cycleModalFocus(delta: number) {
    const current = modal()
    const items = current ? modalFocusables(current) : []
    if (items.length === 0) return
    const index = items.indexOf(modalFocus())
    const start = index < 0 ? 0 : index
    setModalFocus(items[(start + delta + items.length) % items.length]!)
  }

  function handleModalArrow(name: string, preventDefault: () => void) {
    const current = modal()
    if (!current) return
    const next = modalArrowFocus(current, modalFocus(), name)
    if (next === null) return
    preventDefault()
    if (next !== modalFocus()) setModalFocus(next)
  }

  function toggleRenameFolder() {
    setModal((current) => current?.kind === "rename" ? { ...current, renameFolder: !current.renameFolder, error: undefined } : current)
  }

  function openSettings() {
    setMenu(null)
    openSettingsWorkflow()
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

  useKeyboard((key) => {
    if (key.name === "q" && key.ctrl) {
      quit()
      return
    }
    if (menu()) {
      handleMenuKey(key)
      return
    }
    if (key.name === "escape" && renaming()) {
      abortRename()
      return
    }
    if (modal()) {
      handleModalKey(key, {
        model: { modal, setModal, modalFocus, setModalFocus, cycleModalFocus, handleModalArrow,
          cancelModal, acceptModal, toggleSourceMenu, pickSource, toggleRenameFolder,
          abortRename },
        settings: { settingsOpen, setSettingsOpen, settingsHighlight, setSettingsHighlight,
          pickSettings, toggleSettings, saveSettings },
        path: { pathSuggestions, pathIndex, setPathIndex, input: () => modalInput, applyPath },
      })
      return
    }
    const action = navigationKey(key, {
      searchEditing: searchEditing(), query: queries()[pane()], pane: pane(),
      focusRow: focusRow(), busy: busy(),
      selectedIndex: pane() === "projects" ? projectIndex() : treeIndex(),
      focusedGroup: focusedGroup(),
    })
    if (action) dispatchNavigation(action)
  })

  function dispatchNavigation(action: NavigationAction) {
    switch (action.type) {
      case "clear-search": clearSearch(); break
      case "stop-search": setSearchEditing(false); break
      case "open-search": openSearch(); break
      case "quit": quit(); break
      case "refresh": void refresh(); break
      case "cycle-row": cycleRow(action.delta); break
      case "move-selection": movePaneSelection(action.delta); break
      case "focus-panes": setFocusRow("panes"); break
      case "focus-header": setFocusRow("header"); setHeaderIndex(0); break
      case "toggle-group": if (focusedGroup()) toggleGroup(focusedGroup()!); break
      case "press-pane": pressPaneAction(); break
      case "press-header": pressHeader(); break
      case "open-menu": openMenu(action.pane); break
      case "add-project": openAddProject(); break
      case "unregister": openUnregister(); break
      case "new-tree": openNewTree(); break
      case "auto-rename": void autoRename(); break
      case "rename": openRename(); break
      case "delete": openDelete(); break
    }
  }

  function submitModal(raw: string) {
    const current = modal()
    if (!current) return
    const value = raw.trim()
    try {
      if (submitServer(current, value)) return
      if (current.kind === "add-project") {
        submitAddProject(value)
        return
      }
      if (submitWorktree(current, value)) return
    } catch (error) {
      setModal({ ...current, value: current.kind === "delete" ? "" : "value" in current ? current.value : value, error: error instanceof Error ? error.message : String(error) } as Modal)
    }
  }

  function confirmModal() {
    const current = modal()
    if (!current) return
    if (current.kind === "unregister") {
      unregister()
      return
    }
    if (current.kind === "delete") {
      deleteTree()
      return
    }
    if (current.kind === "stop") {
      stopRows(current.rows)
      setModal(null)
    }
  }

  const projectIndex = () => Math.max(0, filteredProjects().findIndex((project) => project.id === selectedProjectId()))
  const treeIndex = () => Math.max(0, treeEntries().findIndex((entry) => entry.kind === "group" ? entry.group === focusedGroup() : !focusedGroup() && entry.tree.path === selectedTreePath()))

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
          <ProjectPane
            width={visibleProjectPaneWidth()}
            active={pane() === "projects" && focusRow() === "panes"}
            selectedPane={pane() === "projects"}
            actionActive={pane() === "projects" && focusRow() === "pane-actions"}
            busy={busy()} blocked={Boolean(modal() || menu())}
            query={queries().projects} projects={filteredProjects()} selectedId={selectedProjectId()}
            onFocus={() => focusPane("projects")} onAdd={openAddProject}
            onSelect={(id) => { setSelectedProjectId(id); loadTreesFor(id) }}
            onActivate={() => focusPane("trees")}
            onMenu={(x, y) => openMenu("projects", x, y)}
            onListLayout={(node, height) => { projectList = node; setProjectListHeight(height) }}
          />

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

          <TreePane
            focus={{ selected: pane() === "trees", row: focusRow() }}
            busy={busy()} blocked={Boolean(modal() || menu())}
            query={queries().trees} project={selectedProject()}
            trees={treeEntries()} selectedIndex={treeIndex()} focusedGroup={focusedGroup()}
            collapsedGroups={collapsedGroups()} servers={servers()}
            on={{
              focus: () => focusPane("trees"), new: () => openNewTree(),
              pickEntry, pickTree, toggleGroup,
              menu: (x, y) => openMenu("trees", x, y),
              listLayout: (node, height) => { treeList = node; setTreeListHeight(height) },
            }}
          />

      </box>

      <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
        <Show when={searchEditing() || queries()[pane()]} fallback={
          <ActionButton id="btn-search" label="/ search" compact onPress={openSearch} />
        }>
          <text fg={theme.muted} selectable={false}>{pane() === "projects" ? "Search projects" : "Search worktrees"}</text>
          <text fg={theme.accent} selectable={false}>/</text>
          <input
            id="search-input"
            flexGrow={1}
            focused={searchEditing() && !modal() && !menu()}
            value={queries()[pane()]}
            backgroundColor={theme.bg}
            textColor={theme.text}
            cursorColor={theme.accent}
            onMouseDown={openSearch}
            onInput={(value) => setQueries((current) => ({ ...current, [pane()]: value }))}
          />
          <ActionButton id="btn-search-clear" label="Esc clear" compact onPress={clearSearch} />
        </Show>
      </box>

      <Show when={status()}>
        <box height={1} paddingLeft={1} paddingRight={1}>
          <text fg={status().match(/fail|error|not |invalid|already|no /i) ? theme.danger : theme.muted} selectable={false}>{status()}</text>
        </box>
      </Show>

      <ContextMenuLayer />

      <ModalLayer
        model={{ modal, setModal, modalFocus, setModalFocus, dimensions,
          selectedProject, selectedTree, servers, setModalInput: (node) => { modalInput = node } }}
        settings={settingsWorkflow}
        paths={pathWorkflow}
        actions={{ cancelModal, abortRename, submitModal, toggleSourceMenu, pickSource,
          toggleRenameFolder, acceptModal }}
      />
    </box>
  )
}
