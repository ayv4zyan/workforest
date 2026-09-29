import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktree, gitOk, renameWorktree } from "./git.ts"
import { loadPullRequest, sourceBranch } from "./branch-metadata.ts"
import { defaultShip, loadShip, saveShip } from "./ship-settings.ts"
import { loadAutoRename, saveAutoRename } from "./auto-rename-settings.ts"
import { agentProgress, parseShipPlan, runShipAgent, type ShipAgentRequest } from "./ship-agent.ts"
import { prePushFailed, shipWorktree } from "./ship.ts"

const roots: string[] = []
const originalPath = process.env.PATH
const plan = { ready: true, blocker: "", commitMessage: "User feature", title: "Improve feature", body: "Feature changes and validation.", commitStatus: "saving feature work", pushStatus: "sending branch through checks", prStatus: "opening review" }
afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const root = mkdtempSync(join(tmpdir(), "wf-ship-test-"))
  roots.push(root)
  return root
}
function script(path: string, body: string) {
  writeFileSync(path, `#!${process.execPath}\n${body}`)
  chmodSync(path, 0o755)
}
function fixture() {
  const root = temp()
  const repo = join(root, "repo"), home = join(root, "home"), remote = join(root, "remote.git")
  mkdirSync(repo)
  gitOk(repo, ["init", "-b", "main"])
  gitOk(repo, ["config", "user.email", "wf@test"])
  gitOk(repo, ["config", "user.name", "wf"])
  gitOk(repo, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(repo, "app.txt"), "original")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "initial"])
  gitOk(root, ["init", "--bare", remote])
  gitOk(repo, ["remote", "add", "origin", remote])
  gitOk(repo, ["checkout", "-b", "develop"])
  writeFileSync(join(repo, "develop.txt"), "base")
  gitOk(repo, ["add", "."])
  gitOk(repo, ["commit", "-m", "develop work"])
  gitOk(repo, ["push", "origin", "main", "develop"])
  const tree = createWorktree({ repoPath: repo, home, projectId: "demo", name: "feature", startPoint: "develop" })
  const bin = join(root, "bin")
  mkdirSync(bin)
  const prFile = join(root, "prs.json"), calls = join(root, "gh-calls.jsonl")
  writeFileSync(prFile, "[]")
  script(join(bin, "gh"), `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[0] === 'repo') console.log(JSON.stringify({url:'https://github.com/test/demo'}))
else if (args[1] === 'list') console.log(await Bun.file(${JSON.stringify(prFile)}).text())
else if (args[1] === 'create') {
  const base = args[args.indexOf('--base') + 1]
  await Bun.write(${JSON.stringify(prFile)}, JSON.stringify([{number:450,url:'https://github.com/test/demo/pull/450',baseRefName:base,isCrossRepository:false}]))
  console.log('https://github.com/test/demo/pull/450')
}
`)
  process.env.PATH = `${bin}:${originalPath}`
  const hook = (body: string) => {
    const path = join(repo, ".git", "hooks", "pre-push")
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  return { root, repo, home, remote, tree, bin, prFile, calls, hook }
}

test("source metadata follows rename; reflog and unique history recover missing metadata", () => {
  const { repo, home, tree } = fixture()
  expect(sourceBranch(tree.path, "feature")).toEqual({ branch: "develop", evidence: "saved" })
  gitOk(repo, ["config", "--unset", "branch.feature.workforest-source"])
  expect(sourceBranch(tree.path, "feature")).toEqual({ branch: "develop", evidence: "reflog" })
  gitOk(repo, ["reflog", "expire", "--expire=now", "refs/heads/feature"])
  expect(sourceBranch(tree.path, "feature")).toEqual({ branch: "develop", evidence: "inferred" })
  gitOk(repo, ["branch", "equally-likely", "develop"])
  expect(sourceBranch(tree.path, "feature")).toBeNull()
  gitOk(repo, ["config", "branch.feature.workforest-source", "develop"])
  renameWorktree({ repoPath: repo, tree, newName: "renamed", home, projectId: "demo" })
  expect(sourceBranch(tree.path, "renamed")).toEqual({ branch: "develop", evidence: "saved" })
})

