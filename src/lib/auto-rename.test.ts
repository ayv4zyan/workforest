import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renameContext, parseSuggestedName, suggestWorktreeName } from "./auto-rename.ts"
import { createWorktree, gitOk, listWorktrees } from "./git.ts"

const dirs: string[] = []
const originalPath = process.env.PATH
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "wf-naming-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const repo = temp()
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(repo, "app.txt"), "original\n")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "init"])
  const tree = createWorktree({ repoPath: repo, home: temp(), projectId: "demo", name: "old-name" })
  return { repo, tree }
}
function fakeCodex(body: string) {
  const bin = temp()
  const script = join(bin, "codex")
  writeFileSync(script, `#!${process.execPath}\n${body}`)
  chmodSync(script, 0o755)
  process.env.PATH = `${bin}:${originalPath}`
}

test("context includes branch work after main advances and both index and working changes", () => {
  const { repo, tree } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "committed feature\n")
  gitOk(tree.path, ["add", "."])
  gitOk(tree.path, ["commit", "-m", "feature"])
  writeFileSync(join(repo, "main-only.txt"), "unrelated main work\n")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "main advances"])
  writeFileSync(join(tree.path, "app.txt"), "staged feature\n")
  gitOk(tree.path, ["add", "."])
  writeFileSync(join(tree.path, "app.txt"), "unstaged feature\n")
  writeFileSync(join(tree.path, "new-feature.ts"), "new code")
  writeFileSync(join(tree.path, ".env.local"), "SECRET=private")
  const context = renameContext(repo, tree)
  expect(context).toContain("committed feature")
  expect(context).toContain("staged feature")
  expect(context).toContain("unstaged feature")
  expect(context).toContain("new-feature.ts")
  expect(context).not.toContain("unrelated main work")
  expect(context).not.toContain(".env.local")
  expect(context).not.toContain("SECRET")
})

test("empty worktrees and main are rejected; untracked-only work can be named", () => {
  const { repo, tree } = fixture()
  expect(() => renameContext(repo, tree)).toThrow("No changes")
  expect(() => renameContext(repo, listWorktrees(repo)[0]!)).toThrow("main worktree")
  expect(() => renameContext(repo, { ...tree, branch: null })).toThrow("detached")
  writeFileSync(join(tree.path, "new-feature.ts"), "new code")
  expect(renameContext(repo, tree)).toContain("new-feature.ts")
})

test("requires the agent prefix and rejects malformed or excessively long names", () => {
  for (const value of ["use this name", "{}", "null", '{"name":"../oops"}', '{"name":"feat/auth"}', '{"name":"fix-login-redirect"}', JSON.stringify({ name: `agent/${"a".repeat(59)}` })]) {
    expect(() => parseSuggestedName(value)).toThrow()
  }
  expect(parseSuggestedName('{"name":"agent/fix-login-redirect"}')).toBe("agent/fix-login-redirect")
})

test("Codex receives the diff and Luna High options, without renaming the tree", async () => {
  const { repo, tree } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "fix login redirect\n")
  const capture = join(temp(), "request.json")
  fakeCodex(`
const args = process.argv.slice(2)
const prompt = await Bun.stdin.text()
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({ args, prompt, cwd: process.cwd() }))
await Bun.write(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ name: 'agent/fix-login-redirect' }))
`)
  expect(await suggestWorktreeName(repo, tree)).toBe("agent/fix-login-redirect")
  const request = JSON.parse(readFileSync(capture, "utf8"))
  expect(request.args).toContain("gpt-5.6-luna")
  expect(request.args).toContain('model_reasoning_effort="high"')
  expect(request.args).toContain("read-only")
  expect(request.prompt).toContain("fix login redirect")
  expect(request.prompt).toContain("must start with agent/")
  expect(request.cwd).not.toBe(tree.path)
  expect(listWorktrees(repo)[1]?.branch).toBe("old-name")
})

test("Codex failure is surfaced", async () => {
  const { repo, tree } = fixture()
  writeFileSync(join(tree.path, "new.ts"), "new")
  fakeCodex("console.error('Please run codex login'); process.exit(1)")
  await expect(suggestWorktreeName(repo, tree)).rejects.toThrow("codex login")
})

test("an in-flight Codex request can be cancelled", async () => {
  const { repo, tree } = fixture()
  writeFileSync(join(tree.path, "new.ts"), "new")
  fakeCodex("await Bun.sleep(30000)")
  const abort = new AbortController()
  const result = suggestWorktreeName(repo, tree, abort.signal)
  abort.abort()
  await expect(result).rejects.toThrow()
})
