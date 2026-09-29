import { git, gitOk, listBranches } from "./git.ts"
import { execAsync, execOkAsync } from "./exec.ts"

export type SourceBranch = { branch: string; evidence: "saved" | "reflog" | "inferred" }
export type PullRequestState = "OPEN" | "MERGED" | "CLOSED"
export type PullRequest = { number: number; url: string; base: string; state?: PullRequestState }

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
  return { number: pr.number!, url: pr.url, base: pr.base,
    ...(pr.state === "OPEN" || pr.state === "MERGED" || pr.state === "CLOSED" ? { state: pr.state } : {}) }
}
export function savePullRequest(cwd: string, branch: string, pr: PullRequest): void {
  if (!parsePullRequest(pr)) throw new Error("Invalid pull request link")
  gitOk(cwd, ["config", "--local", `branch.${branch}.workforest-pr`, JSON.stringify({ ...pr, state: pr.state ?? "OPEN" })])
}
export async function loadPullRequest(cwd: string, branch: string | null): Promise<PullRequest | null> {
  if (!branch) return null
  const result = await execAsync(["git", "config", "--local", "--get", `branch.${branch}.workforest-pr`], { cwd })
  try {
    const pr = parsePullRequest(JSON.parse(result.stdout))
    return pr ? { ...pr, state: pr.state ?? "OPEN" } : null
  } catch { return null }
}

export function savePullRequestState(cwd: string, branch: string, pr: PullRequest, state: PullRequestState): void {
  const key = `branch.${branch}.workforest-pr`
  const result = git(cwd, ["config", "--local", "--get", key])
  let current: PullRequest | null = null
  try { current = parsePullRequest(JSON.parse(result.stdout)) } catch { /* Ignore missing metadata. */ }
  if (!current || current.url !== pr.url || current.state === state) return
  gitOk(cwd, ["config", "--local", key, JSON.stringify({ ...current, state })])
}

export async function loadPullRequestState(cwd: string, pr: PullRequest): Promise<PullRequestState | null> {
  try {
    const result = await execAsync(["gh", "pr", "view", pr.url, "--json", "url,state"], {
      cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 10000,
    })
    if (result.exitCode !== 0 || result.timedOut) return null
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== "object") return null
    const { url, state } = value as { url?: unknown; state?: unknown }
    return url === pr.url && (state === "OPEN" || state === "MERGED" || state === "CLOSED") ? state : null
  } catch { return null }
}

export async function mergePullRequest(cwd: string, pr: PullRequest): Promise<PullRequestState | null> {
  const state = await loadPullRequestState(cwd, pr)
  if (state !== "OPEN") throw new Error(state ? `PR #${pr.number} is ${state.toLowerCase()}` : `Could not verify PR #${pr.number} is open`)
  await execOkAsync(["gh", "pr", "merge", pr.url, "--merge"], {
    cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 5 * 60 * 1000,
  })
  return loadPullRequestState(cwd, pr)
}