test("Ship settings are independent and survive Auto rename saves", () => {
  const home = temp()
  const rename = loadAutoRename(home)
  saveShip(home, { ...defaultShip(), prompt: "custom ship prompt" })
  saveAutoRename(home, { ...rename, prompt: "custom rename prompt" })
  expect(loadShip(home).prompt).toBe("custom ship prompt")
  expect(loadAutoRename(home).prompt).toBe("custom rename prompt")
  saveShip(home, { ...defaultShip(), prompt: "  " })
  expect(loadShip(home).prompt).toBe(defaultShip().prompt)
})

test("real pre-push failure gets a separate repair commit, retries hooks, and persists the PR", async () => {
  const { tree, repo, remote, hook, calls } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "broken user feature")
  hook('test "$(cat app.txt)" = "fixed feature" || { echo "quality check: app fails" >&2; exit 1; }')
  const phases: string[] = [], progress: string[] = []
  const agent = async (request: ShipAgentRequest) => {
    phases.push(request.phase)
    if (request.phase === "prepare") expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("original")
    if (request.phase === "repair") {
      expect(request.failure).toContain("quality check: app fails")
      expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("broken user feature")
      expect(gitOk(tree.path, ["status", "--porcelain"]).trim()).toBe("")
      writeFileSync(join(tree.path, "app.txt"), "fixed feature")
      request.onProgress("fixing app assertion")
    }
    return { ...plan, commitMessage: request.phase === "repair" ? "Fix app assertion" : plan.commitMessage }
  }
  const pr = await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: (text) => progress.push(text), agent })
  expect(pr.number).toBe(450)
  expect(phases).toEqual(["prepare", "repair", "describe"])
  expect(progress).toContain("fixing app assertion")
  expect(gitOk(tree.path, ["log", "--format=%s", "--reverse", "develop..HEAD"]).trim().split("\n")).toEqual(["User feature", "Fix app assertion"])
  expect(gitOk(remote, ["show", "feature:app.txt"])).toBe("fixed feature")
  expect(await loadPullRequest(tree.path, "feature")).toEqual({ ...pr, state: "OPEN" })
  expect(readFileSync(calls, "utf8")).toContain('"--base","develop"')
  expect(gitOk(repo, ["config", "--get", "branch.feature.workforest-source"]).trim()).toBe("develop")
  // Repeated Ship updates the existing branch/PR without empty commits or duplicate PRs.
  const repeatedPhases: string[] = []
  await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    repeatedPhases.push(request.phase)
    return plan
  } })
  expect(repeatedPhases).toEqual(["prepare"])
  expect(readFileSync(calls, "utf8").split('\n').filter((line) => line.includes('"create"'))).toHaveLength(1)
}, 20000)

test("three failed repair attempts stop and keep all commits without creating a PR", async () => {
  const { tree, hook, calls } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "user change")
  hook('echo "test fails" >&2; exit 1')
  let attempts = 0
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    if (request.phase === "repair") writeFileSync(join(tree.path, "app.txt"), `repair ${++attempts}`)
    return { ...plan, commitMessage: request.phase === "repair" ? `Fix attempt ${attempts}` : plan.commitMessage }
  } })).rejects.toThrow("after 3 repair attempts")
  expect(attempts).toBe(3)
  expect(gitOk(tree.path, ["rev-list", "--count", "develop..HEAD"]).trim()).toBe("4")
  expect(readFileSync(calls, "utf8")).not.toContain('"create"')
}, 20000)

