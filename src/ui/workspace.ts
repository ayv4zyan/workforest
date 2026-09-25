import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { loadConfig, setSelectedProjectId as saveSelectedProjectId } from "../lib/config.ts"
import { isDirtyAsync, listWorktreesAsync, worktreeDisplayName } from "../lib/git.ts"
import { collectServersAsync, serversForWorktree } from "../lib/servers.ts"
import type { GitWorktree, Project, ServerRow } from "../lib/types.ts"

export type Pane = "projects" | "trees"
export type TreeRow = GitWorktree & { dirty: boolean; displayName: string }
export type TreeGroup = "running" | "stopped"
export type TreeEntry = { kind: "group"; group: TreeGroup; count: number } | { kind: "tree"; tree: TreeRow }

export function createWorkspace(options: {
  home: () => string
  queries: Accessor<Record<Pane, string>>
  onError: (message: string) => void
}) {
  const [projects, setProjects] = createSignal<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [trees, setTrees] = createSignal<TreeRow[]>([])
  const [selectedTreePath, setSelectedTreePath] = createSignal<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = createSignal<Record<TreeGroup, boolean>>({ running: false, stopped: false })
  const [focusedGroup, setFocusedGroup] = createSignal<TreeGroup | null>(null)
  const [servers, setServers] = createSignal<ServerRow[]>([])

  const matches = (query: string, name: string) => name.toLowerCase().includes(query.toLowerCase())
  const filteredProjects = createMemo(() => projects().filter((project) => matches(options.queries().projects, project.name)))
  const filteredTrees = createMemo(() => trees().filter((tree) => matches(options.queries().trees, tree.displayName)))

  createEffect(() => {
    const rows = filteredProjects()
    if (rows.some((row) => row.id === selectedProjectId())) return
    const next = rows[0]?.id ?? null
    setSelectedProjectId(next)
    if (next) loadTreesFor(next)
    else {
      setTrees([])
      setSelectedTreePath(null)
    }
  })

  createEffect(() => {
    const rows = filteredTrees()
    if (!options.queries().trees) return
    setFocusedGroup(null)
    if (!rows.some((row) => row.path === selectedTreePath())) setSelectedTreePath(rows[0]?.path ?? null)
  })

  const selectedProject = () => projects().find((project) => project.id === selectedProjectId()) ?? null
  const selectedTree = () => focusedGroup() ? null : trees().find((tree) => tree.path === selectedTreePath()) ?? null
  const treeServers = () => {
    const tree = selectedTree()
    return tree ? serversForWorktree(servers(), tree.path) : []
  }
  const activeServers = () => treeServers().filter((row) => row.state !== "failed")
  const groupedTrees = createMemo(() => {
    const sorted = [...filteredTrees()].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base", numeric: true }) || a.path.localeCompare(b.path))
    const running: TreeRow[] = []
    const stopped: TreeRow[] = []
    for (const tree of sorted) {
      const active = serversForWorktree(servers(), tree.path).some((row) => row.state !== "failed")
      if (active) running.push(tree)
      else stopped.push(tree)
    }
    return { running, stopped }
  })
  const treeEntries = createMemo<TreeEntry[]>(() => {
    const entries: TreeEntry[] = []
    for (const group of ["running", "stopped"] as const) {
      if (options.queries().trees && !groupedTrees()[group].length) continue
      entries.push({ kind: "group", group, count: groupedTrees()[group].length })
      if (options.queries().trees || !collapsedGroups()[group]) entries.push(...groupedTrees()[group].map((tree): TreeEntry => ({ kind: "tree", tree })))
    }
    return entries
  })

  createEffect(() => {
    if (focusedGroup()) return
    for (const group of ["running", "stopped"] as const) {
      if (collapsedGroups()[group] && groupedTrees()[group].some((tree) => tree.path === selectedTreePath())) {
        setCollapsedGroups((current) => ({ ...current, [group]: false }))
      }
    }
  })

  function toggleGroup(group: TreeGroup) {
    setFocusedGroup(group)
    setCollapsedGroups((current) => ({ ...current, [group]: !current[group] }))
  }

  function pickTree(path: string) {
    setFocusedGroup(null)
    setSelectedTreePath(path)
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId)
    try {
      saveSelectedProjectId(options.home(), projectId)
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error))
    }
  }

  function pickEntry(index: number) {
    const entry = treeEntries()[index]
    if (!entry) return
    if (entry.kind === "group") setFocusedGroup(entry.group)
    else pickTree(entry.tree.path)
  }

  let refreshGeneration = 0
  let refreshPending = false
  let displayedProjectId: string | null = null
  onCleanup(() => { refreshGeneration++ })

  async function refresh(periodic = false) {
    if (periodic && refreshPending) return
    const generation = ++refreshGeneration
    refreshPending = true
    try {
      const config = loadConfig(options.home())
      const currentId = config.projects.some((project) => project.id === selectedProjectId())
        ? selectedProjectId()
        : config.projects.some((project) => project.id === config.ui?.selectedProjectId)
          ? config.ui!.selectedProjectId!
          : (config.projects[0]?.id ?? null)
      setSelectedProjectId(currentId)
      setProjects(config.projects)
      const entriesPending = config.projects.map(async (project) => {
        try { return [project.id, await listWorktreesAsync(project.path)] as const }
        catch { return [project.id, [] as GitWorktree[]] as const }
      })
      const selectedIndex = config.projects.findIndex((project) => project.id === currentId)
      const selectedTrees = selectedIndex < 0 ? [] : (await entriesPending[selectedIndex])?.[1] ?? []
      const listed = await Promise.all(selectedTrees.map(async (tree) => ({
        ...tree,
        dirty: await isDirtyAsync(tree.path),
        displayName: worktreeDisplayName(tree),
      })))
      if (generation !== refreshGeneration || selectedProjectId() !== currentId) return
      displayedProjectId = currentId
      setTrees(listed)
      setSelectedTreePath(listed.some((tree) => tree.path === selectedTreePath())
        ? selectedTreePath() : (listed[0]?.path ?? null))
      const treesByProject = new Map<string, GitWorktree[]>(await Promise.all(entriesPending))
      if (generation !== refreshGeneration) return
      const rows = await collectServersAsync({ home: options.home(), projects: config.projects, treesByProject })
      if (generation === refreshGeneration) setServers(rows)
    } catch (error) {
      if (generation === refreshGeneration) options.onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === refreshGeneration) refreshPending = false
    }
  }

  function loadTreesFor(projectId: string) {
    const project = projects().find((row) => row.id === projectId) ?? loadConfig(options.home()).projects.find((row) => row.id === projectId)
    if (!project) {
      setTrees([])
      setSelectedTreePath(null)
      return
    }
    if (displayedProjectId !== projectId) setTrees([])
    setFocusedGroup(null)
    setCollapsedGroups({ running: false, stopped: false })
    void refresh()
  }

  return {
    projects, setProjects, selectedProjectId, selectProject,
    trees, setTrees, selectedTreePath, setSelectedTreePath,
    focusedGroup, collapsedGroups, servers, filteredProjects, filteredTrees,
    selectedProject, selectedTree, treeServers, activeServers, treeEntries,
    toggleGroup, pickEntry, pickTree, refresh, loadTreesFor,
  }
}
