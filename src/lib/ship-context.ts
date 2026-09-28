import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { execOkAsync } from "./exec.ts"
import { gitNetworkEnv } from "./git.ts"

const paths = ["--", ".", ":(exclude,glob)**/.env", ":(exclude,glob)**/.env.*"]
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n[truncated; inspect the remaining changes before claiming a complete review]` : text

// Supply actual evidence even when a custom writing prompt forbids tool use.
export async function collectShipContext(options: {
  cwd: string
  baseRef: string
  validation?: string
  signal?: AbortSignal
}): Promise<string> {
  const { cwd, signal } = options
  const env = gitNetworkEnv(cwd)
  const git = (args: string[]) => execOkAsync(["git", ...args], { cwd, env, signal, timeoutMs: 30000 })
  const base = (await git(["rev-parse", "--verify", "--end-of-options", `${options.baseRef}^{commit}`])).trim()
  const mergeBase = (await git(["merge-base", "HEAD", base])).trim()
  const diff = (args: string[]) => git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...args, ...paths])
  const [head, status, commits, summary, committed, staged, unstaged, untrackedNames] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["status", "--short", ...paths]),
    git(["log", "--format=%h %s", `${mergeBase}..HEAD`, ...paths]),
    diff(["--stat", mergeBase]),
    diff([`${mergeBase}..HEAD`]),
    diff(["--cached"]),
    diff([]),
    git(["ls-files", "--others", "--exclude-standard", "-z", ...paths]),
  ])
  let remaining = 32000
  const root = realpathSync(cwd)
  const untracked = untrackedNames.split("\0").filter(Boolean).map((name) => {
    const file = resolve(root, name)
    try {
      const rel = relative(root, realpathSync(file))
      if (isAbsolute(rel) || rel.startsWith("..") || !lstatSync(file).isFile()) return `${JSON.stringify(name)}: contents omitted (not a regular file inside the worktree)`
      if (remaining <= 0) return `${JSON.stringify(name)}: contents omitted (context limit)`
      const fd = openSync(file, "r")
      try {
        const bytes = Buffer.alloc(Math.min(8000, remaining) + 1)
        const count = readSync(fd, bytes)
        const content = bytes.subarray(0, count)
        if (content.includes(0)) return `${JSON.stringify(name)}: binary contents omitted`
        const text = clip(content.toString("utf8"), Math.min(8000, remaining))
        remaining -= count
        return `${JSON.stringify(name)}:\n${text}`
      } finally { closeSync(fd) }
    } catch { return `${JSON.stringify(name)}: contents unavailable; inspect before describing` }
  }).join("\n\n")
  return [
    `HEAD: ${head.trim()}\nPR target commit: ${base}\nMerge base: ${mergeBase}`,
    `Status (excluding .env secrets):\n${status.trim() || "clean"}`,
    `Branch commits since merge base:\n${clip(commits, 12000) || "none"}`,
    `Changes summary:\n${clip(summary, 12000) || "none"}`,
    `Committed branch diff (FULL PR scope, not just uncommitted work):\n${clip(committed, 120000) || "none"}`,
    `Staged diff:\n${clip(staged, 32000) || "none"}`,
    `Unstaged diff:\n${clip(unstaged, 32000) || "none"}`,
    `Untracked file contents:\n${clip(untracked, 40000) || "none"}`,
    `Observed validation from THIS Ship run:\n${options.validation || "No validation commands have run yet. Do not claim tests passed."}`,
  ].join("\n\n")
}
