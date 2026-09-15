import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import { addProject } from "./lib/config.ts"
import { createWorktree, gitOk, listWorktrees } from "./lib/git.ts"
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
    expect(frame).toContain("servers (0)")
    expect(frame).toContain("add")
    expect(frame).toContain("actions")
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
    expect(setup.captureCharFrame()).toContain("add")
    expect(setup.captureCharFrame()).not.toContain("kill")

    setup.mockInput.pressArrow("right")
    await paint(setup)
    let frame = setup.captureCharFrame()
    expect(frame).toContain("new")
    expect(frame).not.toContain("add")
    expect(frame).not.toContain("kill")

    setup.mockInput.pressArrow("right")
    await paint(setup)
    frame = setup.captureCharFrame()
    expect(frame).toContain("kill")
    expect(frame).not.toContain("add")

    setup.mockInput.pressArrow("left")
    await paint(setup)
    frame = setup.captureCharFrame()
    expect(frame).toContain("new")
    expect(frame).not.toContain("kill")
  } finally {
    setup.renderer.destroy()
  }
})

test("down focuses footer buttons and up returns to panes", async () => {
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
    expect(frame).toContain("new")
    expect(frame).not.toContain("add")
  } finally {
    setup.renderer.destroy()
  }
})

test("footer actions follow the focused pane", async () => {
  process.env.WORKFOREST_HOME = mkdtempSync(join(tmpdir(), "wf-ui-"))
  const setup = await testRender(() => <App />, { width: 140, height: 36 })
  try {
    await setup.renderOnce()
    const servers = findById(setup.renderer.root, "pane-servers")
    if (!servers) throw new Error("missing pane-servers")
    await setup.mockMouse.click(servers.x + 1, servers.y)
    await paint(setup)
    const frame = setup.captureCharFrame()
    expect(frame).toContain("projects")
    expect(frame).toContain("worktrees")
    expect(frame).toContain("servers")
    expect(frame).toContain("kill")
    expect(frame).toContain("refresh")
    expect(frame).not.toContain("add")
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

test("up from panes focuses header, down returns through panes to footer", async () => {
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
    await setup.mockMouse.click(button!.x + 2, button!.y + 1)
    await paint(setup)
  }
  try {
    await paint(setup)
    const row = findText(setup.captureCharFrame(), "old-feature")
    await setup.mockMouse.click(row.x, row.y)
    await paint(setup)
    expect(findById(setup.renderer.root, "btn-auto-rename")).toBeUndefined()
    await click("btn-rename")
    expect(setup.captureCharFrame()).toContain("Choose how to name")
    await click("btn-manual-rename")
    expect(findById(setup.renderer.root, "modal-input")).toBeTruthy()
    expect(setup.captureCharFrame()).toContain("old-feature")
    await click("btn-cancel")
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
