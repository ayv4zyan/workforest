import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { realpathSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { BoxRenderable, RGBA, TextAttributes, TextRenderable, type InputRenderable, type Renderable } from "@opentui/core"
import { addProject, loadConfig, saveConfig, setProjectStartCommand, setWorktreePinned } from "./lib/config.ts"
import { createWorktree, gitOk, listWorktrees } from "./lib/git.ts"
import { collectServers, startServer, stopServer, loadRunRecords } from "./lib/servers.ts"
import { rememberPort } from "./lib/ports.ts"
import { App } from "./app.tsx"
import { ActionButton } from "./ui/button.tsx"
import { theme } from "./theme.ts"

function findText(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle)
    if (x >= 0) return { x: x + Math.min(1, needle.length - 1), y }
  }
  throw new Error(`missing ${JSON.stringify(needle)}\n${frame}`)
}

function findById(node: Renderable, id: string): Renderable | undefined {
  if (node.id === id) return node
  for (const child of node.getChildren()) {
    const found = findById(child, id)
    if (found) return found
  }
  return undefined
}

const initialized = new WeakSet<object>()

async function paint(setup: { renderOnce: () => Promise<void> }) {
  const firstPaint = !initialized.has(setup)
  initialized.add(setup)
  await Bun.sleep(firstPaint ? 200 : 20)
  await setup.renderOnce()
}

test.serial("pinned worktrees drag in place and keep their shared order through server transitions and restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-tree-drag-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home"), repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = setProjectStartCommand(home, addProject(home, repo).id, "bun server.ts")
  const [alpha, beta, gamma] = ["alpha-work", "beta-hidden", "gamma-work"].map((name) => {
    const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name })
    writeFileSync(join(tree.path, "server.ts"), 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("hello") })')
    setWorktreePinned(home, tree.path, true)
    return tree
  }) as [ReturnType<typeof createWorktree>, ReturnType<typeof createWorktree>, ReturnType<typeof createWorktree>]
  writeFileSync(join(gamma.path, "draft.txt"), "keep this draft")
  const originalTrees = listWorktrees(repo)
  const records: ReturnType<typeof startServer>[] = []
  const stop = (record: ReturnType<typeof startServer>) => stopServer(home, { ...record, command: record.command.join(" "), owned: true })
  let setup = await testRender(() => <App />, { width: 110, height: 24 })
  const row = (path: string) => findById(setup.renderer.root, `tree-row-${path}`)!
  const order = () => loadConfig(home).projects[0]!.worktreeOrder!
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    await setup.mockMouse.click(node.x + 1, node.y)
    await paint(setup)
  }
  const waitFor = async (text: string) => {
    for (let i = 0; i < 80 && !setup.captureCharFrame().includes(text); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain(text)
  }
  try {
    await waitFor("Pinned (4)")
    await setup.mockMouse.pressDown(row(gamma.path).x + 3, row(gamma.path).y)
    await paint(setup)
    await setup.mockMouse.moveTo(row(alpha.path).x + 3, row(alpha.path).y)
    await paint(setup)
    expect(findById(setup.renderer.root, "tree-drop-indicator")!.y).toBe(row(alpha.path).y - 1)
    expect(findById(setup.renderer.root, "tree-drag-preview")).toBeTruthy()
    await setup.mockMouse.release(row(alpha.path).x + 3, row(alpha.path).y - 1)
    await paint(setup)
    const ranked = [gamma.path, alpha.path, beta.path, repo]
    expect(order()).toEqual(ranked)
    expect(row(gamma.path).y).toBeLessThan(row(alpha.path).y)
    expect(row(gamma.path).height).toBe(2)
    expect(findById(setup.renderer.root, "tree-drag-preview")).toBeUndefined()

    // A drop on another category cancels instead of changing pins or ranks.
    const running = findById(setup.renderer.root, "tree-group-running")!
    await setup.mockMouse.pressDown(row(gamma.path).x + 3, row(gamma.path).y)
    await setup.mockMouse.moveTo(running.x + 3, running.y + 2)
    await paint(setup)
    await setup.mockMouse.moveTo(running.x + 3, running.y)
    await paint(setup)
    expect(findById(setup.renderer.root, "tree-drop-indicator")).toBeUndefined()
    await setup.mockMouse.release(running.x + 3, running.y)
    await paint(setup)
    expect(order()).toEqual(ranked)
    expect(loadConfig(home).ui?.pinnedWorktreePaths).toEqual([alpha.path, beta.path, gamma.path])
    await setup.mockMouse.pressDown(row(gamma.path).x + 3, row(gamma.path).y)
    await setup.mockMouse.moveTo(row(beta.path).x + 3, row(beta.path).y)
    await paint(setup)
    expect(findById(setup.renderer.root, "tree-drop-indicator")!.y).toBe(row(beta.path).y + row(beta.path).height)
    setup.mockInput.pressEscape()
    await paint(setup)
    await setup.mockMouse.release(row(beta.path).x + 3, row(beta.path).y)
    await paint(setup)
    expect(order()).toEqual(ranked)

    // Hidden worktrees retain their rank when the visible pinned subset is reordered.
    await setup.mockInput.typeText("/work")
    await paint(setup)
    expect(row(beta.path)).toBeUndefined()
    await setup.mockMouse.drag(row(gamma.path).x + 3, row(gamma.path).y, row(alpha.path).x + 3, row(alpha.path).y)
    await paint(setup)
    expect(order()).toEqual([alpha.path, gamma.path, beta.path, repo])
    await setup.mockMouse.drag(row(gamma.path).x + 3, row(gamma.path).y, row(alpha.path).x + 3, row(alpha.path).y)
    await paint(setup)
    expect(order()).toEqual(ranked)
    setup.mockInput.pressEscape()
    await paint(setup)

    for (const tree of [alpha, beta, gamma]) setWorktreePinned(home, tree.path, false)
    setWorktreePinned(home, repo, false, true)
    await click("btn-refresh")
    await waitFor("Not running (4)")
    expect(row(gamma.path).y).toBeLessThan(row(alpha.path).y)
    expect(row(alpha.path).y).toBeLessThan(row(beta.path).y)
    // Non-pinned rows retain ordinary selection behavior and cannot be reordered yet.
    await setup.mockMouse.drag(row(beta.path).x + 3, row(beta.path).y, row(gamma.path).x + 3, row(gamma.path).y)
    await paint(setup)
    expect(order()).toEqual(ranked)
    expect(findById(setup.renderer.root, "tree-drag-preview")).toBeUndefined()

    const probes = [Bun.serve({ port: 0, fetch: () => new Response("probe") }), Bun.serve({ port: 0, fetch: () => new Response("probe") })]
    const ports = probes.map((probe) => probe.port!)
    probes.forEach((probe) => probe.stop(true))
    const start = (tree: typeof gamma, port: number, usedPorts: number[]) => {
      const record = startServer({ home, project, worktree: tree, port, usedPorts })
      records.push(record)
      return record
    }
    const gammaServer = start(gamma, ports[0]!, [])
    start(beta, ports[1]!, [ports[0]!])
    await click("btn-refresh")
    await waitFor("Running (2)")
    expect(row(gamma.path).y).toBeLessThan(row(beta.path).y)
    await stop(gammaServer)
    await click("btn-refresh")
    await waitFor("Not running (3)")
    expect(row(gamma.path).y).toBeLessThan(row(alpha.path).y)
    expect(order()).toEqual(ranked)
    start(gamma, ports[0]!, [ports[1]!])
    await click("btn-refresh")
    await waitFor("Running (2)")
    expect(row(gamma.path).y).toBeLessThan(row(beta.path).y)
    setWorktreePinned(home, gamma.path, true)
    setWorktreePinned(home, alpha.path, true)
    await click("btn-refresh")
    await waitFor("Pinned (2)")
    expect(row(gamma.path).y).toBeLessThan(row(alpha.path).y)
    expect(order()).toEqual(ranked)
    expect(listWorktrees(repo)).toEqual(originalTrees)
    expect(await Bun.file(join(gamma.path, "draft.txt")).text()).toBe("keep this draft")
    setup.renderer.destroy()
    setup = await testRender(() => <App />, { width: 110, height: 24 })
    await waitFor("Pinned (2)")
    expect(row(gamma.path).y).toBeLessThan(row(alpha.path).y)
    expect(order()).toEqual(ranked)
  } finally {
    setup.renderer.destroy()
    for (const record of records) { try { await stop(record) } catch { /* already stopped */ } }
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test.serial("pinned dragging scrolls to offscreen worktrees and survives periodic refresh", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-pinned-scroll-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home"), repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  const trees = Array.from({ length: 8 }, (_, index) => {
    const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: `item-${index}` })
    setWorktreePinned(home, tree.path, true)
    return tree
  })
  const setup = await testRender(() => <App />, { width: 90, height: 14 })
  try {
    await paint(setup)
    const source = findById(setup.renderer.root, `tree-row-${trees[7]!.path}`)!
    expect(source.visible).toBe(true)
    const pane = findById(setup.renderer.root, "pane-trees")!
    const top = pane.y + 2
    await setup.mockMouse.pressDown(source.x + 3, source.y)
    await paint(setup)
    await setup.mockMouse.moveTo(source.x + 3, top)
    await paint(setup)
    await Bun.sleep(350)
    await paint(setup)
    for (let i = 0; i < 10; i++) await setup.mockMouse.scroll(pane.x + 3, top, "up")
    await paint(setup)
    expect(source.visible).toBe(false)
    // The app refreshes every two seconds; keyed rows must retain mouse capture.
    await Bun.sleep(2100)
    await paint(setup)
    expect(findById(setup.renderer.root, "tree-drag-preview")).toBeTruthy()
    const target = findById(setup.renderer.root, `tree-row-${trees[0]!.path}`)!
    expect(target.visible).toBe(true)
    await setup.mockMouse.moveTo(target.x + 3, target.y)
    await paint(setup)
    const line = findById(setup.renderer.root, "tree-drop-indicator")!
    expect(line.y).toBe(target.y - 1)
    await setup.mockMouse.release(line.x + 3, line.y)
    await paint(setup)
    expect(loadConfig(home).projects[0]?.worktreeOrder).toEqual([trees[7]!.path, ...trees.slice(0, 7).map((tree) => tree.path), repo])
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)

