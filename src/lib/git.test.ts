import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execOk } from "./exec.ts"
import {
  createWorktree,
  isDirty,
  listBranches,
  listWorktrees,
  mainWorktreeBranch,
  parseWorktreeList,
  pullWorktree,
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

test("createWorktree branches from the chosen source", () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  execOk(["git", "checkout", "-b", "release"], { cwd: repo })
  writeFileSync(join(repo, "release.txt"), "from release\n")
  execOk(["git", "add", "."], { cwd: repo })
  execOk(["git", "commit", "-m", "release"], { cwd: repo })
  execOk(["git", "checkout", "main"], { cwd: repo })
  expect(mainWorktreeBranch(repo)).toBe("main")
  expect(listBranches(repo)).toEqual(["main", "release"])

  const created = createWorktree({ repoPath: repo, home, projectId: "demo", name: "from-release", startPoint: "release" })
  expect(created.branch).toBe("from-release")
  expect(existsSync(join(created.path, "release.txt"))).toBe(true)
  expect(existsSync(join(created.path, "README.md"))).toBe(true)

  expect(() => createWorktree({
    repoPath: repo,
    home,
    projectId: "demo",
    name: "missing-source",
    startPoint: "no-such-branch",
  })).toThrow('Source branch "no-such-branch" does not exist')
})

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
    renameFolder: true,
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
    const renamed = renameWorktree({ repoPath: repo, tree, newName, renameFolder: true, home, projectId: "demo" })
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
  expect(() => renameWorktree({ repoPath: repo, tree, newName: "agent/occupied", renameFolder: true, home, projectId: "demo" })).toThrow("already exists")
  expect(existsSync(tree.path)).toBe(true)
  expect(listWorktrees(repo).find((row) => !row.isMain)?.branch).toBe("original")
})


test("rename defaults to branch only even when a sibling folder has the new name", () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "original" })
  mkdirSync(join(tree.path, "..", "occupied"))
  writeFileSync(join(tree.path, "local.txt"), "keep me")
  const renamed = renameWorktree({ repoPath: repo, tree, newName: "agent/occupied", home, projectId: "demo" })
  expect(renamed.path).toBe(tree.path)
  expect(renamed.branch).toBe("agent/occupied")
  expect(listWorktrees(repo).find((row) => row.path === tree.path)?.branch).toBe("agent/occupied")
  expect(existsSync(join(tree.path, "local.txt"))).toBe(true)
})

test("pullWorktree fast-forwards that worktree and leaves the main checkout behind", async () => {
  const origin = initRepo()
  const clone = mkdtempSync(join(tmpdir(), "wf-clone-"))
  rmSync(clone, { recursive: true })
  execOk(["git", "clone", origin, clone])
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: clone, home, projectId: "demo", name: "feature-pull" })
  execOk(["git", "branch", "--set-upstream-to=origin/main"], { cwd: tree.path })
  writeFileSync(join(origin, "remote.txt"), "from origin\n")
  execOk(["git", "add", "."], { cwd: origin })
  execOk(["git", "commit", "-m", "remote"], { cwd: origin })

  const output = await pullWorktree(tree)
  expect(output.toLowerCase()).toContain("fast-forward")
  expect(existsSync(join(tree.path, "remote.txt"))).toBe(true)
  expect(existsSync(join(clone, "remote.txt"))).toBe(false)

  const main = listWorktrees(clone).find((row) => row.isMain)!
  const mainOutput = await pullWorktree(main)
  expect(mainOutput.toLowerCase()).toContain("fast-forward")
  expect(existsSync(join(clone, "remote.txt"))).toBe(true)
})

test("pullWorktree rejects a detached worktree and a branch with no upstream", async () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feature-pull" })
  await expect(pullWorktree({ ...tree, branch: null })).rejects.toThrow("no branch to pull")
  await expect(pullWorktree(tree)).rejects.toThrow(/no tracking information/i)
})

