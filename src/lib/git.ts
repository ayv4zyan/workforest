import { mkdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { exec, execOk } from "./exec.ts"
import { projectTreesDir } from "./home.ts"
import { isWorktreeName } from "./slug.ts"
import type { GitWorktree } from "./types.ts"

export function git(cwd: string, args: string[]): ReturnType<typeof exec> {
  return exec(["git", ...args], { cwd })
}

export function gitOk(cwd: string, args: string[]): string {
  return execOk(["git", ...args], { cwd })
}

export function isGitRepo(path: string): boolean {
  const result = git(path, ["rev-parse", "--is-inside-work-tree"])
  return result.exitCode === 0 && result.stdout.trim() === "true"
}

export function repoRoot(path: string): string {
  return gitOk(path, ["rev-parse", "--show-toplevel"]).trim()
}

export function parseWorktreeList(stdout: string): GitWorktree[] {
  const blocks = stdout.replace(/\n+$/, "").split("\n\n").filter((block) => block.trim().length > 0)
  return blocks.map((block, index) => {
    const tree: GitWorktree = {
      path: "",
      head: "",
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: index === 0,
    }
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) tree.path = line.slice("worktree ".length)
      else if (line.startsWith("HEAD ")) tree.head = line.slice("HEAD ".length)
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length)
        tree.branch = ref.replace(/^refs\/heads\//, "")
      } else if (line === "bare") tree.bare = true
      else if (line === "detached") tree.detached = true
      else if (line.startsWith("locked")) tree.locked = true
      else if (line.startsWith("prunable")) tree.prunable = true
    }
    return tree
  })
}

export function listWorktrees(repoPath: string): GitWorktree[] {
  const stdout = gitOk(repoPath, ["worktree", "list", "--porcelain"])
  return parseWorktreeList(stdout)
}

export function isDirty(worktreePath: string): boolean {
  const stdout = gitOk(worktreePath, ["status", "--porcelain"])
  return stdout.trim().length > 0
}

export function defaultStartPoint(repoPath: string): string {
  const originHead = git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (originHead.exitCode === 0) {
    return originHead.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
  }
  for (const name of ["main", "master"]) {
    const probe = git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])
    if (probe.exitCode === 0) return name
  }
  return gitOk(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
}

export function branchExists(repoPath: string, name: string): boolean {
  return git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).exitCode === 0
}

export function validateName(repoPath: string, name: string): void {
  if (!isWorktreeName(name)) {
    throw new Error(`Invalid worktree name "${name}"`)
  }
  const check = git(repoPath, ["check-ref-format", "--branch", name])
  if (check.exitCode !== 0) {
    throw new Error(check.stderr.trim() || `Invalid branch name "${name}"`)
  }
}

export function worktreeDisplayName(tree: GitWorktree): string {
  if (tree.isMain) return "main"
  if (tree.branch) return tree.branch
  return basename(tree.path)
}

export function samePath(a: string, b: string): boolean {
  const resolveExisting = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return resolveExisting(a) === resolveExisting(b)
}

export function createWorktree(opts: {
  repoPath: string
  home: string
  projectId: string
  name: string
}): GitWorktree {
  const { repoPath, home, projectId, name } = opts
  validateName(repoPath, name)
  const dest = join(projectTreesDir(home, projectId), name)
  mkdirSync(dirname(dest), { recursive: true })
  if (listWorktrees(repoPath).some((tree) => samePath(tree.path, dest))) {
    throw new Error(`Worktree already exists at ${dest}`)
  }
  if (branchExists(repoPath, name)) {
    gitOk(repoPath, ["worktree", "add", dest, name])
  } else {
    gitOk(repoPath, ["worktree", "add", "-b", name, dest, defaultStartPoint(repoPath)])
  }
  const listed = listWorktrees(repoPath).find(
    (tree) => samePath(tree.path, dest) || (!tree.isMain && tree.branch === name),
  )
  if (!listed) throw new Error("Worktree was created but could not be listed")
  return listed
}

export function renameWorktree(opts: {
  repoPath: string
  tree: GitWorktree
  newName: string
  home: string
  projectId: string
}): { path: string; branch: string | null } {
  const { repoPath, tree, newName, home, projectId } = opts
  if (tree.isMain) throw new Error("Cannot rename the main worktree")
  validateName(repoPath, newName)
  const dest = join(projectTreesDir(home, projectId), newName)
  if (tree.branch && tree.branch !== newName && branchExists(repoPath, newName)) {
    throw new Error(`Branch "${newName}" already exists`)
  }
  if (tree.branch && tree.branch !== newName) {
    gitOk(tree.path, ["branch", "-m", newName])
  }
  if (tree.path !== dest) {
    gitOk(repoPath, ["worktree", "move", tree.path, dest])
  }
  return { path: dest, branch: newName }
}

export function removeWorktree(opts: { repoPath: string; tree: GitWorktree; force?: boolean }): void {
  const { repoPath, tree, force } = opts
  if (tree.isMain) throw new Error("Cannot delete the main worktree")
  const args = ["worktree", "remove"]
  if (force) args.push("--force")
  args.push(tree.path)
  gitOk(repoPath, args)
}
