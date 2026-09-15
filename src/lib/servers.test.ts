import { expect, test } from "bun:test"
import { parseLsofCwd, parseLsofListen, worktreeForCwd } from "./servers.ts"
import { pickPort } from "./ports.ts"
import { extraArgsForScript, resolveDevTarget, spawnCommand } from "./dev.ts"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GitWorktree } from "./types.ts"

test("parseLsofListen extracts pid and port", () => {
  const stdout = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1234 art   23u  IPv6 0x0      0t0  TCP *:5173 (LISTEN)
bun     5678 art   12u  IPv4 0x0      0t0  TCP 127.0.0.1:5174 (LISTEN)
`
  expect(parseLsofListen(stdout)).toEqual([
    { command: "node", pid: 1234, port: 5173, addr: "*:5173" },
    { command: "bun", pid: 5678, port: 5174, addr: "127.0.0.1:5174" },
  ])
})

test("parseLsofCwd maps pid to path", () => {
  const stdout = `p1234
fcwd
n/Users/arturayvazyan/Projects/Cras
p5678
fcwd
n/tmp/tree (deleted)
`
  const map = parseLsofCwd(stdout)
  expect(map.get(1234)).toBe("/Users/arturayvazyan/Projects/Cras")
  expect(map.get(5678)).toBe("/tmp/tree")
})

test("worktreeForCwd prefers the longest matching path", () => {
  const trees: GitWorktree[] = [
    {
      path: "/tmp/repo",
      head: "a",
      branch: "main",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: true,
    },
    {
      path: "/tmp/repo-feat",
      head: "b",
      branch: "feat",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: false,
    },
  ]
  expect(worktreeForCwd("/tmp/repo/web", trees)?.branch).toBe("main")
  expect(worktreeForCwd("/tmp/repo-feat/web", trees)?.branch).toBe("feat")
})

test("pickPort reuses preferred when free", () => {
  expect(pickPort([5173], 5174, 5173)).toBe(5174)
  expect(pickPort([5173, 5174], undefined, 5173)).toBe(5175)
})

test("resolveDevTarget prefers root web:dev then nested vite", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-dev-"))
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { "web:dev": "bun --filter @cras/web dev" } }),
  )
  expect(resolveDevTarget(dir)?.script).toBe("web:dev")

  const nested = mkdtempSync(join(tmpdir(), "wf-dev2-"))
  mkdirSync(join(nested, "web"))
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "mono" }))
  writeFileSync(join(nested, "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
  const target = resolveDevTarget(nested)
  expect(target?.cwd).toBe(join(nested, "web"))
  expect(extraArgsForScript("vite")).toEqual(["--", "--port", "PORT", "--strictPort"])
  expect(spawnCommand(target!, 5180)).toEqual([
    "bun",
    "run",
    "dev",
    "--",
    "--port",
    "5180",
    "--strictPort",
  ])
})