function withEnv(updates: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(updates)) previous.set(key, process.env[key])
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function trackSshBranch(repoPath: string, branch: string): void {
  execOk(["git", "remote", "add", "origin", "ssh://git@example.invalid/repo.git"], { cwd: repoPath })
  execOk(["git", "config", `branch.${branch}.remote`, "origin"], { cwd: repoPath })
  execOk(["git", "config", `branch.${branch}.merge`, "refs/heads/main"], { cwd: repoPath })
}

test("pullWorktree ignores inherited repository location variables", async () => {
  const origin = initRepo()
  const clone = mkdtempSync(join(tmpdir(), "wf-clone-"))
  rmSync(clone, { recursive: true })
  execOk(["git", "clone", origin, clone])
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: clone, home, projectId: "demo", name: "feature-pull" })
  execOk(["git", "branch", "--set-upstream-to=origin/main"], { cwd: tree.path })
  writeFileSync(join(origin, "remote.txt"), "from origin\n")
  execOk(["git", "add", "."], { cwd: origin })
  execOk(["git", "commit", "-m", "remote"], { cwd: origin })

  await withEnv({
    GIT_DIR: join(origin, ".git"),
    GIT_WORK_TREE: origin,
    GIT_INDEX_FILE: join(clone, "missing-index"),
  }, async () => {
    const output = await pullWorktree(tree)
    expect(output.toLowerCase()).toContain("fast-forward")
  })
  expect(existsSync(join(tree.path, "remote.txt"))).toBe(true)
  expect(existsSync(join(clone, "remote.txt"))).toBe(false)
})

test("pullWorktree appends BatchMode and keeps a configured SSH command", async () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feature-pull" })
  const dir = mkdtempSync(join(tmpdir(), "wf-ssh-"))
  const log = join(dir, "ssh.log")
  const script = join(dir, "ssh-wrap")
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`)
  chmodSync(script, 0o755)
  execOk(["git", "config", "core.sshCommand", "ssh -o IdentityFile=/tmp/should-not-run"], { cwd: tree.path })
  trackSshBranch(tree.path, "feature-pull")

  await withEnv({ GIT_SSH_COMMAND: `${script} -o IdentitiesOnly=yes`, GIT_SSH: undefined }, async () => {
    await expect(pullWorktree(tree)).rejects.toThrow()
  })
  const logged = readFileSync(log, "utf8")
  expect(logged).toContain("IdentitiesOnly=yes")
  expect(logged).toContain("BatchMode=yes")
  expect(logged).not.toContain("should-not-run")
})

test("pullWorktree appends BatchMode to core.sshCommand when no SSH env is set", async () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feature-pull" })
  const dir = mkdtempSync(join(tmpdir(), "wf-ssh-"))
  const log = join(dir, "ssh.log")
  const script = join(dir, "ssh-wrap")
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`)
  chmodSync(script, 0o755)
  execOk(["git", "config", "core.sshCommand", `${script} -o IdentitiesOnly=yes`], { cwd: tree.path })
  trackSshBranch(tree.path, "feature-pull")

  await withEnv({ GIT_SSH_COMMAND: undefined, GIT_SSH: undefined }, async () => {
    await expect(pullWorktree(tree)).rejects.toThrow()
  })
  const logged = readFileSync(log, "utf8")
  expect(logged).toContain("IdentitiesOnly=yes")
  expect(logged).toContain("BatchMode=yes")
})

test("pullWorktree stops a hung pull on timeout", async () => {
  const repo = initRepo()
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feature-pull" })
  const dir = mkdtempSync(join(tmpdir(), "wf-ssh-"))
  const script = join(dir, "ssh-hang")
  writeFileSync(script, "#!/bin/sh\nsleep 30\n")
  chmodSync(script, 0o755)
  trackSshBranch(tree.path, "feature-pull")

  const started = Date.now()
  await withEnv({ GIT_SSH_COMMAND: script }, async () => {
    await expect(pullWorktree(tree, { timeoutMs: 500 })).rejects.toThrow("git pull timed out after 500ms")
  })
  expect(Date.now() - started).toBeLessThan(5000)
})
