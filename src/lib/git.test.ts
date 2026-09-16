import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execOk } from "./exec.ts"
import {
  createWorktree,
  isDirty,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  renameWorktree,
  samePath,
} from "./git.ts"

const porcelain = `worktree /tmp/repo
HEAD abc
branch refs/heads/main

worktree /tmp/repo-feat
HEAD def
branch refs/heads/feat-auth
`

test("parseWorktreeList marks the first entry as main", () => {
  const trees = parseWorktreeList(porcelain)
  expect(trees).toHaveLength(2)
  expect(trees[0]?.isMain).toBe(true)
  expect(trees[0]?.branch).toBe("main")
  expect(trees[1]?.isMain).toBe(false)
  expect(trees[1]?.branch).toBe("feat-auth")
})

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-repo-"))
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

test("create, rename both directory and branch, then delete", () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const created = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feat-auth" })
  expect(created.branch).toBe("feat-auth")
  expect(samePath(created.path, join(home, "trees", "demo", "feat-auth"))).toBe(true)
  expect(isDirty(created.path)).toBe(false)

  const renamed = renameWorktree({
    repoPath: repo,
    tree: created,
    newName: "feat-login",
    home,
    projectId: "demo",
  })
  expect(samePath(renamed.path, join(home, "trees", "demo", "feat-login"))).toBe(true)
  expect(renamed.branch).toBe("feat-login")

  const trees = listWorktrees(repo)
  expect(trees.map((tree) => tree.branch)).toContain("feat-login")
  expect(trees.map((tree) => tree.branch)).not.toContain("feat-auth")

  const feat = trees.find((tree) => tree.branch === "feat-login")
  expect(feat).toBeTruthy()
  removeWorktree({ repoPath: repo, tree: feat!, force: true })
  expect(listWorktrees(repo).map((tree) => tree.branch)).not.toContain("feat-login")
})

test("rename preserves an external worktree parent, including repeated namespaced renames", () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const external = mkdtempSync(join(tmpdir(), "wf-external-"))
  const original = join(external, "custom-folder")
  execOk(["git", "worktree", "add", "-b", "agent/old-name", original], { cwd: repo })
  writeFileSync(join(original, "local.txt"), "keep me")
  for (const newName of ["agent/fix-login", "agent/fix-session", "plain-name"]) {
    const tree = listWorktrees(repo).find((row) => !row.isMain)!
    const renamed = renameWorktree({ repoPath: repo, tree, newName, home, projectId: "demo" })
    const expected = join(external, newName.split("/").at(-1)!)
    expect(samePath(renamed.path, expected)).toBe(true)
    expect(listWorktrees(repo).find((row) => !row.isMain)?.branch).toBe(newName)
    expect(existsSync(join(expected, "local.txt"))).toBe(true)
    expect(existsSync(tree.path)).toBe(false)
    expect(existsSync(join(home, "trees"))).toBe(false)
  }
})

test("rename rejects an occupied sibling without changing the branch or moving the worktree", () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "original" })
  mkdirSync(join(tree.path, "..", "occupied"))
  expect(() => renameWorktree({ repoPath: repo, tree, newName: "agent/occupied", home, projectId: "demo" })).toThrow("already exists")
  expect(existsSync(tree.path)).toBe(true)
  expect(listWorktrees(repo).find((row) => !row.isMain)?.branch).toBe("original")
})