test.serial("projects drag before and after rows, cancel safely, and keep their worktrees after restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-project-drag-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  process.env.WORKFOREST_HOME = home
  const projects = ["alpha", "hidden", "beta", "gamma"].map((name) => {
    const repo = join(root, name)
    mkdirSync(repo)
    gitOk(repo, ["init", "-b", "main"])
    gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
    return addProject(home, repo, name === "hidden" ? "other" : `${name}-project`)
  })
  const tree = createWorktree({ repoPath: projects[3]!.path, home, projectId: projects[3]!.id, name: "gamma-feature" })
  writeFileSync(join(tree.path, "draft.txt"), "keep my draft")
  const worktrees = projects.map((project) => listWorktrees(project.path))
  const order = () => loadConfig(home).projects.map((row) => row.id)
  const original = projects.map((row) => row.id)
  let setup = await testRender(() => <App />, { width: 100, height: 18 })
  const row = (index: number) => findById(setup.renderer.root, `project-row-${projects[index]!.id}`)!
  const assertOrder = (indices: number[]) => {
    expect(order()).toEqual(indices.map((index) => projects[index]!.id))
    const frame = setup.captureCharFrame()
    const visible = indices.filter((index) => findById(setup.renderer.root, `project-row-${projects[index]!.id}`)?.visible)
    for (let i = 1; i < visible.length; i++) expect(findText(frame, projects[visible[i - 1]!]!.name).y).toBeLessThan(findText(frame, projects[visible[i]!]!.name).y)
  }
  try {
    await paint(setup)
    const source = row(3), target = row(0)
    await setup.mockMouse.pressDown(source.x + 2, source.y)
    await paint(setup)
    await setup.mockMouse.moveTo(target.x + 2, target.y)
    await paint(setup)
    const before = findById(setup.renderer.root, "project-drop-indicator")!
    const preview = findById(setup.renderer.root, "project-drag-preview")!
    expect(before.y).toBe(target.y - 1)
    expect(before.width).toBe(target.width)
    expect(preview.y).toBe(before.y + 1)
    expect(setup.captureCharFrame()).toContain("projects (4)")
    expect(setup.captureCharFrame()).not.toContain("drop ↑")
    expect(setup.captureCharFrame().split("\n")[before.y]).toContain("─".repeat(20))
    expect((source.getChildren()[0] as TextRenderable).fg.equals(RGBA.fromHex(theme.muted))).toBe(true)
    expect(order()).toEqual(original)
    await setup.mockMouse.release(target.x + 2, target.y)
    await paint(setup)
    assertOrder([3, 0, 1, 2])
    expect(findById(setup.renderer.root, "project-drop-indicator")).toBeUndefined()
    expect(findById(setup.renderer.root, "project-drag-preview")).toBeUndefined()
    expect(loadConfig(home).ui?.selectedProjectId).toBe(projects[3]!.id)
    expect(findById(setup.renderer.root, "pane-projects") instanceof BoxRenderable).toBe(true)
    expect((findById(setup.renderer.root, "pane-projects") as BoxRenderable).borderColor.equals(RGBA.fromHex(theme.borderFocus))).toBe(true)

    // Clicking again still opens the project's worktree pane, but only on release.
    await setup.mockMouse.click(row(3).x + 2, row(3).y)
    await paint(setup)
    expect((findById(setup.renderer.root, "pane-projects") as BoxRenderable).borderColor.equals(RGBA.fromHex(theme.border))).toBe(true)

    // Drag the selected project down without activating its worktree pane.
    await setup.mockMouse.pressDown(row(3).x + 2, row(3).y)
    await setup.mockMouse.moveTo(row(2).x + 2, row(2).y)
    await paint(setup)
    expect(findById(setup.renderer.root, "project-drop-indicator")!.y).toBe(row(2).y + 1)
    await setup.mockMouse.release(row(2).x + 2, row(2).y)
    await paint(setup)
    assertOrder([0, 1, 2, 3])
    expect((findById(setup.renderer.root, "pane-projects") as BoxRenderable).borderColor.equals(RGBA.fromHex(theme.borderFocus))).toBe(true)

    await setup.mockMouse.pressDown(row(3).x + 2, row(3).y)
    await setup.mockMouse.moveTo(row(0).x + 2, row(0).y)
    await paint(setup)
    setup.mockInput.pressEscape()
    await paint(setup)
    await setup.mockMouse.release(row(0).x + 2, row(0).y)
    await paint(setup)
    assertOrder([0, 1, 2, 3])
    await setup.mockMouse.drag(row(3).x + 2, row(3).y, 70, row(0).y)
    await paint(setup)
    assertOrder([0, 1, 2, 3])

    // Filtered moves retain hidden projects and move relative to the target in the full list.
    await setup.mockInput.typeText("/project")
    await paint(setup)
    expect(row(1)).toBeUndefined()
    await setup.mockMouse.drag(row(2).x + 2, row(2).y, row(0).x + 2, row(0).y)
    await paint(setup)
    assertOrder([2, 0, 1, 3])
    setup.mockInput.pressEscape()
    await paint(setup)
    assertOrder([2, 0, 1, 3])
    expect(projects.map((project) => listWorktrees(project.path))).toEqual(worktrees)
    expect(await Bun.file(join(tree.path, "draft.txt")).text()).toBe("keep my draft")
    expect(loadConfig(home).projects.find((project) => project.id === projects[3]!.id)).toMatchObject(projects[3]!)

    setup.renderer.destroy()
    setup = await testRender(() => <App />, { width: 100, height: 18 })
    await paint(setup)
    assertOrder([2, 0, 1, 3])
    expect(loadConfig(home).ui?.selectedProjectId).toBe(projects[2]!.id)
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("project dragging scrolls beyond the viewport without changing selection", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-project-scroll-"))
  const oldHome = process.env.WORKFOREST_HOME
  process.env.WORKFOREST_HOME = home
  const projects = Array.from({ length: 14 }, (_, index) => ({ id: `project-${index}`, name: `project-${index}`, path: join(home, `repo-${index}`), basePort: 5173 }))
  saveConfig(home, { version: 1, projects })
  const setup = await testRender(() => <App />, { width: 90, height: 12 })
  try {
    await paint(setup)
    const source = findById(setup.renderer.root, "project-row-project-0")!
    const bottom = findById(setup.renderer.root, "project-row-project-4")!
    expect(bottom.visible).toBe(true)
    await setup.mockMouse.pressDown(source.x + 2, source.y)
    await setup.mockMouse.moveTo(bottom.x + 2, bottom.y)
    await paint(setup)
    await Bun.sleep(350)
    await paint(setup)
    expect(source.visible).toBe(false)
    // Wheel scrolling while dragging moves the viewport, not the selected project.
    for (let i = 0; i < 14; i++) await setup.mockMouse.scroll(source.x + 2, bottom.y, "down")
    await paint(setup)
    const last = findById(setup.renderer.root, "project-row-project-13")!
    expect(last.visible).toBe(true)
    const indicator = findById(setup.renderer.root, "project-drop-indicator")!
    expect(indicator.y).toBe(last.y + 1)
    expect(indicator.y).toBeLessThan(findById(setup.renderer.root, "pane-projects")!.y + findById(setup.renderer.root, "pane-projects")!.height - 1)
    expect(loadConfig(home).ui?.selectedProjectId).toBe("project-0")
    await setup.mockMouse.release(last.x + 2, last.y)
    await paint(setup)
    expect(loadConfig(home).projects.map((row) => row.id)).toEqual([...projects.slice(1).map((row) => row.id), "project-0"])
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})

test.serial("worktree details follow selection and long rows fit the pane after resizing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-tree-layout-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  createWorktree({ repoPath: repo, home, projectId: project.id, name: `feature-${"long-".repeat(20)}end` })
  createWorktree({ repoPath: repo, home, projectId: project.id, name: "short-feature" })
  const setup = await testRender(() => <App />, { width: 90, height: 18 })
  try {
    await paint(setup)
    const main = findText(setup.captureCharFrame(), "(main)")
    const feature = findText(setup.captureCharFrame(), "feature-long")
    const short = findText(setup.captureCharFrame(), "short-feature")
    expect(main.y).toBeLessThan(feature.y)
    expect(short.y - feature.y).toBe(1)
    await setup.mockMouse.click(feature.x, feature.y)
    await paint(setup)
    for (const width of [90, 60]) {
      setup.renderer.resize(width, 18)
      await paint(setup)
      const frame = setup.captureCharFrame()
      const selected = findText(frame, "feature-")
      const next = findText(frame, "short-feature")
      expect(next.y - selected.y).toBe(2)
      expect(findText(frame, "(main)").y).toBeLessThan(selected.y)
      const lines = frame.split("\n")
      // The long branch and path must leave the pane's right border intact.
      expect(lines[selected.y]![width - 1]).toBe("│")
      expect(lines[selected.y + 1]![width - 1]).toBe("│")
      expect(lines[selected.y + 1]).not.toContain("feature-long")
    }
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("test renderer can paint text", async () => {
  const setup = await testRender(() => (
    <box>
      <text>hello-forest</text>
    </box>
  ), { width: 40, height: 8 })
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("hello-forest")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("box onMouseDown receives a mock click", async () => {
  const [clicked, setClicked] = createSignal(false)
  const setup = await testRender(
    () => (
      <box width={20} height={4} onMouseDown={() => setClicked(true)}>
        <text>CLICKME</text>
      </box>
    ),
    { width: 20, height: 4 },
  )
  try {
    await setup.renderOnce()
    const at = findText(setup.captureCharFrame(), "CLICKME")
    await setup.mockMouse.click(at.x, at.y)
    await setup.flush()
    expect(clicked()).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("ActionButton click fires onPress", async () => {
  const [clicked, setClicked] = createSignal(false)
  const setup = await testRender(
    () => <ActionButton label="servers" onPress={() => setClicked(true)} />,
    { width: 20, height: 5 },
  )
  try {
    await setup.renderOnce()
    const node = findById(setup.renderer.root, "servers")
    const at = node
      ? { x: node.x + Math.floor(node.width / 2), y: node.y + Math.floor(node.height / 2) }
      : findText(setup.captureCharFrame(), "servers")
    await setup.mockMouse.click(at.x, at.y)
    await setup.flush()
    expect(clicked()).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("an open settings dropdown switches and selects on one click", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-settings-click-"))
  const setup = await testRender(() => <App />, { width: 110, height: 36 })
  try {
    await paint(setup)
    const gear = findText(setup.captureCharFrame(), "⚙")
    await setup.mockMouse.click(gear.x, gear.y)
    await paint(setup)
    const model = findById(setup.renderer.root, "settings-model")!
    await setup.mockMouse.click(model.x + 4, model.y + 1)
    await paint(setup)
    expect(findById(setup.renderer.root, "settings-menu-model")).toBeTruthy()
    const provider = findById(setup.renderer.root, "settings-provider")!
    await setup.mockMouse.click(provider.x + 4, provider.y + 1)
    await paint(setup)
    expect(findById(setup.renderer.root, "settings-menu-provider")).toBeTruthy()
    expect(findById(setup.renderer.root, "settings-menu-model")).toBeUndefined()
    const reasoning = findById(setup.renderer.root, "settings-reasoning")!
    await setup.mockMouse.click(reasoning.x + 4, reasoning.y + 1)
    await paint(setup)
    const menu = findById(setup.renderer.root, "settings-menu-reasoning")!
    await setup.mockMouse.click(menu.x + 6, menu.y + 1)
    await paint(setup)
    expect(findById(setup.renderer.root, "settings-menu-reasoning")).toBeUndefined()
    expect(setup.captureCharFrame().split("\n")[reasoning.y + 1]).toContain("Low")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("renders the workforest shell with clickable controls", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Workforest")
    expect(frame).toContain("projects (0)")
    expect(frame).toContain("worktrees (0)")
    expect(frame).not.toContain("servers (0)")
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
    expect(findById(setup.renderer.root, "footer-actions")).toBeUndefined()
    expect(frame).toContain("↻")
    expect(frame).toContain("✕")
    expect(frame).not.toContain("detail")
    expect(frame).not.toContain("kill")
    expect(frame).not.toContain("project(s)")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("selected project survives an app restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-selected-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  process.env.WORKFOREST_HOME = home
  for (const name of ["alpha", "beta"]) {
    const repo = join(root, name)
    mkdirSync(repo)
    gitOk(repo, ["init", "-b", "main"])
    gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
    addProject(home, repo)
  }
  let setup = await testRender(() => <App />, { width: 100, height: 24 })
  try {
    await paint(setup)
    const beta = findText(setup.captureCharFrame(), "beta")
    await setup.mockMouse.click(beta.x, beta.y)
    await paint(setup)
    expect(loadConfig(home).ui?.selectedProjectId).toBe("beta")
    setup.renderer.destroy()
    setup = await testRender(() => <App />, { width: 100, height: 24 })
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("▶ beta")
  } finally {
    setup.renderer.destroy()
    if (oldHome === undefined) delete process.env.WORKFOREST_HOME
    else process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("dragging the pane divider resizes and persists the projects pane", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-resize-"))
  process.env.WORKFOREST_HOME = home
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    const divider = findById(setup.renderer.root, "pane-divider")
    const projects = findById(setup.renderer.root, "pane-projects")
    expect(divider).toBeTruthy()
    expect(projects?.width).toBe(28)
    const dividerRow = setup.captureCharFrame().split("\n")[divider!.y + 3]!
    expect(divider!.width).toBe(1)
    expect(dividerRow[divider!.x]).toBe("│")
    expect(setup.captureCharFrame().split("\n")[divider!.y]![divider!.x]).toBe("┐")
    expect(setup.captureCharFrame().split("\n")[divider!.y + divider!.height - 1]![divider!.x]).toBe("┘")

    setup.mockInput.pressArrow("right")
    await paint(setup)
    expect(setup.captureCharFrame().split("\n")[divider!.y]![divider!.x]).toBe("┌")
    expect(setup.captureCharFrame().split("\n")[divider!.y + divider!.height - 1]![divider!.x]).toBe("└")
    setup.mockInput.pressArrow("left")
    await paint(setup)

    await setup.mockMouse.drag(divider!.x, divider!.y + 3, 40, divider!.y + 3)
    await setup.flush()

    expect(projects?.width).toBe(40)
    expect(loadConfig(home).ui?.projectPaneWidth).toBe(40)

    await setup.mockMouse.doubleClick(40, divider!.y + 3)
    await setup.flush()
    expect(projects?.width).toBe(28)
    expect(loadConfig(home).ui?.projectPaneWidth).toBe(28)
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("arrow keys cycle focused panes", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
    expect(setup.captureCharFrame()).not.toContain("kill")

    setup.mockInput.pressArrow("right")
    await paint(setup)
    let frame = setup.captureCharFrame()
    expect(findById(setup.renderer.root, "btn-new")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
    expect(frame).not.toContain("kill")

    setup.mockInput.pressArrow("right")
    await paint(setup)
    frame = setup.captureCharFrame()
    expect(frame).not.toContain("kill")
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()

    setup.mockInput.pressArrow("left")
    await paint(setup)
    frame = setup.captureCharFrame()
    expect(findById(setup.renderer.root, "btn-new")).toBeTruthy()
    expect(frame).not.toContain("kill")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("vertical arrows navigate lists and only leave from the first item", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const repos = [join(process.env.WORKFOREST_HOME, "alpha"), join(process.env.WORKFOREST_HOME, "beta")]
  for (const repo of repos) {
    mkdirSync(repo)
    gitOk(repo, ["init", "-b", "main"])
    gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
    addProject(process.env.WORKFOREST_HOME, repo)
  }
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()

    setup.mockInput.pressArrow("down")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("▶ beta")

    setup.mockInput.pressArrow("up")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("▶ alpha")

    // Up from the first row reaches the header; down returns to the list.
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("▶ beta")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("pane add buttons remain visible when focus changes", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    const servers = findById(setup.renderer.root, "pane-trees")
    if (!servers) throw new Error("missing pane-trees")
    await setup.mockMouse.click(servers.x + 1, servers.y)
    await paint(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("projects")
    expect(frame).toContain("worktrees")
    expect(frame).not.toContain("servers")
    expect(findById(setup.renderer.root, "btn-start")).toBeUndefined()
    expect(findById(setup.renderer.root, "btn-logs")).toBeUndefined()
    expect(frame).toContain("↻")
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
  } finally {
    setup.renderer.destroy()
  }
})

async function openAddProjectModal(setup: {
  renderer: { root: Renderable }
  mockMouse: { click: (x: number, y: number) => Promise<void> }
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
}) {
  const button = findById(setup.renderer.root, "btn-add")
  if (!button) throw new Error("missing add button")
  await setup.mockMouse.click(button.x + 1, button.y)
  await paint(setup)
  expect(setup.captureCharFrame()).toContain("add project")
}

test.serial("up from an empty pane focuses the header and down returns to the pane", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()

    setup.mockInput.pressArrow("up")
    await paint(setup)
    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("add project")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("modal down from the path field focuses submit", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    await openAddProjectModal(setup)

    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("add project")
    expect(setup.captureCharFrame()).toContain("path required")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("modal right from submit focuses cancel", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    await openAddProjectModal(setup)

    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressArrow("right")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("add project")
  } finally {
    setup.renderer.destroy()
  }
})

test.serial("modal left and right stay in the path field", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    await openAddProjectModal(setup)

    setup.mockInput.pressArrow("left")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("add project")
    expect(setup.captureCharFrame()).toContain("path required")

    setup.mockInput.pressEscape()
    await paint(setup)
    await openAddProjectModal(setup)

    setup.mockInput.pressArrow("right")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("add project")
    expect(setup.captureCharFrame()).toContain("path required")
  } finally {
    setup.renderer.destroy()
  }
})



test.serial("auto-rename defaults to branch only and folder rename is opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-auto-ui-"))
  const oldHome = process.env.WORKFOREST_HOME
  const oldPath = process.env.PATH
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = join(root, "home")
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(process.env.WORKFOREST_HOME, repo)
  const tree = createWorktree({ repoPath: repo, home: process.env.WORKFOREST_HOME, projectId: project.id, name: "old-feature" })
  writeFileSync(join(tree.path, "login.ts"), "login")
  const executable = join(root, "codex")
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2)
await Bun.sleep(500)
await Bun.write(args[args.indexOf('--output-last-message') + 1], JSON.stringify({name: 'agent/fix-login-flow'}))
`)
  chmodSync(executable, 0o755)
  process.env.PATH = `${root}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 160, height: 36 })
  const click = async (id: string) => {
    const button = findById(setup.renderer.root, id)
    expect(button).toBeTruthy()
    await setup.mockMouse.click(button!.x + 2, button!.y + Math.floor(button!.height / 2))
    await paint(setup)
  }
  try {
    await paint(setup)
    const row = findText(setup.captureCharFrame(), "old-feature")
    await setup.mockMouse.click(row.x, row.y)
    await paint(setup)
    expect(findById(setup.renderer.root, "btn-auto-rename")).toBeUndefined()
    await setup.mockInput.typeText("m")
    await paint(setup)
    await click("btn-rename")
    expect(findById(setup.renderer.root, "rename-submenu")).toBeTruthy()
    expect(setup.captureCharFrame()).toContain("Manual")
    expect(setup.captureCharFrame()).toContain("Auto")
    await click("btn-manual-rename")
    expect(findById(setup.renderer.root, "modal-input")).toBeTruthy()
    expect(setup.captureCharFrame()).toContain("old-feature")
    await click("btn-cancel")
    await setup.mockInput.typeText("m")
    await paint(setup)
    await click("btn-rename")
    await click("btn-auto-rename")
    expect(setup.captureCharFrame()).toContain("Generating a name…")
    expect(findById(setup.renderer.root, "btn-submit")).toBeUndefined()
    const progressBefore = setup.captureCharFrame()
    await Bun.sleep(120)
    await paint(setup)
    expect(setup.captureCharFrame()).not.toBe(progressBefore)
    await click("btn-cancel-generation")
    for (let i = 0; i < 60 && findById(setup.renderer.root, "rename-progress"); i++) await paint(setup)
    expect(findById(setup.renderer.root, "rename-progress")).toBeUndefined()
    expect(setup.captureCharFrame()).toContain("auto-rename cancelled")
    expect(listWorktrees(repo)[1]?.branch).toBe("old-feature")
    await setup.mockInput.typeText("m")
    await paint(setup)
    await click("btn-rename")
    await click("btn-auto-rename")
    for (let i = 0; i < 60 && !findById(setup.renderer.root, "modal-input"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("agent/fix-login-flow")
    expect(listWorktrees(repo)[1]?.branch).toBe("old-feature")
    await click("btn-submit")
    const renamed = listWorktrees(repo)[1]!
    expect(renamed.branch).toBe("agent/fix-login-flow")
    expect(renamed.path).toBe(tree.path)
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("○ agent/fix-login-flow"); i++) await paint(setup)
    await setup.mockInput.typeText("m")
    await paint(setup)
    await click("btn-rename")
    await click("btn-manual-rename")
    expect(setup.captureCharFrame()).toContain("[ ] Also rename worktree folder")
    await click("btn-rename-folder")
    expect(setup.captureCharFrame()).toContain("[x] Also rename worktree folder")
    const dialog = findById(setup.renderer.root, "modal-dialog")!
    const checkbox = findById(setup.renderer.root, "btn-rename-folder")!
    expect(checkbox.height).toBe(1)
    for (const id of ["btn-submit", "btn-cancel"]) {
      const button = findById(setup.renderer.root, id)!
      expect(button.y).toBeGreaterThan(checkbox.y)
      expect(button.y + button.height).toBeLessThan(dialog.y + dialog.height - 1)
    }
    await click("btn-submit")
    expect(listWorktrees(repo)[1]!.path).toBe(join(tree.path, "..", "fix-login-flow"))
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("worktree start saves a custom project command, remembers it, shows logs, and stops", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-server-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { local: "bun server.ts" } }))
  writeFileSync(join(repo, "server.ts"), 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("hello") }); console.log("server ready")')
  const project = addProject(home, repo)
  let external: ReturnType<typeof Bun.spawn> | undefined
  let secondServer: ReturnType<typeof Bun.spawn> | undefined
  const occupied = Bun.serve({ port: 0, fetch: () => new Response("occupied") })
  const port = occupied.port!
  rememberPort(home, repo, port)
  const setup = await testRender(() => <App />, { width: 160, height: 36 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node!.x + 2, node!.y + Math.floor(node!.height / 2))
    await paint(setup)
  }
  try {
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("○")
    expect(setup.captureCharFrame().split("\n").slice(0, 3).join("\n")).toContain("▶")
    const refreshButton = findById(setup.renderer.root, "btn-refresh")!
    expect(findById(setup.renderer.root, "btn-start")!.y).toBe(refreshButton.y)
    expect(findById(setup.renderer.root, "btn-logs")!.y).toBe(refreshButton.y)
    expect(findById(setup.renderer.root, "footer-actions")).toBeUndefined()
    expect(findById(setup.renderer.root, "pane-servers")).toBeUndefined()
    setup.mockInput.pressArrow("right")
    await paint(setup)
    await click("btn-start")
    expect(setup.captureCharFrame()).toContain("start command")
    await click("btn-submit")
    expect(setup.captureCharFrame()).toContain("command required")
    await click("modal-input")
    await setup.mockInput.typeText("bun local")
    await paint(setup)
    await click("btn-submit")
    expect(loadConfig(home).projects[0]?.startCommand).toBe("bun local")
    expect(setup.captureCharFrame()).toContain("start server")
    expect(setup.captureCharFrame()).toContain(String(port))
    await click("btn-submit")
    expect(setup.captureCharFrame()).toContain("already in use")
    expect(findById(setup.renderer.root, "modal-input")).toBeTruthy()
    occupied.stop(true)
    await click("btn-submit")
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("Running")) break
    }
    expect(setup.captureCharFrame()).toContain(`Running · :${port}`)
    expect(setup.captureCharFrame()).toContain("Pinned (1)")
    expect(setup.captureCharFrame()).toContain("Running (0)")
    expect(setup.captureCharFrame()).toContain("Not running (0)")
    expect(setup.captureCharFrame().split("\n").slice(0, 3).join("\n")).toContain("■")
    expect(setup.captureCharFrame()).not.toContain("2 servers")
    setup.mockInput.pressArrow("down")
    await paint(setup)
    await click("btn-logs")
    expect(setup.captureCharFrame()).toContain("server ready")
    await click("btn-close-logs")
    const spare = Bun.serve({ port: 0, fetch: () => new Response("spare") })
    const secondPort = spare.port!
    spare.stop(true)
    secondServer = Bun.spawn([process.execPath, "server.ts"], {
      cwd: repo, env: { ...process.env, PORT: String(secondPort) }, stdout: "ignore", stderr: "ignore",
    })
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("2 servers")) break
    }
    expect(setup.captureCharFrame()).toContain("2 servers")
    await click("btn-logs")
    expect(setup.captureCharFrame()).toContain("Servers")
    expect(setup.captureCharFrame()).toContain("server ready")
    const externalIndex = secondPort < port ? 0 : 1
    await click(`log-server-${externalIndex}`)
    expect(setup.captureCharFrame()).toContain("Logs aren't available for servers started outside Workforest.")
    setup.mockInput.pressTab()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("server ready")
    await click(`log-server-${externalIndex}`)
    setup.renderer.resize(80, 36)
    await paint(setup)
    expect(findById(setup.renderer.root, "btn-next-log")).toBeTruthy()
    expect(findById(setup.renderer.root, "log-server-0")).toBeUndefined()
    await click("btn-next-log")
    expect(setup.captureCharFrame()).toContain("server ready")
    await click("btn-close-logs")
    await click("btn-start")
    expect(setup.captureCharFrame()).toContain("Select the servers to stop.")
    expect(setup.captureCharFrame()).toContain("stop selected (1)")
    expect(setup.captureCharFrame()).toContain("stop all")
    expect(secondServer.exitCode).toBeNull()
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("stop selected (2)")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("stop selected (1)")
    await click("stop-server-0")
    expect(setup.captureCharFrame()).toContain("stop selected (0)")
    await click(`stop-server-${externalIndex}`)
    expect(setup.captureCharFrame()).toContain("stop selected (1)")
    await click("btn-stop-selected")
    expect(findById(setup.renderer.root, "modal-dialog")).toBeUndefined()
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(50)
      await paint(setup)
      if (setup.captureCharFrame().includes("stopped 1 server(s)")) break
    }
    expect(setup.captureCharFrame()).toContain("stopped 1 server(s)")
    expect(setup.captureCharFrame()).not.toContain("2 servers")
    expect(setup.captureCharFrame()).toContain(`Running · :${port}`)
    await secondServer.exited
    secondServer = undefined
    setup.renderer.resize(160, 36)
    await paint(setup)
    secondServer = Bun.spawn([process.execPath, "server.ts"], {
      cwd: repo, env: { ...process.env, PORT: String(secondPort) }, stdout: "ignore", stderr: "ignore",
    })
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("2 servers")) break
    }
    expect(setup.captureCharFrame()).toContain("2 servers")
    await click("btn-start")
    setup.mockInput.pressTab()
    setup.mockInput.pressTab()
    setup.mockInput.pressEnter()
    await paint(setup)
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(50)
      await paint(setup)
      if (setup.captureCharFrame().includes("stopped 2 server(s)")) break
    }
    expect(setup.captureCharFrame()).toContain("stopped 2 server(s)")
    expect(setup.captureCharFrame()).toContain("○")
    expect(loadRunRecords(home)).toEqual([])
    await secondServer.exited
    secondServer = undefined
    writeFileSync(join(repo, "server.ts"), 'console.error("startup failed example"); process.exit(1)')
    await click("btn-start")
    await click("btn-submit")
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("Failed · view logs")) break
    }
    expect(setup.captureCharFrame()).toContain("Failed · view logs")
    await click("btn-logs")
    expect(setup.captureCharFrame()).toContain("startup failed example")
    await click("btn-close-logs")
    writeFileSync(join(repo, "server.ts"), 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("external") })')
    external = Bun.spawn([process.execPath, "server.ts"], {
      cwd: repo, env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore",
    })
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("external")) break
    }
    expect(setup.captureCharFrame()).toContain(`Running · :${port} · external`)
    await click("btn-start")
    // PID length changes where the caption wraps between terminal rows.
    const stopFrame = setup.captureCharFrame().replaceAll("│", " ").replace(/\s+/g, " ")
    expect(stopFrame).toContain("External processes were started")
    expect(stopFrame).toContain("outside Workforest.")
    await click("btn-cancel")
    expect(external.exitCode).toBeNull()
    await click("btn-start")
    await click("btn-submit")
    await external.exited

  } finally {
    setup.renderer.destroy()
    if (secondServer) {
      secondServer.kill()
      await secondServer.exited
    }
    occupied.stop(true)
    external?.kill()
    for (const row of collectServers({ home, projects: [project], treesByProject: new Map([[project.id, listWorktrees(repo)]]) })) {
      await stopServer(home, row)
    }
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test.serial("row menus target the clicked item, protect main, and support mouse and keyboard", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-menu-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  process.env.WORKFOREST_HOME = home
  const repos = [join(root, "alpha"), join(root, "beta")]
  for (const repo of repos) {
    mkdirSync(repo)
    gitOk(repo, ["init", "-b", "main"])
    gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
    addProject(home, repo)
  }
  const project = loadConfig(home).projects[1]!
  const tree = createWorktree({ repoPath: repos[1]!, home, projectId: project.id, name: "feature-menu" })
  const setup = await testRender(() => <App />, { width: 90, height: 18 })
  let copiedPath = ""
  setup.renderer.copyToClipboardOSC52 = (value: string) => {
    copiedPath = value
    return true
  }
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const rightClick = async (label: string) => {
    const at = findText(setup.captureCharFrame(), label)
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
  }
  try {
    await paint(setup)
    await rightClick("beta")
    expect(setup.captureCharFrame()).toContain("Edit start command")
    expect(setup.captureCharFrame()).toContain("Remove from list")
    await click("btn-command")
    await setup.mockInput.typeText("bun dev")
    await click("btn-submit")
    expect(loadConfig(home).projects[1]?.startCommand).toBe("bun dev")
    expect(loadConfig(home).projects[0]?.startCommand).toBeUndefined()

    await rightClick("feature-menu")
    expect(findById(setup.renderer.root, "context-menu")).toBeTruthy()
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    setup.mockInput.pressEscape()
    await paint(setup)
    // Right-clicking the already selected worktree must not start its server.
    await rightClick("feature-menu")
    expect(loadRunRecords(home)).toEqual([])
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    await setup.mockMouse.click(0, 0)
    await paint(setup)
    expect(findById(setup.renderer.root, "context-menu")).toBeUndefined()

    const feature = findText(setup.captureCharFrame(), "feature-menu")
    await setup.mockMouse.click(feature.x, feature.y)
    await setup.mockMouse.click(feature.x, feature.y)
    await paint(setup)
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    expect(loadRunRecords(home)).toEqual([])

    await rightClick("feature-menu")
    await click("btn-copy-path")
    expect(copiedPath).toBe(tree.path)
    expect(setup.captureCharFrame()).toContain("copied")

    await rightClick("(main)")
    await click("btn-delete")
    expect(findById(setup.renderer.root, "context-menu")).toBeTruthy()
    await click("btn-rename")
    expect(findById(setup.renderer.root, "btn-manual-rename")).toBeUndefined()
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(findById(setup.renderer.root, "context-menu")).toBeTruthy()
    setup.mockInput.pressEscape()
    await paint(setup)

    await rightClick("feature-menu")
    await click("btn-create-tree")
    expect(setup.captureCharFrame()).toContain("new worktree")
    expect(setup.captureCharFrame()).toContain("feature-menu")
    await click("btn-cancel")

    await rightClick("feature-menu")
    const menu = findById(setup.renderer.root, "context-menu")!
    expect(menu.x + menu.width).toBeLessThanOrEqual(90)
    expect(menu.y + menu.height).toBeLessThanOrEqual(18)
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("Delete feature-menu?")
    await click("btn-cancel")
    expect(listWorktrees(repos[1]!)).toHaveLength(2)
    await rightClick("feature-menu")
    await click("btn-delete")
    await click("btn-submit")
    expect(listWorktrees(repos[1]!)).toHaveLength(1)

    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("deleted feature-menu"); i++) await paint(setup)

    await rightClick("beta")
    await click("btn-unregister")
    expect(setup.captureCharFrame()).toContain("Remove beta from the list?")
    await click("btn-submit")
    expect(loadConfig(home).projects.map((row) => row.name)).toEqual(["alpha"])
    expect(listWorktrees(repos[1]!)).toHaveLength(1)
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("worktree menu pull fast-forwards that checkout and reports a missing upstream", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-pull-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const origin = join(root, "origin")
  const repo = join(root, "repo")
  mkdirSync(origin)
  process.env.WORKFOREST_HOME = home
  gitOk(origin, ["init", "-b", "main"])
  gitOk(origin, ["config", "user.email", "wf@test"])
  gitOk(origin, ["config", "user.name", "wf"])
  gitOk(origin, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(origin, "README.md"), "hi\n")
  gitOk(origin, ["add", "."])
  gitOk(origin, ["commit", "-m", "init"])
  gitOk(root, ["clone", origin, repo])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-pull" })
  writeFileSync(join(origin, "remote.txt"), "from origin\n")
  gitOk(origin, ["add", "."])
  gitOk(origin, ["commit", "-m", "remote"])
  const setup = await testRender(() => <App />, { width: 110, height: 24 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const rightClick = async (label: string) => {
    const at = findText(setup.captureCharFrame(), label)
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
  }
  try {
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("(main)"); i++) await paint(setup)
    await rightClick("(main)")
    expect(setup.captureCharFrame()).toContain("Git")
    const git = findById(setup.renderer.root, "btn-git")!
    expect(git.y).toBeGreaterThan(findById(setup.renderer.root, "btn-rename")!.y)
    expect(git.y).toBeLessThan(findById(setup.renderer.root, "btn-copy-path")!.y)
    await click("btn-git")
    await click("btn-pull")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("pulled main"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("pulled main")
    expect(existsSync(join(repo, "remote.txt"))).toBe(true)
    expect(existsSync(join(tree.path, "remote.txt"))).toBe(false)

    await rightClick("(main)")
    await click("btn-git")
    await click("btn-pull")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("main is up to date"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("main is up to date")

    await rightClick("feature-pull")
    await click("btn-git")
    await click("btn-pull")
    for (let i = 0; i < 40 && !setup.captureCharFrame().toLowerCase().includes("no tracking information"); i++) await paint(setup)
    expect(setup.captureCharFrame().toLowerCase()).toContain("no tracking information")
    expect(existsSync(join(tree.path, "remote.txt"))).toBe(false)
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("pull shows a spinner beside the worktree that is pulling", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-pull-spin-")))
  const oldHome = process.env.WORKFOREST_HOME
  const oldPath = process.env.PATH
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["config", "commit.gpgsign", "false"])
  gitOk(repo, ["commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-pull" })
  const realGit = Bun.which("git")!
  const bin = join(root, "bin")
  const shim = join(bin, "git")
  mkdirSync(bin)
  writeFileSync(shim, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === "pull") await Bun.sleep(800)
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" })
process.exit(child.exitCode ?? 1)
`)
  chmodSync(shim, 0o755)
  process.env.PATH = `${bin}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 110, height: 24 })
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const nameLine = () => setup.captureCharFrame().split("\n").find((line) => line.includes("○ feature-pull")) ?? ""
  const spinnerOn = (line: string) => spinnerFrames.find((frame) => line.includes(frame))
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  try {
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("feature-pull"); i++) await paint(setup)
    const row = findText(setup.captureCharFrame(), "feature-pull")
    await setup.mockMouse.click(row.x, row.y, 2)
    await paint(setup)
    await click("btn-git")
    await click("btn-pull")
    expect(nameLine()).toMatch(/feature-pull [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] pulling/)
    const mainLine = setup.captureCharFrame().split("\n").find((line) => line.includes("(main)")) ?? ""
    expect(spinnerOn(mainLine)).toBeUndefined()
    expect(mainLine).not.toContain("pulling")
    const first = spinnerOn(nameLine())
    let next = first
    for (let i = 0; i < 8 && next === first; i++) {
      await Bun.sleep(80)
      await paint(setup)
      next = spinnerOn(nameLine())
    }
    expect(next).toBeTruthy()
    expect(next).not.toBe(first)
    for (let i = 0; i < 50 && spinnerOn(nameLine()); i++) {
      await Bun.sleep(50)
      await paint(setup)
    }
    expect(spinnerOn(nameLine())).toBeUndefined()
    expect(nameLine()).not.toContain("pulling")
    expect(setup.captureCharFrame().toLowerCase()).toContain("no tracking information")
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("merge shows a spinner beside the PR number until it finishes or fails", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-merge-spin-")))
  const oldHome = process.env.WORKFOREST_HOME
  const oldPath = process.env.PATH
  const home = join(root, "home")
  const repo = join(root, "repo")
  const bin = join(root, "bin")
  const stateFile = join(root, "pr-state.txt")
  const modeFile = join(root, "merge-mode.txt")
  const mergedFile = join(root, "merged.json")
  mkdirSync(repo)
  mkdirSync(bin)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "merge-feature" })
  const pr = { number: 450, url: "https://github.com/test/demo/pull/450", base: "main", state: "OPEN" }
  gitOk(repo, ["config", "--local", "branch.merge-feature.workforest-pr", JSON.stringify(pr)])
  writeFileSync(stateFile, "OPEN")
  writeFileSync(modeFile, "fail")
  const gh = join(bin, "gh")
  writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[1] === "view") console.log(JSON.stringify({ url: args[2], state: (await Bun.file(${JSON.stringify(stateFile)}).text()).trim() }))
else if (args[1] === "merge") {
  await Bun.sleep(800)
  if ((await Bun.file(${JSON.stringify(modeFile)}).text()).trim() === "fail") {
    console.error("merge failed: conflict")
    process.exit(1)
  }
  await Bun.write(${JSON.stringify(stateFile)}, "MERGED")
  await Bun.write(${JSON.stringify(mergedFile)}, JSON.stringify(args))
} else process.exit(0)
`)
  chmodSync(gh, 0o755)
  process.env.PATH = `${bin}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 100, height: 24 })
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const nameLine = () => setup.captureCharFrame().split("\n").find((line) => line.includes("○ merge-feature")) ?? ""
  const mainLine = () => setup.captureCharFrame().split("\n").find((line) => line.includes("(main)")) ?? ""
  const spinnerOn = (line: string) => spinnerFrames.find((frame) => line.includes(frame))
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const openMerge = async () => {
    const link = findById(setup.renderer.root, "pr-link-450")!
    await setup.mockMouse.click(link.x + 2, link.y, 2)
    await paint(setup)
    await click("btn-merge-pr")
  }
  try {
    for (let i = 0; i < 40 && !findById(setup.renderer.root, "pr-link-450"); i++) await paint(setup)
    expect(findById(setup.renderer.root, "pr-link-450")).toBeTruthy()
    await openMerge()
    expect(nameLine()).toMatch(/merge-feature #450 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging/)
    expect(spinnerOn(mainLine())).toBeUndefined()
    expect(mainLine()).not.toContain("merging")
    expect(setup.captureCharFrame()).toContain("merging PR #450")
    const row = findById(setup.renderer.root, `tree-row-${tree.path}`) as BoxRenderable
    const spinner = findById(setup.renderer.root, "merge-spinner") as TextRenderable
    const badge = findById(setup.renderer.root, "pr-link-450") as BoxRenderable
    expect(spinner.y).toBe(row.y)
    expect(spinner.height).toBe(1)
    expect(spinner.x).toBeGreaterThanOrEqual(row.x)
    expect(spinner.plainText).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging$/)
    expect(badge.x + badge.width).toBe(spinner.x)
    expect(spinner.x + spinner.width).toBeLessThanOrEqual(row.x + row.width)
    expect(badge.y).toBe(row.y)
    expect(badge.x + badge.width).toBeLessThanOrEqual(row.x + row.width)
    const badgeLabel = badge.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)!
    expect(spinner.fg.equals(badgeLabel.fg)).toBe(true)
    const first = spinnerOn(nameLine())
    let next = first
    for (let i = 0; i < 8 && next === first; i++) {
      await Bun.sleep(80)
      await paint(setup)
      next = spinnerOn(nameLine())
    }
    expect(next).toBeTruthy()
    expect(next).not.toBe(first)
    for (let i = 0; i < 50 && !setup.captureCharFrame().includes("merge failed: conflict"); i++) {
      await Bun.sleep(50)
      await paint(setup)
    }
    expect(setup.captureCharFrame()).toContain("merge failed: conflict")
    expect(spinnerOn(nameLine())).toBeUndefined()
    expect(nameLine()).not.toContain("merging")
    expect(findById(setup.renderer.root, "merge-spinner")).toBeUndefined()

    writeFileSync(modeFile, "ok")
    await openMerge()
    expect(nameLine()).toMatch(/merge-feature #450 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging/)
    for (let i = 0; i < 50 && !setup.captureCharFrame().includes("merged PR #450"); i++) {
      await Bun.sleep(50)
      await paint(setup)
    }
    expect(setup.captureCharFrame()).toContain("merged PR #450")
    expect(spinnerOn(nameLine())).toBeUndefined()
    expect(nameLine()).not.toContain("merging")
    expect(findById(setup.renderer.root, "merge-spinner")).toBeUndefined()
    expect(JSON.parse(await Bun.file(mergedFile).text())).toEqual(["pr", "merge", pr.url, "--merge"])
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

test.serial("merge spinner stays beside the PR badge when the worktree pane is narrow", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-merge-narrow-")))
  const oldHome = process.env.WORKFOREST_HOME
  const oldPath = process.env.PATH
  const home = join(root, "home"), repo = join(root, "repo"), bin = join(root, "bin")
  const stateFile = join(root, "pr-state.txt"), hold = join(root, "hold")
  mkdirSync(repo)
  mkdirSync(bin)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "merge-feature" })
  gitOk(repo, ["config", "--local", "branch.merge-feature.workforest-pr", JSON.stringify({ number: 450, url: "https://github.com/test/demo/pull/450", base: "main", state: "OPEN" })])
  writeFileSync(stateFile, "OPEN")
  writeFileSync(hold, "")
  const gh = join(bin, "gh")
  writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[1] === "view") console.log(JSON.stringify({ url: args[2], state: (await Bun.file(${JSON.stringify(stateFile)}).text()).trim() }))