test("remote rejection does not trigger AI repairs", async () => {
  const { tree, remote } = fixture()
  const hook = join(remote, "hooks", "pre-receive")
  writeFileSync(hook, '#!/bin/sh\necho "remote policy rejects push" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  writeFileSync(join(tree.path, "app.txt"), "user work")
  const phases: string[] = []
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    phases.push(request.phase)
    return plan
  } })).rejects.toThrow("no AI repairs attempted")
  expect(phases).toEqual(["prepare"])
  expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("user work")
}, 15000)

test("an existing PR with a different target stops before any commits", async () => {
  const { tree, prFile } = fixture()
  writeFileSync(prFile, JSON.stringify([{ number: 450, url: "https://github.com/test/demo/pull/450", baseRefName: "main", isCrossRepository: false }]))
  writeFileSync(join(tree.path, "app.txt"), "user work")
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => { throw new Error("must not run") } })).rejects.toThrow("targets main")
  expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("original")
})

test("Ship accepts an empty commit message when the branch is already committed", async () => {
  const { tree } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "committed feature")
  gitOk(tree.path, ["add", "app.txt"])
  gitOk(tree.path, ["commit", "-m", "Add committed feature"])
  const phases: string[] = []
  const pr = await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    phases.push(request.phase)
    return { ...plan, commitMessage: "" }
  } })
  expect(pr.number).toBe(450)
  expect(phases).toEqual(["prepare", "describe"])
  expect(gitOk(tree.path, ["log", "-1", "--format=%s"]).trim()).toBe("Add committed feature")
})

test("Ship requires a commit message before committing uncommitted changes", async () => {
  const { tree, calls } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "uncommitted feature")
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => ({ ...plan, commitMessage: "" }) })).rejects.toThrow("did not provide a commit message")
  expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("original")
  expect(gitOk(tree.path, ["status", "--porcelain"])).toBe(" M app.txt\n")
  expect(readFileSync(calls, "utf8")).not.toContain('"create"')
})

test.each([false, true])("fork PRs with the same branch name are ignored (own PR exists: %s)", async (ownPRExists) => {
  const { tree, prFile, calls } = fixture()
  const forkPRs = [
    { number: 100, url: "https://github.com/test/demo/pull/100", baseRefName: "main", isCrossRepository: true },
    { number: 101, url: "https://github.com/test/demo/pull/101", baseRefName: "develop", isCrossRepository: true },
  ]
  writeFileSync(prFile, JSON.stringify(ownPRExists ? [...forkPRs, { number: 450, url: "https://github.com/test/demo/pull/450", baseRefName: "develop", isCrossRepository: false }] : forkPRs))
  writeFileSync(join(tree.path, "app.txt"), "user feature")
  const pr = await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => plan })
  expect(pr.number).toBe(450)
  expect(await loadPullRequest(tree.path, "feature")).toEqual({ ...pr, state: "OPEN" })
  const ghCalls = readFileSync(calls, "utf8")
  expect(ghCalls).toContain("isCrossRepository")
  expect(ghCalls.includes('"create"')).toBe(!ownPRExists)
})

test.each(["untracked", "staged", "tracked"])("Ship preserves %s .env changes without committing or pushing them", async (kind) => {
  const { tree } = fixture()
  mkdirSync(join(tree.path, "nested"))
  const file = join(tree.path, kind === "untracked" ? ".env" : "nested/.env.local")
  if (kind === "tracked") {
    writeFileSync(file, "TEST_VALUE=old\n")
    gitOk(tree.path, ["add", "."])
    gitOk(tree.path, ["commit", "-m", "Existing environment fixture"])
  }
  writeFileSync(file, "TEST_VALUE=private\n")
  if (kind === "staged") gitOk(tree.path, ["add", "."])
  writeFileSync(join(tree.path, "app.txt"), "user work")
  const beforeHead = gitOk(tree.path, ["rev-parse", "HEAD"])
  const beforeStatus = gitOk(tree.path, ["status", "--porcelain"])
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => plan })).rejects.toThrow("Uncommitted .env files")
  expect(gitOk(tree.path, ["rev-parse", "HEAD"])).toBe(beforeHead)
  expect(gitOk(tree.path, ["status", "--porcelain"])).toBe(beforeStatus)
  expect(readFileSync(file, "utf8")).toBe("TEST_VALUE=private\n")
  expect(gitOk(tree.path, ["ls-remote", "origin", "refs/heads/feature"]).trim()).toBe("")
})

