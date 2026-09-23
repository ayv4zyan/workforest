import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAutoRename, normalizeAutoRename, type AutoRenameSettings } from "./auto-rename-settings.ts"
import { defaultStartPoint, git, gitOk, validateName } from "./git.ts"
import type { GitWorktree } from "./types.ts"

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text

export function renameContext(repoPath: string, tree: GitWorktree): string {
  if (tree.isMain) throw new Error("Cannot auto-rename the main worktree")
  if (!tree.branch) throw new Error("Cannot auto-rename a detached worktree")
  const start = defaultStartPoint(repoPath)
  const ref = git(repoPath, ["rev-parse", "--verify", `refs/heads/${start}`])
  const baseRef = ref.exitCode === 0 ? ref.stdout.trim() : gitOk(repoPath, ["rev-parse", "HEAD"]).trim()
  const base = gitOk(tree.path, ["merge-base", "HEAD", baseRef]).trim()
  const diff = (args: string[]) => gitOk(tree.path, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...args, "--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"])
  const committed = diff([`${base}..HEAD`])
  const staged = diff(["--cached"])
  const unstaged = diff([])
  const untracked = gitOk(tree.path, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"])
  if (![committed, staged, unstaged, untracked].some((part) => part.trim())) {
    throw new Error("No changes to name: this worktree matches its base")
  }
  return [
    `Current name: ${tree.branch}`,
    `Committed changes since branching from ${start}:\n${clip(committed, 24000)}`,
    `Staged changes:\n${clip(staged, 16000)}`,
    `Unstaged changes:\n${clip(unstaged, 16000)}`,
    `Untracked filenames (contents not included):\n${clip(untracked, 8000)}`,
  ].join("\n\n")
}

export function parseSuggestedName(output: string): string {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error("Codex returned an invalid name response. Try auto-rename again.")
  }
  const name = (value as { name?: unknown } | null)?.name
  if (typeof name !== "string" || name.length > 64 || !/^agent\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Codex returned an invalid worktree name. Try auto-rename again.")
  }
  return name
}

export async function suggestWorktreeName(repoPath: string, tree: GitWorktree, signal?: AbortSignal, settings?: AutoRenameSettings): Promise<string> {
  const context = renameContext(repoPath, tree)
  const resolved = normalizeAutoRename(settings ?? defaultAutoRename())
  const instructions = resolved.prompt
  const executable = Bun.which("codex", { PATH: process.env.PATH })
  if (!executable) throw new Error("Codex CLI not found. Install Codex and run codex login first.")
  signal?.throwIfAborted()
  const dir = mkdtempSync(join(tmpdir(), "workforest-rename-"))
  try {
    const output = join(dir, "name.json")
    const schema = join(dir, "schema.json")
    writeFileSync(schema, JSON.stringify({
      type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false,
    }))
    const prompt = `${instructions}\n${context}`
    const child = Bun.spawn([
      executable, "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", "read-only", "--model", resolved.model,
      "-c", `model_reasoning_effort="${resolved.reasoning}"`, "--color", "never",
      "--output-schema", schema, "--output-last-message", output, "-",
    ], { cwd: dir, stdin: new Blob([prompt]), stdout: "ignore", stderr: "pipe" })
    const abort = () => child.kill()
    signal?.addEventListener("abort", abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 120000)
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      signal?.throwIfAborted()
      if (timedOut) throw new Error("Codex auto-rename timed out. Try again.")
      if (code !== 0) throw new Error(`Codex auto-rename failed: ${clip(stderr.trim(), 600) || `exit ${code}`}`)
      const name = parseSuggestedName(readFileSync(output, "utf8"))
      validateName(repoPath, name)
      return name
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