else if (args[1] === "merge") { while (await Bun.file(${JSON.stringify(hold)}).exists()) await Bun.sleep(30) }
else process.exit(0)
`)
  chmodSync(gh, 0o755)
  process.env.PATH = `${bin}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 58, height: 20 })
  try {
    for (let i = 0; i < 40 && !findById(setup.renderer.root, "pr-link-450"); i++) await paint(setup)
    const link = findById(setup.renderer.root, "pr-link-450")!
    await setup.mockMouse.click(link.x + 2, link.y, 2)
    await paint(setup)
    const merge = findById(setup.renderer.root, "btn-merge-pr")!
    await setup.mockMouse.click(merge.x + 1, merge.y)
    await paint(setup)
    const line = setup.captureCharFrame().split("\n").find((row) => /#450 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging/.test(row)) ?? ""
    expect(line).toMatch(/\.\.\..* #450 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging/)
    const row = findById(setup.renderer.root, `tree-row-${tree.path}`) as BoxRenderable
    const spinner = findById(setup.renderer.root, "merge-spinner") as TextRenderable
    const badge = findById(setup.renderer.root, "pr-link-450") as BoxRenderable
    expect(spinner.plainText).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] merging$/)
    expect(badge.x + badge.width).toBe(spinner.x)
    expect(spinner.x + spinner.width).toBeLessThanOrEqual(row.x + row.width)
    expect(badge.y).toBe(row.y)
    expect(badge.x + badge.width).toBeLessThanOrEqual(row.x + row.width)
    expect(line.indexOf("merging")).toBeGreaterThan(line.indexOf("#450"))
  } finally {
    rmSync(hold, { force: true })
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("worktree menu runs an idle worktree and stops one that is already running", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-menu-run-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = setProjectStartCommand(home, addProject(home, repo).id, "bun server.ts")
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-run" })
  writeFileSync(join(tree.path, "server.ts"), 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("hello") })')
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") })
  const port = probe.port!
  probe.stop(true)
  const record = startServer({ home, project, worktree: tree, usedPorts: [], port })
  const setup = await testRender(() => <App />, { width: 110, height: 24 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const rightClick = async (label: string) => {
    const at = findText(setup.captureCharFrame(), label)
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
  }
  try {
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes(`:${port}`); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain(`:${port}`)
    await rightClick("feature-run")
    expect(findById(setup.renderer.root, "btn-menu-stop")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-menu-run")).toBeUndefined()
    expect(setup.captureCharFrame()).toContain("Stop")
    await click("btn-pin")
    expect(setup.captureCharFrame()).toContain("Pinned (2)")
    expect(setup.captureCharFrame()).toContain("Running (0)")
    await rightClick("feature-run")
    await click("btn-unpin")
    expect(setup.captureCharFrame()).toContain("Pinned (1)")
    expect(setup.captureCharFrame()).toContain("Running (1)")
    setup.mockInput.pressEscape()
    await paint(setup)

    await rightClick("(main)")
    expect(findById(setup.renderer.root, "btn-menu-run")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-menu-stop")).toBeUndefined()
    const run = findById(setup.renderer.root, "btn-menu-run")!
    expect(run.y).toBeGreaterThan(findById(setup.renderer.root, "btn-rename")!.y)
    expect(run.y).toBeLessThan(findById(setup.renderer.root, "btn-git")!.y)
    await click("btn-menu-run")
    expect(findById(setup.renderer.root, "context-menu")).toBeUndefined()
    expect(setup.captureCharFrame()).toContain("start server")
    await click("btn-cancel")

    await rightClick("feature-run")
    await click("btn-menu-stop")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("stopped 1 server"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("stopped 1 server(s)")
    expect(setup.captureCharFrame()).not.toContain(`:${port}`)
  } finally {
    try { process.kill(record.pid) } catch { /* already stopped */ }
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("worktree deletion renders its busy state while git is still running", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-delete-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const oldPath = process.env.PATH
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "slow-delete" })
  const realGit = Bun.which("git")!
  const bin = join(root, "bin")
  const shim = join(bin, "git")
  mkdirSync(bin)
  writeFileSync(shim, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === "worktree" && args[1] === "remove") await Bun.sleep(350)
const child = Bun.spawnSync([${JSON.stringify(realGit)}, ...args], { cwd: process.cwd(), stdout: "inherit", stderr: "inherit" })
process.exit(child.exitCode)
`)
  chmodSync(shim, 0o755)
  process.env.PATH = `${bin}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 120, height: 28 })
  try {
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("slow-delete"); i++) await paint(setup)
    const row = findText(setup.captureCharFrame(), "slow-delete")
    await setup.mockMouse.click(row.x, row.y, 2)
    await paint(setup)
    const deleteButton = findById(setup.renderer.root, "btn-delete")!
    await setup.mockMouse.click(deleteButton.x + 1, deleteButton.y + Math.floor(deleteButton.height / 2))
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("confirm or cancel")
    const submit = findById(setup.renderer.root, "btn-submit")!
    const modal = submit.parent?.parent
    expect(modal).toBeTruthy()
    expect(submit.y + submit.height).toBeLessThanOrEqual(modal!.y + modal!.height - 2)
    await setup.mockMouse.click(submit.x + 1, submit.y + 1)
    await paint(setup)

    expect(setup.captureCharFrame()).toContain("deleting")
    expect(listWorktrees(repo).some((row) => row.path === tree.path)).toBe(true)

    for (let i = 0; i < 30 && listWorktrees(repo).some((row) => row.path === tree.path); i++) await paint(setup)
    expect(listWorktrees(repo).some((row) => row.path === tree.path)).toBe(false)
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("input modal keeps its action buttons inside the bottom padding", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-modal-layout-")))
  const oldHome = process.env.WORKFOREST_HOME
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  addProject(home, repo)
  const setup = await testRender(() => <App />, { width: 130, height: 44 })
  try {
    await paint(setup)
    const button = findById(setup.renderer.root, "btn-new")!
    await setup.mockMouse.click(button.x + 1, button.y)
    await paint(setup)
    const submit = findById(setup.renderer.root, "btn-submit")!
    const modal = submit.parent?.parent
    expect(modal).toBeTruthy()
    expect(submit.y + submit.height).toBeLessThanOrEqual(modal!.y + modal!.height - 2)
    const submitY = submit.y
    const source = findById(setup.renderer.root, "source-branch")!
    await setup.mockMouse.click(source.x + 1, source.y + 1)
    await paint(setup)
    const menu = findById(setup.renderer.root, "source-branch-menu")!
    const field = findById(setup.renderer.root, "source-branch")!
    expect(menu).toBeTruthy()
    expect(menu.y).toBeGreaterThanOrEqual(field.y + field.height)
    expect(menu.x).toBe(field.x)
    expect(menu.width).toBe(field.width)
    expect(findById(setup.renderer.root, "btn-submit")!.y).toBe(submitY)
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("selected row menu follows scrolling and stays inside a resized terminal", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-scroll-menu-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  for (let i = 0; i < 8; i++) createWorktree({ repoPath: repo, home, projectId: project.id, name: `item-${i}` })
  const setup = await testRender(() => <App />, { width: 90, height: 18 })
  try {
    await paint(setup)
    setup.mockInput.pressArrow("right")
    for (let i = 0; i < 8; i++) {
      await setup.mockMouse.scroll(35, 6, "down")
      await paint(setup)
    }
    setup.renderer.resize(80, 14)
    await paint(setup)
    await setup.mockInput.typeText("m")
    await paint(setup)
    const menu = findById(setup.renderer.root, "context-menu")!
    expect(menu.x + menu.width).toBeLessThanOrEqual(80)
    expect(menu.y + menu.height).toBeLessThanOrEqual(14)
    expect(setup.captureCharFrame()).toContain("Rename")
    expect(setup.captureCharFrame()).toContain("Delete")
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("worktree groups sort names and collapse with mouse and keyboard", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-groups-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  for (const name of ["zebra", "Alpha", "beta"]) createWorktree({ repoPath: repo, home, projectId: project.id, name })
  const setup = await testRender(() => <App />, { width: 100, height: 24 })
  try {
    await paint(setup)
    const frame = setup.captureCharFrame()
    expect(findText(frame, "Pinned (1)").y).toBeLessThan(findText(frame, "Running (0)").y)
    expect(findText(frame, "Running (0)").y).toBeLessThan(findText(frame, "Not running (3)").y)
    expect(findText(frame, "Alpha").y).toBeLessThan(findText(frame, "beta").y)
    expect(findText(frame, "beta").y).toBeLessThan(findText(frame, "zebra").y)
    const header = findById(setup.renderer.root, "tree-group-stopped")!
    await setup.mockMouse.click(header.x + 1, header.y)
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("zebra")
    expect(setup.captureCharFrame()).toContain("▸ Not running (3)")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("zebra")
    setup.mockInput.pressArrow("down")
    await paint(setup)
    await setup.mockInput.typeText("m")
    await paint(setup)
    expect(findById(setup.renderer.root, "btn-copy-path")).toBeTruthy()
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("pinning moves worktrees into a collapsible group and persists across restarts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-pinned-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  const project = addProject(home, repo)
  const alpha = createWorktree({ repoPath: repo, home, projectId: project.id, name: "Alpha" })
  createWorktree({ repoPath: repo, home, projectId: project.id, name: "beta" })
  const setup = await testRender(() => <App />, { width: 100, height: 24 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y)
    await paint(setup)
  }
  const rightClick = async (name: string) => {
    const at = findText(setup.captureCharFrame(), name)
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
  }
  try {
    try {
      await paint(setup)
      expect(setup.captureCharFrame()).toContain("Pinned (1)")
      await rightClick("(main)")
      expect(findById(setup.renderer.root, "btn-unpin")).toBeTruthy()
      await click("btn-unpin")
      expect(findById(setup.renderer.root, "tree-group-pinned")).toBeUndefined()
      expect(loadConfig(home).ui?.unpinnedMainWorktreePaths).toEqual([repo])
      await rightClick("Alpha")
      expect(findById(setup.renderer.root, "btn-pin")!.y).toBeLessThan(findById(setup.renderer.root, "btn-menu-run")!.y)
      await click("btn-pin")
      let frame = setup.captureCharFrame()
      expect(frame).toContain("Pinned (1)")
      expect(frame).toContain("Not running (2)")
      expect(findText(frame, "Pinned (1)").y).toBeLessThan(findText(frame, "Running (0)").y)
      expect(loadConfig(home).ui?.pinnedWorktreePaths).toEqual([alpha.path])

      await rightClick("beta")
      await click("btn-pin")
      frame = setup.captureCharFrame()
      expect(frame).toContain("Pinned (2)")
      expect(findText(frame, "Alpha").y).toBeLessThan(findText(frame, "beta").y)
      expect(frame.split("\n").filter((line) => line.includes("○ Alpha"))).toHaveLength(1)
      expect(frame.split("\n").filter((line) => line.includes("○ beta"))).toHaveLength(1)

      await click("tree-group-pinned")
      expect(setup.captureCharFrame()).toContain("▸ Pinned (2)")
      expect(setup.captureCharFrame()).not.toContain("○ Alpha")
      expect(setup.captureCharFrame()).not.toContain("○ beta")
      await click("tree-group-pinned")
      await rightClick("Alpha")
      expect(findById(setup.renderer.root, "btn-unpin")).toBeTruthy()
      await click("btn-unpin")
      frame = setup.captureCharFrame()
      expect(frame).toContain("Pinned (1)")
      expect(frame).toContain("Not running (2)")
      expect(frame.split("\n").filter((line) => line.includes("○ Alpha"))).toHaveLength(1)

      await rightClick("beta")
      await click("btn-unpin")
      expect(findById(setup.renderer.root, "tree-group-pinned")).toBeUndefined()
      await rightClick("Alpha")
      await click("btn-pin")
    } finally {
      setup.renderer.destroy()
    }
    const reopened = await testRender(() => <App />, { width: 100, height: 24 })
    try {
      await paint(reopened)
      expect(reopened.captureCharFrame()).toContain("Pinned (1)")
      expect(reopened.captureCharFrame()).toContain("Not running (2)")
    } finally { reopened.renderer.destroy() }
  } finally {
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("bottom search filters projects and worktrees without firing shortcuts", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-search-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  process.env.WORKFOREST_HOME = home
  for (const name of ["alpha-project", "query-project"]) {
    const repo = join(root, name)
    mkdirSync(repo)
    gitOk(repo, ["init", "-b", "main"])
    gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
    const project = addProject(home, repo)
    createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-search" })
    const renamed = createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-old-name" })
    gitOk(renamed.path, ["branch", "-m", "agent/renamed"])
  }
  const setup = await testRender(() => <App />, { width: 100, height: 24 })
  try {
    await paint(setup)
    await setup.mockInput.typeText("/")
    await paint(setup)
    expect(findById(setup.renderer.root, "search-input")?.y).toBeGreaterThan(18)
    await setup.mockInput.typeText("wf-search-ui-")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("no matching projects")
    setup.mockInput.pressEscape()
    await paint(setup)
    await setup.mockInput.typeText("/")
    await paint(setup)
    await setup.mockInput.typeText("QUERY")
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("alpha-project")
    expect(setup.captureCharFrame()).toContain("query-project")
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    setup.mockInput.pressEnter()
    await paint(setup)
    setup.mockInput.pressArrow("right")
    await paint(setup)
    const search = findById(setup.renderer.root, "btn-search")!
    await setup.mockMouse.click(search.x + 1, search.y)
    await paint(setup)
    await setup.mockInput.typeText("FEATURE")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("feature-search")
    expect(setup.captureCharFrame()).not.toContain("(main)")
    expect(setup.captureCharFrame()).not.toContain("agent/renamed")
    expect(setup.captureCharFrame()).toContain("worktrees (1)")
    setup.mockInput.pressEnter()
    await paint(setup)
    await setup.mockInput.typeText("r")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("rename worktree")
    expect(setup.captureCharFrame()).toContain("feature-search")
    setup.mockInput.pressEscape()
    await paint(setup)
    await setup.mockInput.typeText("/")
    await paint(setup)
    await setup.mockInput.typeText("no-match")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("no matching worktrees")
    setup.mockInput.pressEscape()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("(main)")
    expect(findById(setup.renderer.root, "search-input")).toBeUndefined()
    setup.mockInput.pressArrow("left")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("QUERY")
    setup.mockInput.pressEscape()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("alpha-project")
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("add project completes with keyboard and mouse, then validates the chosen path", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-complete-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  process.env.WORKFOREST_HOME = join(root, "home")
  mkdirSync(join(root, "workforest"))
  mkdirSync(join(root, "workshop"))
  gitOk(join(root, "workforest"), ["init", "-b", "main"])
  const setup = await testRender(() => <App />, { width: 100, height: 28 })
  const waitForPaths = async () => { await Bun.sleep(100); await paint(setup) }
  try {
    await paint(setup)
    await openAddProjectModal(setup)
    await setup.mockInput.typeText(`${root}/wor`)
    await waitForPaths()
    expect(setup.captureCharFrame()).toContain("workforest/")
    expect(setup.captureCharFrame()).toContain("workshop/")
    for (const height of [28, 18]) {
      setup.renderer.resize(100, height)
      await paint(setup)
      const dialog = findById(setup.renderer.root, "modal-dialog")!
      const submit = findById(setup.renderer.root, "btn-submit")!
      expect(submit.y + submit.height).toBeLessThan(dialog.y + dialog.height - 1)
    }
    setup.renderer.resize(100, 28)
    await paint(setup)
    setup.mockInput.pressArrow("down")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("▶ workforest/")
    setup.mockInput.pressEnter()
    await waitForPaths()
    expect(loadConfig(process.env.WORKFOREST_HOME).projects).toHaveLength(0)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(loadConfig(process.env.WORKFOREST_HOME).projects[0]?.path).toBe(join(root, "workforest"))
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()

    await openAddProjectModal(setup)
    await setup.mockInput.typeText(`${root}/wor`)
    await waitForPaths()
    const row = findById(setup.renderer.root, "path-suggestion-1")!
    await setup.mockMouse.click(row.x + 3, row.y)
    await waitForPaths()
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("Not a git repository")
    expect(loadConfig(process.env.WORKFOREST_HOME).projects).toHaveLength(1)
    setup.mockInput.pressEscape()
    await paint(setup)

    for (const key of ["tab", "right"]) {
      await openAddProjectModal(setup)
      await setup.mockInput.typeText(`${root}/workf`)
      await waitForPaths()
      if (key === "right") setup.mockInput.pressArrow("right")
      else setup.mockInput.pressTab()
      await waitForPaths()
      const input = findById(setup.renderer.root, "modal-input") as import("@opentui/core").InputRenderable
      expect(input.value).toBe(`${root}/workforest/`)
      expect(input.cursorOffset).toBe(input.value.length)
      setup.mockInput.pressEscape()
      await paint(setup)
    }
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("add project keeps the dialog, input and buttons still while typing and deleting", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-completion-layout-")))
  const oldHome = process.env.WORKFOREST_HOME
  process.env.WORKFOREST_HOME = join(root, "home")
  for (const name of ["alpha", "alpine", "beta"]) mkdirSync(join(root, name))
  const setup = await testRender(() => <App />, { width: 100, height: 28 })
  const geometry = () => ["modal-dialog", "modal-input", "btn-submit", "btn-cancel"].map((id) => {
    const node = findById(setup.renderer.root, id)!
    return { x: node.x, y: node.y, width: node.width, height: node.height }
  })
  try {
    await paint(setup)
    for (const height of [28, 18]) {
      setup.renderer.resize(100, height)
      await paint(setup)
      await openAddProjectModal(setup)
      const initial = geometry()
      expect(initial[0]!.height).toBeLessThanOrEqual(16)
      expect(setup.captureCharFrame()).toContain("Type a path to see matching directories.")
      expect(setup.captureCharFrame()).not.toContain("0 directories")
      const dialog = findById(setup.renderer.root, "modal-dialog")!
      const submit = findById(setup.renderer.root, "btn-submit")!
      expect(submit.y + submit.height).toBeLessThan(dialog.y + dialog.height - 1)
      const assertStable = async () => {
        await paint(setup)
        expect(geometry()).toEqual(initial)
        await Bun.sleep(100)
        await paint(setup)
        expect(geometry()).toEqual(initial)
      }
      await setup.mockInput.typeText(`${root}/`)
      await assertStable()
      expect(findById(setup.renderer.root, "path-suggestion-0")).toBeTruthy()
      for (const text of ["a", "l", "!"]) {
        await setup.mockInput.typeText(text)
        await assertStable()
      }
      expect(findById(setup.renderer.root, "path-suggestion-0")).toBeUndefined()
      for (let i = 0; i < 3; i++) {
        setup.mockInput.pressBackspace()
        await assertStable()
      }
      for (let i = 0; i < `${root}/`.length; i++) setup.mockInput.pressBackspace()
      await assertStable()
      expect((findById(setup.renderer.root, "modal-input") as import("@opentui/core").InputRenderable).value).toBe("")
      setup.mockInput.pressEscape()
      await paint(setup)
    }
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("Ship settings keep independent drafts when switching sidebar sections", async () => {
  const home = mkdtempSync(join(tmpdir(), "wf-ship-settings-ui-"))
  const oldHome = process.env.WORKFOREST_HOME
  process.env.WORKFOREST_HOME = home
  const setup = await testRender(() => <App />, { width: 110, height: 36 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const prompt = () => findById(setup.renderer.root, "settings-prompt") as import("@opentui/core").TextareaRenderable
  try {
    await paint(setup)
    await click("btn-settings")
    prompt().setText("Rename draft")
    await paint(setup)
    await click("settings-section-ship")
    expect(prompt().plainText).toContain("Prepare this branch for review")
    prompt().setText("Ship draft")
    await paint(setup)
    await click("settings-section-autoRename")
    expect(prompt().plainText).toBe("Rename draft")
    await click("settings-section-ship")
    expect(prompt().plainText).toBe("Ship draft")
    await click("btn-settings-save")
    expect(loadConfig(home).autoRename?.prompt).toBe("Rename draft")
    expect(loadConfig(home).ship?.prompt).toBe("Ship draft")
    await click("btn-settings")
    await click("settings-section-ship")
    expect(prompt().plainText).toBe("Ship draft")
    prompt().setText("Discard this")
    await click("btn-settings-cancel")
    expect(loadConfig(home).ship?.prompt).toBe("Ship draft")
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})

test.serial("Ship branch picker focuses search, filters results, and selects with Enter or mouse", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-branch-search-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home"), repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"])
  gitOk(repo, ["branch", "develop"])
  for (let i = 0; i < 12; i++) gitOk(repo, ["branch", `branch-${i}`])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "search-feature", startPoint: "develop" })
  const setup = await testRender(() => <App />, { width: 120, height: 36 })
  const node = (id: string) => findById(setup.renderer.root, id)!
  const search = () => node("source-branch-search") as InputRenderable
  const selected = () => (node("source-branch").getChildren()[0] as TextRenderable).plainText
  const click = async (id: string) => {
    const target = node(id)
    await setup.mockMouse.click(target.x + 1, target.y + Math.floor(target.height / 2))
    await paint(setup)
  }
  try {
    await paint(setup)
    const row = node(`tree-row-${tree.path}`)
    await setup.mockMouse.click(row.x + 1, row.y, 2)
    await paint(setup)
    const git = node("btn-git")
    await setup.mockMouse.moveTo(git.x + 1, git.y)
    await paint(setup)
    await click("btn-ship")
    expect(selected()).toBe("develop")
    await click("source-branch")
    expect(search().focused).toBe(true)
    expect(setup.captureCharFrame()).toContain("● develop")

    // Typing starts a fresh highlight even when the suggested target was far down the list.
    await setup.mockInput.typeText("BRANCH-1")
    await paint(setup)
    expect(search().value).toBe("BRANCH-1")
    expect(setup.captureCharFrame()).toContain("○ branch-1")
    expect(setup.captureCharFrame()).toContain("○ branch-10")
    expect(setup.captureCharFrame()).toContain("○ branch-11")
    expect(setup.captureCharFrame()).not.toContain("○ branch-0")
    expect(setup.captureCharFrame()).not.toContain("● develop")
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(selected()).toBe("branch-11")
    expect(node("source-branch-menu")).toBeUndefined()
    expect(node("modal-dialog")).toBeTruthy()

    // Reopening by keyboard clears the old query and focuses search again.
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(search().value).toBe("")
    expect(search().focused).toBe(true)
    await setup.mockInput.typeText("no-match")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("No matching branches")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(selected()).toBe("branch-11")
    expect(node("source-branch-menu")).toBeTruthy()
    for (let i = 0; i < "no-match".length; i++) setup.mockInput.pressBackspace()
    await paint(setup)
    expect(search().value).toBe("")
    expect(setup.captureCharFrame()).toContain("○ branch-0")
    await setup.mockInput.typeText("MAIN")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(selected()).toBe("main")

    await click("source-branch")
    await setup.mockInput.typeText("develop")
    await paint(setup)
    setup.mockInput.pressEscape()
    await paint(setup)
    expect(node("source-branch-menu")).toBeUndefined()
    expect(selected()).toBe("main")
    await click("source-branch")
    await setup.mockInput.typeText("develop")
    await paint(setup)
    await click("source-option-0")
    expect(selected()).toBe("develop")
    expect(node("source-branch-menu")).toBeUndefined()
    expect(gitOk(repo, ["config", "--get", "branch.search-feature.workforest-source"]).trim()).toBe("develop")
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test.serial("Git hover opens Ship; target defaults to source, AI progress stays on its row, and PR opens inline", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-ship-ui-")))
  const oldHome = process.env.WORKFOREST_HOME, oldPath = process.env.PATH
  const home = join(root, "home"), repo = join(root, "repo"), remote = join(root, "remote.git"), bin = join(root, "bin")
  mkdirSync(repo)
  mkdirSync(bin)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "commit.gpgsign", "false"])
  gitOk(repo, ["commit", "--allow-empty", "-m", "initial"])
  gitOk(repo, ["branch", "develop"])
  for (let i = 0; i < 12; i++) gitOk(repo, ["branch", `branch-${i}`])
  gitOk(root, ["init", "--bare", remote])
  gitOk(repo, ["remote", "add", "origin", remote])
  gitOk(repo, ["push", "origin", "main", "develop"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "ship-feature", startPoint: "develop" })
  writeFileSync(join(tree.path, "feature.txt"), "user feature")
  const prs = join(root, "prs.json"), opened = join(root, "opened.txt"), prState = join(root, "pr-state.txt"), merged = join(root, "merged.json")
  writeFileSync(prs, "[]")
  writeFileSync(prState, "OPEN")
  const shim = (name: string, body: string) => {
    const file = join(bin, name)
    writeFileSync(file, `#!${process.execPath}\n${body}`)
    chmodSync(file, 0o755)
  }
  shim("gh", `
const args = process.argv.slice(2)
if (args[0] === 'repo') console.log(JSON.stringify({url:'https://github.com/test/demo'}))
else if (args[1] === 'list') console.log(await Bun.file(${JSON.stringify(prs)}).text())
else if (args[1] === 'create') await Bun.write(${JSON.stringify(prs)}, JSON.stringify([{number:450,url:'https://github.com/test/demo/pull/450',baseRefName:args[args.indexOf('--base')+1],isCrossRepository:false}]))
else if (args[1] === 'view') console.log(JSON.stringify({url:args[2],state:(await Bun.file(${JSON.stringify(prState)}).text()).trim()}))
else if (args[1] === 'merge') {
  await Bun.write(${JSON.stringify(merged)}, JSON.stringify(args))
  await Bun.write(${JSON.stringify(prState)}, 'MERGED')
}
`)
  shim("codex", `
const args = process.argv.slice(2)
await Bun.stdin.text()
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'SHIP_STATUS: reviewing checkout validation'}}))
await Bun.sleep(600)
await Bun.write(args[args.indexOf('--output-last-message')+1], JSON.stringify({ready:true,blocker:'',commitMessage:'Add feature',title:'Add feature',body:'Feature work',commitStatus:'recording feature',pushStatus:'sending checked branch',prStatus:'opening feature review'}))
`)
  shim(process.platform === "darwin" ? "open" : "xdg-open", `await Bun.write(${JSON.stringify(opened)}, process.argv[2])`)
  process.env.PATH = `${bin}:${oldPath}`
  const setup = await testRender(() => <App />, { width: 120, height: 30 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const badgeHasColor = (color: string) => {
    const badge = findById(setup.renderer.root, "pr-link-450")
    const label = badge?.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)
    return label?.fg.equals(RGBA.fromHex(color)) ?? false
  }
  const badgeMatchesRow = () => {
    const badge = findById(setup.renderer.root, "pr-link-450") as BoxRenderable
    const row = badge.parent?.parent as BoxRenderable
    return badge.backgroundColor.equals(row.backgroundColor)
  }
  try {
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("ship-feature"); i++) await paint(setup)
    const at = findText(setup.captureCharFrame(), "ship-feature")
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
    expect(findById(setup.renderer.root, "btn-pull")).toBeUndefined()
    const git = findById(setup.renderer.root, "btn-git")!
    await setup.mockMouse.moveTo(git.x + 1, git.y)
    await paint(setup)
    expect(findById(setup.renderer.root, "git-submenu")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-pull")).toBeTruthy()
    await click("btn-ship")
    expect(setup.captureCharFrame()).toContain("PR target branch")
    expect(setup.captureCharFrame()).toContain("develop")
    expect(setup.captureCharFrame()).toContain("Source: saved")
    await click("source-branch")
    expect(findById(setup.renderer.root, "source-branch-menu")).toBeTruthy()
    // The selected branch remains visible even beyond the first eight options.
    expect(setup.captureCharFrame()).toContain("● develop")
    setup.mockInput.pressArrow("down")
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("○ main")
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(findById(setup.renderer.root, "source-branch-menu")).toBeUndefined()
    expect(gitOk(repo, ["config", "--get", "branch.ship-feature.workforest-source"]).trim()).toBe("develop")
    await click("source-branch")
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    await paint(setup)
    await click("btn-submit")
    expect(findById(setup.renderer.root, "modal-dialog")).toBeUndefined()
    for (let i = 0; i < 100 && !setup.captureCharFrame().includes("reviewing checkout validation"); i++) await paint(setup)
    const lines = setup.captureCharFrame().split("\n")
    expect(lines.find((line) => line.includes("ship-feature"))).toContain("reviewing checkout validation")
    expect(lines.find((line) => line.includes("(main)"))).not.toContain("reviewing checkout validation")
    expect(findById(setup.renderer.root, "btn-cancel-ship")).toBeTruthy()
    for (let i = 0; i < 120 && !findById(setup.renderer.root, "pr-link-450"); i++) await paint(setup)
    expect(findById(setup.renderer.root, "pr-link-450")).toBeTruthy()
    for (let i = 0; i < 40 && !badgeHasColor(theme.danger); i++) await paint(setup)
    expect(badgeHasColor(theme.danger)).toBe(true)
    const badge = findById(setup.renderer.root, "pr-link-450") as BoxRenderable
    const label = badge.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)!
    expect(badgeMatchesRow()).toBe(true)
    expect(label.attributes & TextAttributes.UNDERLINE).toBeTruthy()
    expect(findById(setup.renderer.root, "modal-dialog")).toBeUndefined()
    expect(setup.captureCharFrame().split("\n").find((line) => line.includes("ship-feature"))).toContain("#450")
    expect(gitOk(repo, ["config", "--get", "branch.ship-feature.workforest-source"]).trim()).toBe("develop")
    await click("pr-link-450")
    expect(badgeMatchesRow()).toBe(true)
    for (let i = 0; i < 20 && !existsSync(opened); i++) await paint(setup)
    expect(await Bun.file(opened).text()).toBe("https://github.com/test/demo/pull/450")
    const prLink = findById(setup.renderer.root, "pr-link-450")!
    await setup.mockMouse.click(prLink.x + 2, prLink.y, 2)
    await paint(setup)
    expect(findById(setup.renderer.root, "context-menu")?.getChildren().map((child) => child.id)).toEqual(["btn-merge-pr"])
    expect(findById(setup.renderer.root, "btn-merge-pr")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-delete")).toBeUndefined()
    expect(existsSync(merged)).toBe(false)
    await click("btn-merge-pr")
    for (let i = 0; i < 40 && !existsSync(merged); i++) await paint(setup)
    expect(JSON.parse(await Bun.file(merged).text())).toEqual(["pr", "merge", "https://github.com/test/demo/pull/450", "--merge"])
    for (let i = 0; i < 40 && !badgeHasColor(theme.selectedFg); i++) await paint(setup)
    expect(badgeHasColor(theme.selectedFg)).toBe(true)
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("merged PR #450"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("merged PR #450")
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

test.serial("PR link uses saved state on startup before GitHub responds", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-pr-state-ui-")))
  const oldHome = process.env.WORKFOREST_HOME, oldPath = process.env.PATH
  const home = join(root, "home"), repo = join(root, "repo"), bin = join(root, "bin"), viewDone = join(root, "view-done")
  mkdirSync(repo)
  mkdirSync(bin)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["-c", "user.name=wf", "-c", "user.email=wf@test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "cached-pr" })
  gitOk(repo, ["config", "--local", "branch.cached-pr.workforest-pr", JSON.stringify({ number: 603, url: "https://github.com/test/demo/pull/603", base: "main" })])
  const gh = join(bin, "gh")
  writeFileSync(gh, `#!${process.execPath}\nawait Bun.sleep(1500); await Bun.write(${JSON.stringify(viewDone)}, 'done'); console.log(JSON.stringify({url:'https://github.com/test/demo/pull/603',state:'MERGED'}))`)
  chmodSync(gh, 0o755)
  process.env.PATH = `${bin}:${oldPath}`
  const hasColor = (node: Renderable, color: string) => {
    const badge = findById(node, "pr-link-603")
    const label = badge?.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)
    return label?.fg.equals(RGBA.fromHex(color)) ?? false
  }
  try {
    const first = await testRender(() => <App />, { width: 100, height: 18 })
    try {
      for (let i = 0; i < 40 && !findById(first.renderer.root, "pr-link-603"); i++) await paint(first)
      expect(hasColor(first.renderer.root, theme.danger)).toBe(true)
      expect(existsSync(viewDone)).toBe(false)
      for (let i = 0; i < 100 && !hasColor(first.renderer.root, theme.selectedFg); i++) await paint(first)
      expect(hasColor(first.renderer.root, theme.selectedFg)).toBe(true)
      expect(JSON.parse(gitOk(repo, ["config", "--local", "--get", "branch.cached-pr.workforest-pr"])).state).toBe("MERGED")
    } finally { first.renderer.destroy() }

    rmSync(viewDone, { force: true })
    const second = await testRender(() => <App />, { width: 100, height: 18 })
    try {
      for (let i = 0; i < 40 && !findById(second.renderer.root, "pr-link-603"); i++) await paint(second)
      expect(hasColor(second.renderer.root, theme.selectedFg)).toBe(true)
      expect(existsSync(viewDone)).toBe(false)
      for (let i = 0; i < 100 && !existsSync(viewDone); i++) await paint(second)
    } finally { second.renderer.destroy() }
  } finally {
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test.serial("Git submenu switches the selected worktree and keeps local changes when Git refuses", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-switch-ui-")))
  const oldHome = process.env.WORKFOREST_HOME
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(repo)
  process.env.WORKFOREST_HOME = home
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(repo, "README.md"), "hi\n")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "init"])
  gitOk(repo, ["checkout", "-b", "topic"])
  writeFileSync(join(repo, "topic.txt"), "from topic\n")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "topic"])
  gitOk(repo, ["checkout", "-b", "other"])
  writeFileSync(join(repo, "topic.txt"), "from other\n")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "other"])
  gitOk(repo, ["checkout", "main"])
  const project = addProject(home, repo)
  const tree = createWorktree({ repoPath: repo, home, projectId: project.id, name: "feature-switch", startPoint: "main" })
  const setup = await testRender(() => <App />, { width: 120, height: 32 })
  const click = async (id: string) => {
    const node = findById(setup.renderer.root, id)!
    expect(node).toBeTruthy()
    await setup.mockMouse.click(node.x + 1, node.y + Math.floor(node.height / 2))
    await paint(setup)
  }
  const rightClick = async (label: string) => {
    const at = findText(setup.captureCharFrame(), label)
    await setup.mockMouse.click(at.x, at.y, 2)
    await paint(setup)
  }
  const optionText = (index: number) => {
    const node = findById(setup.renderer.root, `source-option-${index}`)
    const label = node?.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)
    return label?.plainText ?? ""
  }
  const selectedBranch = () => {
    const field = findById(setup.renderer.root, "source-branch")
    const label = field?.getChildren().find((child): child is TextRenderable => child instanceof TextRenderable)
    return label?.plainText ?? ""
  }
  try {
    for (let i = 0; i < 30 && !setup.captureCharFrame().includes("feature-switch"); i++) await paint(setup)
    await rightClick("(main)")
    await click("btn-git")
    expect(findById(setup.renderer.root, "btn-switch-branch")).toBeTruthy()
    await setup.mockMouse.click(0, 0)
    await paint(setup)

    await rightClick("feature-switch")
    expect(findById(setup.renderer.root, "btn-switch-branch")).toBeUndefined()
    await click("btn-git")
    const pull = findById(setup.renderer.root, "btn-pull")!
    const switcher = findById(setup.renderer.root, "btn-switch-branch")!
    const ship = findById(setup.renderer.root, "btn-ship")!
    expect(pull.y).toBeLessThan(switcher.y)
    expect(switcher.y).toBeLessThan(ship.y)
    expect(setup.captureCharFrame()).toContain("Switch Branch…")
    await click("btn-switch-branch")
    expect(setup.captureCharFrame()).toContain("Uncommitted changes stay")
    expect(findById(setup.renderer.root, "source-branch-menu")).toBeTruthy()
    expect([0, 1, 2].map(optionText).join("\n")).toBe("○ main\n○ other\n○ topic")
    await setup.mockInput.typeText("topic")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(selectedBranch()).toBe("topic")
    expect(findById(setup.renderer.root, "source-branch-menu")).toBeUndefined()
    await click("btn-submit")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("switched feature-switch to topic"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("switched feature-switch to topic")
    expect(setup.captureCharFrame().split("\n").some((line) => line.includes("○ topic"))).toBe(true)
    expect(setup.captureCharFrame().split("\n").some((line) => line.includes("○ feature-switch"))).toBe(false)
    expect(gitOk(tree.path, ["branch", "--show-current"]).trim()).toBe("topic")
    expect(readFileSync(join(tree.path, "topic.txt"), "utf8")).toBe("from topic\n")
    expect(gitOk(repo, ["branch", "--show-current"]).trim()).toBe("main")

    writeFileSync(join(tree.path, "topic.txt"), "dirty edit\n")
    await rightClick("topic")
    await click("btn-git")
    await click("btn-switch-branch")
    await setup.mockInput.typeText("other")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(selectedBranch()).toBe("other")
    await click("btn-submit")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("would be overwritten"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("Local changes (topic.txt) would be overwritten")
    expect(findById(setup.renderer.root, "modal-dialog")).toBeTruthy()
    expect(readFileSync(join(tree.path, "topic.txt"), "utf8")).toBe("dirty edit\n")
    expect(gitOk(tree.path, ["branch", "--show-current"]).trim()).toBe("topic")

    await click("source-branch")
    await setup.mockInput.typeText("main")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    await click("btn-submit")
    for (let i = 0; i < 40 && !setup.captureCharFrame().includes("already checked out"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain('Branch "main" is already checked out in another worktree')
    expect(readFileSync(join(tree.path, "topic.txt"), "utf8")).toBe("dirty edit\n")
    expect(gitOk(tree.path, ["branch", "--show-current"]).trim()).toBe("topic")
    expect(gitOk(repo, ["branch", "--show-current"]).trim()).toBe("main")
    await click("btn-cancel")
    expect(findById(setup.renderer.root, "modal-dialog")).toBeUndefined()
    expect(setup.captureCharFrame().split("\n").some((line) => line.includes("○ topic"))).toBe(true)
    expect(setup.captureCharFrame().split("\n").some((line) => line.includes("○ other"))).toBe(false)
  } finally {
    setup.renderer.destroy()
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