test("ignored .env files stay local while Ship publishes the feature", async () => {
  const { tree, remote } = fixture()
  writeFileSync(join(tree.path, ".gitignore"), ".env\n")
  writeFileSync(join(tree.path, ".env"), "TEST_VALUE=private\n")
  writeFileSync(join(tree.path, "app.txt"), "user feature")
  await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => plan })
  expect(gitOk(remote, ["show", "feature:app.txt"])).toBe("user feature")
  expect(gitOk(remote, ["ls-tree", "-r", "--name-only", "feature"])).not.toContain(".env")
  expect(readFileSync(join(tree.path, ".env"), "utf8")).toBe("TEST_VALUE=private\n")
})

test("a repair cannot automatically commit .env files either", async () => {
  const { tree, hook } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "user work")
  hook("exit 1")
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    if (request.phase === "repair") writeFileSync(join(tree.path, ".env.local"), "TEST_VALUE=private\n")
    return plan
  } })).rejects.toThrow("Uncommitted .env files")
  expect(gitOk(tree.path, ["rev-list", "--count", "develop..HEAD"]).trim()).toBe("1")
  expect(gitOk(tree.path, ["status", "--porcelain"]).trim()).toBe("?? .env.local")
  expect(gitOk(tree.path, ["ls-remote", "origin", "refs/heads/feature"]).trim()).toBe("")
})

test("Codex JSONL streams arbitrary AI statuses and uses scoped permissions", async () => {
  const { tree, bin, root } = fixture()
  const capture = join(root, "codex.json")
  script(join(bin, "codex"), `
const args = process.argv.slice(2)
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({args, prompt:await Bun.stdin.text()}))
const line = JSON.stringify({type:'item.completed', item:{type:'agent_message',text:'SHIP_STATUS: investigating checkout validation'}}) + '\\n'
process.stdout.write(line.slice(0, 30))
await Bun.sleep(25)
process.stdout.write(line.slice(30))
await Bun.write(args[args.indexOf('--output-last-message')+1], ${JSON.stringify(JSON.stringify(plan))})
`)
  const statuses: string[] = []
  const request: ShipAgentRequest = { cwd: tree.path, branch: "feature", base: "develop", settings: defaultShip(), phase: "repair", attempt: 1, failure: "a test failed", onProgress: (text) => statuses.push(text) }
  expect(await runShipAgent(request)).toEqual(plan)
  expect(statuses).toEqual(["investigating checkout validation"])
  const captureData = JSON.parse(readFileSync(capture, "utf8"))
  expect(captureData.args).toContain("workspace-write")
  expect(captureData.args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
  expect(captureData.prompt).toContain("ALREADY been committed")
  expect(captureData.prompt).toContain("SEPARATE fix commit")
  await runShipAgent({ ...request, phase: "prepare" })
  expect(JSON.parse(readFileSync(capture, "utf8")).args).toContain("read-only")
})

test("AI cancellation and timeout terminate work; malformed events never become progress", async () => {
  const { tree, bin } = fixture()
  script(join(bin, "codex"), 'await Bun.sleep(30000)')
  const controller = new AbortController()
  const request: ShipAgentRequest = { cwd: tree.path, branch: "feature", base: "develop", settings: defaultShip(), phase: "prepare", onProgress: () => {}, signal: controller.signal }
  const pending = runShipAgent(request)
  controller.abort()
  await expect(pending).rejects.toThrow()
  await expect(runShipAgent({ ...request, signal: undefined, timeoutMs: 50 })).rejects.toThrow("timed out")
  expect(agentProgress('{"type":"item.completed","item":{"type":"command_execution","text":"SHIP_STATUS: wrong"}}')).toBeNull()
  expect(agentProgress("not JSON")).toBeNull()
  expect(() => parseShipPlan("{}")).toThrow()
  expect(prePushFailed('{"event":"child_exit","code":1}')).toBe(false)
})

test("cancellation after context collection prevents Codex from starting", async () => {
  const { tree, bin, root } = fixture()
  const started = join(root, "codex-started")
  script(join(bin, "codex"), `await Bun.write(${JSON.stringify(started)}, 'started')`)
  const controller = new AbortController()
  const settings = { ...defaultShip(), get prompt() {
    // Prompt construction happens after context collection, immediately before spawn.
    controller.abort(new Error("Cancelled after context collection"))
    return "Review the changes"
  } }
  await expect(runShipAgent({ cwd: tree.path, branch: "feature", base: "develop", settings, phase: "prepare", onProgress: () => {}, signal: controller.signal })).rejects.toThrow("Cancelled after context collection")
  expect(existsSync(started)).toBe(false)
})

test("initial commit hook failure preserves user changes and never starts a repair", async () => {
  const { tree, repo } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "user work")
  const hook = join(repo, ".git", "hooks", "pre-commit")
  writeFileSync(hook, '#!/bin/sh\necho "commit check failed" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const phases: string[] = []
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    phases.push(request.phase)
    return plan
  } })).rejects.toThrow(/^Commit failed: commit check failed/)
  expect(phases).toEqual(["prepare"])
  expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("original")
  expect(readFileSync(join(tree.path, "app.txt"), "utf8")).toBe("user work")
})

