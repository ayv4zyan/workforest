import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { realpathSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import { addProject, loadConfig } from "./lib/config.ts"
import { createWorktree, gitOk, listWorktrees } from "./lib/git.ts"
import { collectServers, stopServer, loadRunRecords } from "./lib/servers.ts"
import { rememberPort } from "./lib/ports.ts"
import { App } from "./app.tsx"
import { ActionButton } from "./ui/button.tsx"

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
    expect(main.y - feature.y).toBe(1)
    expect(short.y - main.y).toBe(2)
    await setup.mockMouse.click(feature.x, feature.y)
    await paint(setup)
    for (const width of [90, 60]) {
      setup.renderer.resize(width, 18)
      await paint(setup)
      const frame = setup.captureCharFrame()
      const selected = findText(frame, "feature-")
      const next = findText(frame, "short-feature")
      expect(next.y - selected.y).toBe(3)
      expect(findText(frame, "(main)").y - selected.y).toBe(2)
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
    expect(setup.captureCharFrame()).toContain("Running (1)")
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
    secondServer.kill()
    await secondServer.exited
    secondServer = undefined
    setup.renderer.resize(160, 36)
    await paint(setup)
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (!setup.captureCharFrame().includes("2 servers")) break
    }
    expect(setup.captureCharFrame()).not.toContain("2 servers")
    await click("btn-start")
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("○")) break
    }
    expect(setup.captureCharFrame()).toContain("○")
    expect(loadRunRecords(home)).toEqual([])
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
    expect(setup.captureCharFrame()).toContain("External processes were started")
    expect(setup.captureCharFrame()).toContain("outside Workforest.")
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
      stopServer(home, row)
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
    expect(findText(frame, "Running (0)").y).toBeLessThan(findText(frame, "Not running (4)").y)
    expect(findText(frame, "Alpha").y).toBeLessThan(findText(frame, "beta").y)
    expect(findText(frame, "beta").y).toBeLessThan(findText(frame, "zebra").y)
    const header = findById(setup.renderer.root, "tree-group-stopped")!
    await setup.mockMouse.click(header.x + 1, header.y)
    await paint(setup)
    expect(setup.captureCharFrame()).not.toContain("zebra")
    expect(setup.captureCharFrame()).toContain("▸ Not running (4)")
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
