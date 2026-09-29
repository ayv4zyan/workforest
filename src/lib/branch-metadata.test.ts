import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergePullRequest, type PullRequest } from "./branch-metadata.ts"

const roots: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(mode: "normal" | "blocked" | "behind" | "other" | "api-error") {
  const root = mkdtempSync(join(tmpdir(), "wf-merge-test-"))
  roots.push(root)
  const calls = join(root, "calls.jsonl")
  const merged = join(root, "merged")
  const script = join(root, "gh")
  writeFileSync(script, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ url: args[2], state: existsSync(${JSON.stringify(merged)}) ? "MERGED" : "OPEN" }))
} else if (args[0] === "pr" && args[1] === "merge") {
  const mode = ${JSON.stringify(mode)}
  if (mode === "normal") writeFileSync(${JSON.stringify(merged)}, "")
  else {
    const reason = mode === "behind" ? "the head branch is not up to date with the base branch"
      : mode === "other" ? "the merge commit cannot be cleanly created" : "the base branch policy prohibits the merge"
    console.error("Pull request is not mergeable: " + reason + ".")
    process.exit(1)
  }
} else if (args[0] === "api") {
  if (${JSON.stringify(mode)} === "api-error") {
    console.error("HTTP 403: user cannot bypass this rule")
    process.exit(1)
  }
  writeFileSync(${JSON.stringify(merged)}, "")
}
`)
  chmodSync(script, 0o755)
  process.env.PATH = `${root}:${originalPath}`
  const pr: PullRequest = { number: 42, url: "https://github.example.com/owner/repo/pull/42", base: "main" }
  return { root, calls, merged, pr }
}

function calls(path: string): string[][] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
}

test("a blocked PR uses the merge API so GitHub can apply ruleset bypass", async () => {
  const { root, calls: log, merged, pr } = fixture("blocked")
  expect(await mergePullRequest(root, pr)).toBe("MERGED")
  expect(existsSync(merged)).toBe(true)
  expect(calls(log)).toEqual([
    ["pr", "view", pr.url, "--json", "url,state"],
    ["pr", "merge", pr.url, "--merge"],
    ["api", "repos/owner/repo/pulls/42/merge", "--hostname", "github.example.com", "--method", "PUT", "-f", "merge_method=merge"],
    ["pr", "view", pr.url, "--json", "url,state"],
  ])
})

test("a branch that is behind can also use the ruleset bypass", async () => {
  const { root, calls: log, pr } = fixture("behind")
  expect(await mergePullRequest(root, pr)).toBe("MERGED")
  expect(calls(log).some((args) => args[0] === "api")).toBe(true)
})

test("a normal merge stays on the gh pr merge path", async () => {
  const { root, calls: log, pr } = fixture("normal")
  expect(await mergePullRequest(root, pr)).toBe("MERGED")
  expect(calls(log).some((args) => args[0] === "api")).toBe(false)
})

test("an unrelated merge failure does not attempt a bypass", async () => {
  const { root, calls: log, pr } = fixture("other")
  await expect(mergePullRequest(root, pr)).rejects.toThrow("the merge commit cannot be cleanly created")
  expect(calls(log).some((args) => args[0] === "api")).toBe(false)
})

test("GitHub's merge API remains the authority on bypass permission", async () => {
  const { root, pr } = fixture("api-error")
  await expect(mergePullRequest(root, pr)).rejects.toThrow("HTTP 403: user cannot bypass this rule")
})
