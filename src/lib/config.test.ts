import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addProject, loadConfig, moveWorktreePreferences, moveProject, moveWorktreeInOrder, syncWorktreeOrder, removeProject, saveConfig, setProjectPaneWidth, setProjectStartCommand, setSelectedProjectId, setWorktreePinned } from "./config.ts"
import { execOk } from "./exec.ts"

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-cfg-"))
  execOk(["git", "init"], { cwd: dir })
  execOk(["git", "checkout", "-B", "main"], { cwd: dir })
  execOk(["git", "config", "user.email", "wf@test"], { cwd: dir })
  execOk(["git", "config", "user.name", "wf"], { cwd: dir })
  execOk(["git", "config", "commit.gpgsign", "false"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), "hi\n")
  execOk(["git", "add", "."], { cwd: dir })
  execOk(["git", "commit", "-m", "init"], { cwd: dir })
  return dir
}

test("moving projects persists relative order and preserves project data and UI preferences", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-order-home-"))
  const projects = ["alpha", "hidden", "beta", "gamma"].map((id, index) => ({
    id, name: id, path: `/repos/${id}`, basePort: 5173 + index, startCommand: `bun run ${id}`,
  }))
  const ui = { selectedProjectId: "beta", projectPaneWidth: 36, pinnedWorktreePaths: ["/trees/beta/feature"] }
  try {
    saveConfig(home, { version: 1, projects, ui })
    expect(moveProject(home, "gamma", "alpha", "before").map((row) => row.id)).toEqual(["gamma", "alpha", "hidden", "beta"])
    expect(moveProject(home, "gamma", "beta", "after").map((row) => row.id)).toEqual(["alpha", "hidden", "beta", "gamma"])
    expect(moveProject(home, "alpha", "beta", "after").map((row) => row.id)).toEqual(["hidden", "beta", "alpha", "gamma"])
    const config = loadConfig(home)
    expect(config.ui).toEqual(ui)
    expect([...config.projects].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...projects].sort((a, b) => a.id.localeCompare(b.id)))
    // Adjacent moves and dropping on the source keep the same order.
    moveProject(home, "alpha", "beta", "after")
    moveProject(home, "beta", "alpha", "before")
    moveProject(home, "alpha", "alpha", "after")
    expect(loadConfig(home)).toEqual(config)
    expect(() => moveProject(home, "missing", "beta", "before")).toThrow("Unknown project")
    expect(() => moveProject(home, "beta", "missing", "after")).toThrow("Unknown project")
    expect(loadConfig(home)).toEqual(config)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("worktree ordering persists per project, follows folder moves, appends new trees and removes deleted trees", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-tree-order-"))
  const projects = ["one", "two"].map((id) => ({ id, name: id, path: `/repos/${id}`, basePort: 5173 }))
  try {
    saveConfig(home, { version: 1, projects, ui: { selectedProjectId: "one", pinnedWorktreePaths: ["/a"] } })
    expect(syncWorktreeOrder(home, "one", ["/a", "/b", "/c"])).toEqual(["/a", "/b", "/c"])
    syncWorktreeOrder(home, "two", ["/x", "/y"])
    expect(moveWorktreeInOrder(home, "one", "/c", "/a", "before")).toEqual(["/c", "/a", "/b"])
    expect(loadConfig(home).projects[1]?.worktreeOrder).toEqual(["/x", "/y"])
    setWorktreePinned(home, "/a", false)
    moveWorktreePreferences(home, "/a", "/renamed")
    expect(loadConfig(home).projects[0]?.worktreeOrder).toEqual(["/c", "/renamed", "/b"])
    expect(syncWorktreeOrder(home, "one", ["/b", "/renamed", "/new"])).toEqual(["/renamed", "/b", "/new"])
    expect(moveWorktreeInOrder(home, "one", "/renamed", "/new", "after")).toEqual(["/b", "/new", "/renamed"])
    expect(() => moveWorktreeInOrder(home, "one", "/missing", "/b", "before")).toThrow("Unknown worktree")
    expect(() => moveWorktreeInOrder(home, "missing", "/b", "/new", "before")).toThrow("Unknown project")
    expect(loadConfig(home).projects[0]?.path).toBe("/repos/one")
    expect(loadConfig(home).ui?.selectedProjectId).toBe("one")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("invalid worktree order is rejected without overwriting valid config", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-invalid-order-"))
  try {
    const config = { version: 1 as const, projects: [{ id: "one", name: "one", path: "/repo", basePort: 5173, worktreeOrder: ["/a"] }] }
    saveConfig(home, config)
    expect(() => saveConfig(home, { ...config, projects: [{ ...config.projects[0]!, worktreeOrder: ["/a", "/a"] }] })).toThrow("invalid config")
    expect(() => saveConfig(home, { ...config, projects: [{ ...config.projects[0]!, worktreeOrder: [""] }] })).toThrow("invalid config")
    expect(loadConfig(home)).toEqual(config)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("add and remove a registered project", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const repo = initRepo()
  const project = addProject(home, repo)
  expect(project.path).toBe(execOk(["git", "-C", repo, "rev-parse", "--show-toplevel"]).trim())
  expect(loadConfig(home).projects).toHaveLength(1)
  expect(() => addProject(home, repo)).toThrow(/already registered/)
  removeProject(home, project.id)
  expect(loadConfig(home).projects).toHaveLength(0)
})

test("start commands persist per project and reject empty commands", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-command-home-"))
  const first = addProject(home, initRepo())
  const second = addProject(home, initRepo())
  expect(setProjectStartCommand(home, first.id, "  bun local  ").startCommand).toBe("bun local")
  expect(loadConfig(home).projects.find((p) => p.id === first.id)?.startCommand).toBe("bun local")
  expect(loadConfig(home).projects.find((p) => p.id === second.id)?.startCommand).toBeUndefined()
  expect(() => setProjectStartCommand(home, first.id, "  ")).toThrow("command required")
  expect(() => setProjectStartCommand(home, "missing", "bun local")).toThrow("Unknown project")
  expect(setProjectStartCommand(home, first.id, "bun run preview").startCommand).toBe("bun run preview")
})

test("project pane width persists without changing projects", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-layout-home-"))
  const project = addProject(home, initRepo())
  setProjectPaneWidth(home, 42)
  const config = loadConfig(home)
  expect(config.ui?.projectPaneWidth).toBe(42)
  expect(config.projects.map((row) => row.id)).toEqual([project.id])
})

test("selected project persists and falls back when removed", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-selected-home-"))
  const first = addProject(home, initRepo())
  const second = addProject(home, initRepo())
  setProjectPaneWidth(home, 42)
  setSelectedProjectId(home, second.id)
  expect(loadConfig(home).ui).toEqual({ projectPaneWidth: 42, selectedProjectId: second.id })
  expect(() => setSelectedProjectId(home, "missing")).toThrow("Unknown project")
  removeProject(home, second.id)
  expect(loadConfig(home).ui).toEqual({ projectPaneWidth: 42, selectedProjectId: first.id })
})

test("pinned worktree paths persist without duplicates and follow a moved folder", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-pins-home-"))
  const project = addProject(home, initRepo())
  setSelectedProjectId(home, project.id)
  expect(setWorktreePinned(home, "/trees/one", true).pinnedWorktreePaths).toEqual(["/trees/one"])
  expect(setWorktreePinned(home, "/trees/one", true).pinnedWorktreePaths).toEqual(["/trees/one"])
  expect(setWorktreePinned(home, "/trees/two", true).pinnedWorktreePaths).toEqual(["/trees/one", "/trees/two"])
  moveWorktreePreferences(home, "/trees/one", "/trees/two")
  expect(loadConfig(home).ui).toEqual({ selectedProjectId: project.id, pinnedWorktreePaths: ["/trees/two"], unpinnedMainWorktreePaths: [] })
  expect(setWorktreePinned(home, "/trees/two", false).pinnedWorktreePaths).toEqual([])
  expect(loadConfig(home).ui?.pinnedWorktreePaths).toEqual([])
  expect(setWorktreePinned(home, "/main", false, true).unpinnedMainWorktreePaths).toEqual(["/main"])
  expect(setWorktreePinned(home, "/main", false, true).unpinnedMainWorktreePaths).toEqual(["/main"])
  expect(loadConfig(home).ui?.unpinnedMainWorktreePaths).toEqual(["/main"])
  expect(setWorktreePinned(home, "/main", true, true).unpinnedMainWorktreePaths).toEqual([])
})
