import { expect, test } from "bun:test"
import { parseLsofCwd, parseLsofListen, worktreeForCwd, serverStatus, startServer, loadRunRecords, stopServer } from "./servers.ts"
import { pickPort } from "./ports.ts"
import { extraArgsForScript, resolveDevTarget, spawnCommand, spawnCustomCommand } from "./dev.ts"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs"
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

test("server status distinguishes startup, failure, external and multiple servers", () => {
  const row = { pid: 123, port: 5173, command: "bun", worktreePath: "/tmp/tree", projectId: "p", owned: true }
  expect(serverStatus([])).toBe("○ Stopped")
  expect(serverStatus([{ ...row, state: "starting" }])).toContain("Starting · :5173")
  expect(serverStatus([{ ...row, state: "failed" }])).toContain("Failed · view logs")
  expect(serverStatus([row, { ...row, pid: 456, port: 5174, owned: false }])).toBe("● Running · :5173, :5174 · 2 servers · external")
})

test("explicit ports are validated and occupied ports are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-port-"))
  const listener = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const tree: GitWorktree = { path: root, head: "a", branch: "main", bare: false, detached: false, locked: false, prunable: false, isMain: true }
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "bun server.ts" } }))
  const opts = { home: join(root, "home"), project: { id: "p", name: "p", path: root, basePort: 5173 }, worktree: tree, usedPorts: [] }
  try {
    for (const port of [0, 1023, 65536, 5173.5, NaN]) {
      expect(() => startServer({ ...opts, port })).toThrow("whole port number")
    }
    expect(() => startServer({ ...opts, port: listener.port! })).toThrow("already in use")
    expect(loadRunRecords(opts.home)).toEqual([])
  } finally {
    listener.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test("saved project command runs from a linked worktree with the chosen port", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-command-"))
  const main = join(root, "main")
  const linked = join(root, "linked tree")
  mkdirSync(main)
  mkdirSync(linked)
  writeFileSync(join(linked, "package.json"), JSON.stringify({ scripts: { local: "bun server.ts" } }))
  writeFileSync(join(linked, "server.ts"), 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("linked command")})')
  const home = join(root, "home")
  const project = { id: "p", name: "p", path: main, basePort: 5173, startCommand: "bun local" }
  const tree: GitWorktree = { path: linked, head: "a", branch: "feature", bare: false, detached: false, locked: false, prunable: false, isMain: false }
  let record: ReturnType<typeof startServer> | undefined
  try {
    record = startServer({ home, project, worktree: tree, usedPorts: [] })
    let response = ""
    for (let i = 0; i < 40; i++) {
      try { response = await (await fetch(`http://127.0.0.1:${record.port}`)).text() } catch {}
      if (response === "linked command") break
      await Bun.sleep(25)
    }
    expect(response).toBe("linked command")
    expect(record.worktreePath).toBe(linked)
  } finally {
    if (record) stopServer(home, { ...record, command: "bun local", owned: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("bun local forwards the chosen port to Vite instead of relying on PORT", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-vite-port-"))
  const home = join(root, "home")
  const bin = join(root, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { local: "vite --host 127.0.0.1" } }))
  // A CLI that, like Vite, takes its port from arguments rather than PORT.
  writeFileSync(join(bin, "vite"), `#!${process.execPath}
const args = process.argv.slice(2)
const index = args.lastIndexOf("--port")
const server = Bun.serve({port: index < 0 ? 0 : Number(args[index + 1]), fetch: () => new Response("vite fixture")})
await Bun.write("actual-port.json", JSON.stringify({port: server.port, args}))
`)
  chmodSync(join(bin, "vite"), 0o755)
  const tree: GitWorktree = { path: root, head: "a", branch: "main", bare: false, detached: false, locked: false, prunable: false, isMain: true }
  let record: ReturnType<typeof startServer> | undefined
  try {
    record = startServer({home, project: {id: "p", name: "p", path: root, basePort: 5173, startCommand: "bun local"}, worktree: tree, usedPorts: []})
    let actual: {port: number; args: string[]} | undefined
    for (let i = 0; i < 40; i++) {
      try { actual = JSON.parse(readFileSync(join(root, "actual-port.json"), "utf8")); break } catch {}
      await Bun.sleep(25)
    }
    expect(actual?.port).toBe(record.port)
    expect(actual?.args).toContain("--strictPort")
    expect(await (await fetch(`http://127.0.0.1:${record.port}`)).text()).toBe("vite fixture")
  } finally {
    if (record) stopServer(home, { ...record, command: "bun local", owned: true })
    rmSync(root, {recursive: true, force: true})
  }
})

test("custom port flags preserve script options and leave shell commands intact", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-command-args-"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {local: "vite --host 0.0.0.0", web: "next dev", wrapped: "bun scripts/local-vite.ts"} }))
  try {
    expect(spawnCustomCommand(root, "bun run local --mode stage", 3002)).toEqual(["bun", "run", "local", "--mode", "stage", "--port", "3002", "--strictPort"])
    expect(spawnCustomCommand(root, "bun web", 3002)).toEqual(["bun", "run", "web", "-p", "3002"])
    for (const command of ['bun wrapped', 'bun local && echo ready', 'bun local --port "$PORT"']) {
      expect(spawnCustomCommand(root, command, 3002)).toEqual(["/bin/sh", "-c", command])
    }
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})