test("Ship links ignored matching main dependencies before the user's pre-commit hook", async () => {
  const { tree, repo } = fixture()
  mkdirSync(join(repo, "node_modules"))
  writeFileSync(join(repo, "node_modules", "hook-tool"), "available")
  writeFileSync(join(repo, "bun.lock"), "matching lock")
  writeFileSync(join(tree.path, "bun.lock"), "matching lock")
  writeFileSync(join(tree.path, ".gitignore"), "/node_modules\n")
  writeFileSync(join(tree.path, "app.txt"), "user changes")
  const hook = join(repo, ".git", "hooks", "pre-commit")
  writeFileSync(hook, '#!/bin/sh\ntest -f node_modules/hook-tool || { echo "missing hook tool" >&2; exit 1; }\n')
  chmodSync(hook, 0o755)
  await shipWorktree({ tree, mainPath: repo, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async () => plan })
  expect(lstatSync(join(tree.path, "node_modules")).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(tree.path, "node_modules"))).toBe(join(repo, "node_modules"))
  expect(gitOk(tree.path, ["status", "--porcelain"]).trim()).toBe("")
})

test("cancelling a running configured pre-push hook keeps the user commit and creates no PR", async () => {
  const { tree, repo, root, calls } = fixture()
  const hooks = join(root, "custom-hooks")
  mkdirSync(hooks)
  gitOk(repo, ["config", "core.hooksPath", hooks])
  const started = join(root, "hook-started")
  script(join(hooks, "pre-push"), `await Bun.write(${JSON.stringify(started)}, 'yes'); await Bun.sleep(30000)`)
  writeFileSync(join(tree.path, "app.txt"), "user work")
  const controller = new AbortController()
  const pending = shipWorktree({ tree, base: "develop", settings: defaultShip(), signal: controller.signal, onProgress: () => {}, agent: async () => plan })
  const result = pending.then(() => null, (error: unknown) => error)
  try {
    for (let i = 0; i < 300 && !await Bun.file(started).exists(); i++) await Bun.sleep(10)
    expect(await Bun.file(started).exists()).toBe(true)
  } finally { controller.abort() }
  expect(await result).toBeInstanceOf(Error)
  expect(gitOk(tree.path, ["show", "HEAD:app.txt"])).toBe("user work")
  expect(gitOk(repo, ["config", "core.hooksPath"]).trim()).toBe(hooks)
  expect(readFileSync(calls, "utf8")).not.toContain('"create"')
}, 10000)

