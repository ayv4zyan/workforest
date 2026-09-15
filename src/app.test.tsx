import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
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
    await Bun.sleep(20)
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("new")
    expect(frame).not.toContain("add")
    expect(frame).not.toContain("kill")

    setup.mockInput.pressArrow("right")
    await Bun.sleep(20)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("kill")
    expect(frame).not.toContain("add")

    setup.mockInput.pressArrow("left")
    await Bun.sleep(20)
    await setup.renderOnce()
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
    await Bun.sleep(20)
    setup.mockInput.pressEnter()
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("add project")

    setup.mockInput.pressEscape()
    await Bun.sleep(20)
    await setup.renderOnce()

    setup.mockInput.pressArrow("up")
    await Bun.sleep(20)
    setup.mockInput.pressArrow("right")
    await Bun.sleep(20)
    await setup.renderOnce()
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
    await Bun.sleep(20)
    await setup.renderOnce()
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
