import { git, gitOk, listBranches } from "./git.ts"
import { execAsync } from "./exec.ts"

export type SourceBranch = { branch: string; evidence: "saved" | "reflog" | "inferred" }
export type PullRequest = { number: number; url: string; base: string }

export function targetBranches(cwd: string, branch: string): string[] {
  const remotes = gitOk(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
    .split("\n").filter((name) => name && !name.endsWith("/HEAD"))
    .map((name) => name.slice(name.indexOf("/") + 1))
  return [...new Set([...listBranches(cwd), ...remotes])].filter((name) => name !== branch).sort()
}

export function sourceBranch(cwd: string, branch: string, candidates = targetBranches(cwd, branch)): SourceBranch | null {
  const normalize = (ref: string) => {
    const value = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "")
    if (candidates.includes(value)) return value
    const remote = value.slice(value.indexOf("/") + 1)
    return value.includes("/") && candidates.includes(remote) ? remote : null
  }
  const stored = git(cwd, ["config", "--local", "--get", `branch.${branch}.workforest-source`])
  if (stored.exitCode === 0) {
    const saved = normalize(stored.stdout.trim())
    if (saved) return { branch: saved, evidence: "saved" }
  }
  const log = git(cwd, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`])
  for (const line of log.stdout.split("\n").reverse()) {
    const match = /^branch: Created from (.+)$/.exec(line)
    const name = match && normalize(match[1]!)
    if (name) return { branch: name, evidence: "reflog" }
  }
  // Suggest only a unique closest merge-base; equal candidates are ambiguous.
  const scored = candidates.flatMap((name) => {
    const ref = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).exitCode === 0
      ? `refs/heads/${name}` : `refs/remotes/origin/${name}`
    const base = git(cwd, ["merge-base", `refs/heads/${branch}`, ref])
    if (base.exitCode !== 0) return []
    const distance = git(cwd, ["rev-list", "--count", `${base.stdout.trim()}..refs/heads/${branch}`])
    return distance.exitCode === 0 ? [{ branch: name, distance: Number(distance.stdout.trim()) }] : []
  }).sort((a, b) => a.distance - b.distance)
  const first = scored[0]
  return first && first.distance < (scored[1]?.distance ?? Infinity) ? { branch: first.branch, evidence: "inferred" } : null
}

export function parsePullRequest(value: unknown): PullRequest | null {
  if (!value || typeof value !== "object") return null
  const pr = value as Partial<PullRequest>
  if (!Number.isSafeInteger(pr.number) || pr.number! <= 0 || typeof pr.url !== "string" || typeof pr.base !== "string") return null
  try {
    const url = new URL(pr.url)
    if (url.protocol !== "https:" || url.username || url.password || !url.pathname.endsWith(`/pull/${pr.number}`)) return null
  } catch { return null }
  return pr as PullRequest
}
export function savePullRequest(cwd: string, branch: string, pr: PullRequest): void {
  if (!parsePullRequest(pr)) throw new Error("Invalid pull request link")
  gitOk(cwd, ["config", "--local", `branch.${branch}.workforest-pr`, JSON.stringify(pr)])
}
export async function loadPullRequest(cwd: string, branch: string | null): Promise<PullRequest | null> {
  if (!branch) return null
  const result = await execAsync(["git", "config", "--local", "--get", `branch.${branch}.workforest-pr`], { cwd })
  try { return parsePullRequest(JSON.parse(result.stdout)) } catch { return null }
}