test("Ship supplies committed, staged, unstaged and untracked changes to a no-tools writing prompt", async () => {
  const { tree, bin, root } = fixture()
  writeFileSync(join(tree.path, "widget.ts"), "export const widget = 'committed behavior'\n")
  gitOk(tree.path, ["add", "."])
  gitOk(tree.path, ["commit", "-m", "Implement widget rendering"])
  writeFileSync(join(tree.path, "app.txt"), "staged behavior")
  gitOk(tree.path, ["add", "."])
  writeFileSync(join(tree.path, "app.txt"), "unstaged behavior")
  writeFileSync(join(tree.path, "helper.ts"), "export const helper = 'untracked implementation'")
  writeFileSync(join(tree.path, ".env.local"), "SECRET=must-not-be-supplied")
  const capture = join(root, "prompt.txt")
  script(join(bin, "codex"), `
const args = process.argv.slice(2)
await Bun.write(${JSON.stringify(capture)}, await Bun.stdin.text())
await Bun.write(args[args.indexOf('--output-last-message')+1], ${JSON.stringify(JSON.stringify(plan))})
`)
  await runShipAgent({ cwd: tree.path, branch: "feature", base: "develop", settings: { ...defaultShip(), prompt: "Use only supplied data. Do not use tools." }, phase: "prepare", onProgress: () => {} })
  const prompt = readFileSync(capture, "utf8")
  for (const evidence of ["committed behavior", "Implement widget rendering", "staged behavior", "unstaged behavior", "untracked implementation"]) expect(prompt).toContain(evidence)
  expect(prompt).not.toContain("must-not-be-supplied")
  expect(prompt).not.toContain("diff --git a/develop.txt")
  expect(prompt).toContain("No validation commands have run yet")
  // A clean checkout still needs the entire already-committed PR diff.
  gitOk(tree.path, ["add", "."])
  gitOk(tree.path, ["commit", "-m", "Complete widget"])
  await runShipAgent({ cwd: tree.path, branch: "feature", base: "develop", settings: defaultShip(), phase: "describe", validation: "Pre-push hook exited 0. widget tests: 3 passed.", onProgress: () => {} })
  const cleanPrompt = readFileSync(capture, "utf8")
  expect(cleanPrompt).toContain("committed behavior")
  expect(cleanPrompt).toContain("untracked implementation")
  expect(cleanPrompt).toContain("widget tests: 3 passed")
  expect(cleanPrompt).not.toContain("must-not-be-supplied")
})

test("the final description receives successful hook evidence even when no repairs were needed", async () => {
  const { tree, hook } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "implemented user feature")
  hook('echo "quality checks: 12 passed"; exit 0')
  const requests: ShipAgentRequest[] = []
  await shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) => {
    requests.push(request)
    return plan
  } })
  expect(requests.map((request) => request.phase)).toEqual(["prepare", "describe"])
  expect(requests[1]!.validation).toContain("Pre-push hook exited 0")
  expect(requests[1]!.validation).toContain("quality checks: 12 passed")
  expect(requests[1]!.baseRef).toBe(gitOk(tree.path, ["rev-parse", "develop"]).trim())
})

test("an AI response that cannot review the diff stops without publishing a placeholder PR", async () => {
  const { tree, calls } = fixture()
  writeFileSync(join(tree.path, "app.txt"), "implemented feature")
  await expect(shipWorktree({ tree, base: "develop", settings: defaultShip(), onProgress: () => {}, agent: async (request) =>
    request.phase === "describe" ? { ...plan, ready: false, blocker: "The diff was not readable", body: "No diff supplied" } : plan,
  })).rejects.toThrow("could not review the changes")
  expect(readFileSync(calls, "utf8")).not.toContain('"create"')
  expect(() => parseShipPlan(JSON.stringify({ ...plan, ready: undefined }))).toThrow("review status")
})
