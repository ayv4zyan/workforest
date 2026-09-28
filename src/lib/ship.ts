import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execAsync, execOkAsync } from "./exec.ts"
import { git, gitNetworkEnv } from "./git.ts"
import { parsePullRequest, savePullRequest, type PullRequest } from "./branch-metadata.ts"
import { runShipAgent, type ShipAgentRequest, type ShipPlan } from "./ship-agent.ts"
import type { ShipSettings } from "./ship-settings.ts"
import type { GitWorktree } from "./types.ts"

// Trace2 identifies a real hook failure without replacing or bypassing the hook.
export function prePushFailed(trace: string): boolean {
  const hooks = new Set<string>()
  for (const line of trace.split("\n")) {
    try {
      const event = JSON.parse(line)
      const id = `${event.sid}:${event.child_id}`
      if (event.event === "child_start" && event.hook_name === "pre-push") hooks.add(id)
      if (event.event === "child_exit" && hooks.has(id) && event.code !== 0) return true
    } catch { /* Ignore incomplete trace records. */ }
  }
  return false
}

export async function shipWorktree(options: {
  tree: GitWorktree
  base: string
  settings: ShipSettings
  onProgress: (text: string) => void
  signal?: AbortSignal
  agent?: (request: ShipAgentRequest) => Promise<ShipPlan>
}): Promise<PullRequest> {
  const { tree, base, settings, signal, onProgress } = options
  const branch = tree.branch
  if (!branch || tree.detached) throw new Error("Detached worktree cannot be shipped")
  if (!base || base === branch || git(tree.path, ["check-ref-format", "--branch", base]).exitCode !== 0) throw new Error("Choose a different target branch")
  const cwd = tree.path
  const env: Record<string, string> = { ...gitNetworkEnv(cwd), GH_PROMPT_DISABLED: "1", GH_EDITOR: "true" }
  // A caller's hook-bypass environment must not silently disable quality checks.
  delete env.HUSKY
  delete env.SKIP
  delete env.LEFTHOOK
  delete env.LEFTHOOK_EXCLUDE
  const command = (args: string[]) => execOkAsync(args, { cwd, env, signal, timeoutMs: 10 * 60 * 1000 })
  const gitCommand = (args: string[]) => command(["git", ...args])
  const config = (key: string) => git(cwd, ["config", "--get", key]).stdout.trim()
  const remote = config(`branch.${branch}.pushRemote`) || config("remote.pushDefault") || config(`branch.${branch}.remote`) || "origin"
  if (remote === "." || remote.startsWith("-")) throw new Error("Ship needs a named remote repository")
  const remoteUrls = (await gitCommand(["remote", "get-url", "--push", "--all", remote])).trim().split("\n")
  if (remoteUrls.length !== 1) throw new Error("Ship requires a remote with one push URL")
  const remoteUrl = remoteUrls[0]!
  const assertBranch = async () => {
    if ((await gitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() !== branch) throw new Error("Branch changed while shipping; stopped")
    if ((await gitCommand(["ls-files", "-u"])).trim()) throw new Error("Resolve merge conflicts before shipping")
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      if (existsSync((await gitCommand(["rev-parse", "--path-format=absolute", "--git-path", name])).trim())) throw new Error("Finish the in-progress Git operation before shipping")
    }
  }
  await assertBranch()
  // Preflight authentication, repository and target before making any commits.
  const repo = JSON.parse(await command(["gh", "repo", "view", remoteUrl, "--json", "url"])) as { url: string }
  if (typeof repo.url !== "string" || !repo.url.startsWith("https://")) throw new Error("GitHub returned an invalid repository URL")
  await gitCommand(["ls-remote", "--exit-code", remote, `refs/heads/${base}`])
  const listPR = async () => {
    const rows: unknown = JSON.parse(await command(["gh", "pr", "list", "--repo", repo.url, "--head", branch, "--state", "open", "--json", "number,url,baseRefName"]))
    if (!Array.isArray(rows)) throw new Error("GitHub returned invalid pull requests")
    return rows.map((row) => {
      const pr = parsePullRequest({ ...row, base: row.baseRefName })
      if (!pr || !pr.url.startsWith(`${repo.url}/pull/`)) throw new Error("GitHub returned an invalid pull request")
      return pr
    })
  }
  let existing = await listPR()
  if (existing.length > 1) throw new Error("Multiple open PRs for this branch; resolve them before shipping")
  if (existing[0] && existing[0].base !== base) throw new Error(`PR #${existing[0].number} targets ${existing[0].base}. Choose that target to update it.`)
  const dir = mkdtempSync(join(tmpdir(), "workforest-ship-"))
  try {
    const agent = options.agent ?? runShipAgent
    const head = async () => (await gitCommand(["rev-parse", "HEAD"])).trim()
    const status = async () => (await gitCommand(["status", "--porcelain"])).trim()
    const ask = async (phase: ShipAgentRequest["phase"], failure?: string, attempt?: number) => {
      await assertBranch()
      const before = await head()
      const result = await agent({ cwd, branch, base, settings, phase, failure, attempt, signal, onProgress })
      signal?.throwIfAborted()
      await assertBranch()
      if (await head() !== before) throw new Error("HEAD changed during AI work; stopped to preserve commit history")
      return result
    }
    const commit = async (plan: ShipPlan) => {
      await assertBranch()
      onProgress(plan.commitStatus)
      await gitCommand(["add", "--all", "--", "."])
      writeFileSync(join(dir, "commit.txt"), plan.commitMessage)
      await gitCommand(["commit", "--file", join(dir, "commit.txt")])
      if (await status()) throw new Error("Files changed during commit; review the remaining changes before shipping again")
    }
    let plan = await ask("prepare")
    if (await status()) {
      // No repair is permitted until the user's original work is committed.
      try { await commit(plan) } catch (error) {
        throw new Error(`Could not commit user changes; no AI repairs were made. ${error instanceof Error ? error.message : error}`)
      }
    }
    let repairs = 0
    while (true) {
      await assertBranch()
      if (await status()) throw new Error("New uncommitted changes appeared during Ship; review them before retrying")
      const pushedHead = await head()
      onProgress(plan.pushStatus)
      const tracePath = join(dir, `push-${repairs}.jsonl`)
      const push = await execAsync(["git", "push", "--set-upstream", remote, `refs/heads/${branch}:refs/heads/${branch}`], {
        cwd, signal, env: { ...env, GIT_TRACE2_EVENT: tracePath }, timeoutMs: 10 * 60 * 1000,
      })
      if (push.timedOut) throw new Error("Push timed out; commits have been kept")
      if (await head() !== pushedHead) throw new Error("Commits changed during push; review them before retrying")
      if (push.exitCode === 0) {
        if (await status()) throw new Error("Files changed during push; review them before retrying")
        break
      }
      const failure = `${push.stdout}\n${push.stderr}`.trim()
      const hookFailed = existsSync(tracePath) && prePushFailed(readFileSync(tracePath, "utf8"))
      if (!hookFailed) throw new Error(`Push failed; no AI repairs attempted: ${failure.slice(-1500)}`)
      if (repairs >= 3) throw new Error(`Pre-push checks still fail after 3 repair attempts. All commits kept. ${failure.slice(-1500)}`)
      plan = await ask("repair", failure, ++repairs)
      if (await status()) await commit(plan)
      // A repair can fix local dependencies without changing tracked files.
    }
    if (repairs) plan = await ask("describe")
    onProgress(plan.prStatus)
    existing = await listPR()
    if (existing.length > 1 || existing[0] && existing[0].base !== base) throw new Error("Open PR target changed during Ship; pushed commits have been kept")
    let pr = existing[0]
    if (!pr) {
      writeFileSync(join(dir, "pr.md"), plan.body)
      await command(["gh", "pr", "create", "--repo", repo.url, "--head", branch, "--base", base, "--title", plan.title, "--body-file", join(dir, "pr.md")])
      pr = (await listPR()).find((row) => row.base === base)
      if (!pr) throw new Error("PR creation completed but its link could not be retrieved; Ship again to recover it")
    }
    savePullRequest(cwd, branch, pr)
    return pr
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
