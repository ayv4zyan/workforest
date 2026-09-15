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

async function paint(setup: { renderOnce: () => Promise<void> }) {
  await Bun.sleep(20)
  await setup.renderOnce()
}

test("test renderer can paint text", async () => {
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

test("box onMouseDown receives a mock click", async () => {
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

test("ActionButton click fires onPress", async () => {
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

test("renders the workforest shell with clickable controls", async () => {
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
    expect(frame).toContain("refresh")
    expect(frame).toContain("quit")
    expect(frame).not.toContain("detail")
    expect(frame).not.toContain("kill")
    expect(frame).not.toContain("project(s)")
  } finally {
    setup.renderer.destroy()
  }
})

test("arrow keys cycle focused panes", async () => {
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

test("down focuses pane controls and up returns to panes", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()

    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("add project")

    setup.mockInput.pressEscape()
    await paint(setup)

    setup.mockInput.pressArrow("up")
    await paint(setup)
    setup.mockInput.pressArrow("right")
    await paint(setup)
    const frame = setup.captureCharFrame()
    expect(findById(setup.renderer.root, "btn-new")).toBeTruthy()
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
  } finally {
    setup.renderer.destroy()
  }
})

test("pane add buttons remain visible when focus changes", async () => {
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
    expect(frame).toContain("refresh")
    expect(findById(setup.renderer.root, "btn-add")).toBeTruthy()
  } finally {
    setup.renderer.destroy()
  }
})

async function openAddProjectModal(setup: {
  mockInput: { pressArrow: (direction: "up" | "down" | "left" | "right") => void; pressEnter: () => void }
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
}) {
  setup.mockInput.pressArrow("down")
  await paint(setup)
  setup.mockInput.pressEnter()
  await paint(setup)
  expect(setup.captureCharFrame()).toContain("add project")
}

test("up from panes focuses header, down returns through panes to pane controls", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()

    setup.mockInput.pressArrow("up")
    await paint(setup)
    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressArrow("down")
    await paint(setup)
    setup.mockInput.pressEnter()
    await paint(setup)
    expect(setup.captureCharFrame()).toContain("add project")
  } finally {
    setup.renderer.destroy()
  }
})

test("modal down from the path field focuses submit", async () => {
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

test("modal right from submit focuses cancel", async () => {
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

test("modal left and right stay in the path field", async () => {
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



test("auto-rename mouse action suggests a name and submit renames branch and directory", async () => {
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
await Bun.sleep(100)
await Bun.write(args[args.indexOf('--output-last-message') + 1], JSON.stringify({name: 'fix-login-flow'}))
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
    const more = findById(setup.renderer.root, "trees-more")!
    await setup.mockMouse.click(more.x + 1, more.y)
    await paint(setup)
    await click("btn-rename")
    expect(setup.captureCharFrame()).toContain("Choose how to name")
    await click("btn-manual-rename")
    expect(findById(setup.renderer.root, "modal-input")).toBeTruthy()
    expect(setup.captureCharFrame()).toContain("old-feature")
    await click("btn-cancel")
    await setup.mockMouse.click(more.x + 1, more.y)
    await paint(setup)
    await click("btn-rename")
    await click("btn-auto-rename")
    expect(setup.captureCharFrame()).toContain("cancel rename")
    for (let i = 0; i < 60 && !findById(setup.renderer.root, "modal-input"); i++) await paint(setup)
    expect(setup.captureCharFrame()).toContain("fix-login-flow")
    expect(listWorktrees(repo)[1]?.branch).toBe("old-feature")
    await click("btn-submit")
    const renamed = listWorktrees(repo)[1]!
    expect(renamed.branch).toBe("fix-login-flow")
    expect(renamed.path.endsWith("/fix-login-flow")).toBe(true)
  } finally {
    setup.renderer.destroy()
    process.env.PATH = oldPath
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test("worktree start saves a custom project command, remembers it, shows logs, and stops", async () => {
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
    expect(setup.captureCharFrame()).toContain("Stopped")
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
    expect(setup.captureCharFrame().split("\n").slice(0, 3).join("\n")).toContain("■")
    expect(setup.captureCharFrame()).not.toContain("2 servers")
    setup.mockInput.pressArrow("down")
    await paint(setup)
    await click("btn-logs")
    expect(setup.captureCharFrame()).toContain("server ready")
    await click("btn-close-logs")
    await click("btn-start")
    for (let i = 0; i < 20; i++) {
      await Bun.sleep(50)
      await click("btn-refresh")
      if (setup.captureCharFrame().includes("Stopped")) break
    }
    expect(setup.captureCharFrame()).toContain("Stopped")
    expect(loadRunRecords(home)).toEqual([])
    writeFileSync(join(repo, "server.ts"), 'console.error("startup failed example"); process.exit(1)')
    await click("btn-start")
    await click("btn-submit")
    await Bun.sleep(150)
    await click("btn-refresh")
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
    expect(setup.captureCharFrame()).toContain("External processes were started outside Workforest")
    await click("btn-cancel")
    expect(external.exitCode).toBeNull()
    await click("btn-start")
    await click("btn-submit")
    await external.exited

  } finally {
    setup.renderer.destroy()
    occupied.stop(true)
    external?.kill()
    for (const row of collectServers({ home, projects: [project], treesByProject: new Map([[project.id, listWorktrees(repo)]]) })) {
      stopServer(home, row)
    }
    process.env.WORKFOREST_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test("row menus target the clicked item, protect main, and support mouse and keyboard", async () => {
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

    const featureRow = findText(setup.captureCharFrame(), "feature-menu")
    await rightClick("feature-menu")
    expect(findById(setup.renderer.root, "context-menu")).toBeTruthy()
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    const more = findById(setup.renderer.root, "trees-more")!
    expect(more.y).toBe(featureRow.y)
    setup.mockInput.pressEscape()
    await paint(setup)
    // Right-clicking the already selected worktree must not start its server.
    await rightClick("feature-menu")
    expect(loadRunRecords(home)).toEqual([])
    expect(findById(setup.renderer.root, "modal-input")).toBeUndefined()
    await setup.mockMouse.click(0, 0)
    await paint(setup)
    expect(findById(setup.renderer.root, "context-menu")).toBeUndefined()

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

    const feature = findText(setup.captureCharFrame(), "feature-menu")
    await setup.mockMouse.click(feature.x, feature.y)
    await paint(setup)
    await setup.mockInput.typeText("m")
    await paint(setup)
    const menu = findById(setup.renderer.root, "context-menu")!
    expect(menu.x + menu.width).toBeLessThanOrEqual(90)
    expect(menu.y + menu.height).toBeLessThanOrEqual(18)
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

    await click("projects-more")
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

test("selected row menu follows scrolling and stays inside a resized terminal", async () => {
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
    let more = findById(setup.renderer.root, "trees-more")!
    expect(more.y).toBe(findText(setup.captureCharFrame(), "item-7").y)
    setup.renderer.resize(80, 14)
    await paint(setup)
    more = findById(setup.renderer.root, "trees-more")!
    expect(more.y).toBe(findText(setup.captureCharFrame(), "item-7").y)
    await setup.mockMouse.click(more.x + 1, more.y)
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
