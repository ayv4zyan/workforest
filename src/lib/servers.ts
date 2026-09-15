import {
  existsSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { exec } from "./exec.ts"
import { logsDir, runDir } from "./home.ts"
import { resolveDevTarget, spawnCommand, spawnCustomCommand } from "./dev.ts"
import { forgetPort, loadPorts, pickPort, rememberPort } from "./ports.ts"
import type { GitWorktree, Listener, Project, RunRecord, ServerRow } from "./types.ts"

export function parseLsofListen(stdout: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of stdout.split("\n")) {
    if (!line.trim() || line.startsWith("COMMAND")) continue
    const head = line.match(/^(\S+)\s+(\d+)\s+/)
    const tcp = line.match(/TCP\s+(\S+)\s+\(LISTEN\)/i)
    const hostPort = tcp?.[1]
    const portMatch = hostPort?.match(/:(\d+)$/)
    if (!head?.[1] || !head[2] || !hostPort || !portMatch?.[1]) continue
    listeners.push({
      command: head[1],
      pid: Number(head[2]),
      port: Number(portMatch[1]),
      addr: hostPort,
    })
  }
  return listeners
}

export function parseLsofCwd(stdout: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid: number | undefined
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
    } else if (line.startsWith("n") && pid !== undefined) {
      const cwd = line.slice(1).replace(/ \(deleted\)$/, "")
      map.set(pid, cwd)
    }
  }
  return map
}

export function worktreeForCwd(cwd: string, trees: GitWorktree[]): GitWorktree | null {
  const normalized = resolve(cwd)
  const matches = trees.filter((tree) => {
    const root = resolve(tree.path)
    return normalized === root || normalized.startsWith(`${root}/`)
  })
  matches.sort((a, b) => b.path.length - a.path.length)
  return matches[0] ?? null
}

export function listListeners(): Listener[] {
  const result = exec(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"])
  if (result.exitCode !== 0 && !result.stdout.trim()) return []
  return parseLsofListen(result.stdout)
}

export function listCwds(pids: number[]): Map<number, string> {
  if (pids.length === 0) return new Map()
  const result = exec(["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"])
  if (result.exitCode !== 0 && !result.stdout.trim()) return new Map()
  return parseLsofCwd(result.stdout)
}

export function runFilePath(home: string, projectId: string, worktreePath: string): string {
  return join(runDir(home), projectId, `${basename(worktreePath)}.json`)
}

export function loadRunRecords(home: string): RunRecord[] {
  const root = runDir(home)
  if (!existsSync(root)) return []
  const records: RunRecord[] = []
  for (const projectId of readdirSync(root)) {
    const dir = join(root, projectId)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue
      try {
        records.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord)
      } catch {
        // skip corrupt records
      }
    }
  }
  return records
}

export function saveRunRecord(home: string, record: RunRecord): void {
  const path = runFilePath(home, record.projectId, record.worktreePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
}

export function moveRunRecord(home: string, projectId: string, from: string, to: string): void {
  const path = runFilePath(home, projectId, from)
  if (!existsSync(path)) return
  const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord
  record.worktreePath = to
  unlinkSync(path)
  saveRunRecord(home, record)
}

export function deleteRunRecord(home: string, projectId: string, worktreePath: string): void {
  const path = runFilePath(home, projectId, worktreePath)
  if (existsSync(path)) unlinkSync(path)
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killProcessTree(pid: number): void {
  exec(["pkill", "-TERM", "-P", String(pid)])
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // already gone
  }
}

export function collectServers(opts: {
  home: string
  projects: Project[]
  treesByProject: Map<string, GitWorktree[]>
}): ServerRow[] {
  const { home, projects, treesByProject } = opts
  const allTrees = [...treesByProject.entries()].flatMap(([projectId, trees]) =>
    trees.map((tree) => ({ projectId, tree })),
  )
  const trees = allTrees.map((entry) => entry.tree)

  const owned = loadRunRecords(home).map((record) => {
    if (!record.exited && !isPidAlive(record.pid)) {
      record.exited = true
      saveRunRecord(home, record)
    }
    return record
  })
  const ownedPids = new Set(owned.filter((record) => !record.exited).map((record) => record.pid))

  const listeners = listListeners()
  const cwds = listCwds(listeners.map((listener) => listener.pid))
  const rows: ServerRow[] = []

  for (const record of owned) {
    rows.push({
      pid: record.pid,
      port: record.port,
      command: record.command.join(" "),
      worktreePath: record.worktreePath,
      projectId: record.projectId,
      owned: true,
      logPath: record.logPath,
      state: record.exited ? "failed" : listeners.some((listener) =>
        listener.port === record.port && (listener.pid === record.pid ||
          worktreeForCwd(cwds.get(listener.pid) ?? "/", trees)?.path === record.worktreePath),
      ) ? "running" : "starting",
    })
  }

  for (const listener of listeners) {
    if (ownedPids.has(listener.pid)) continue
    const cwd = cwds.get(listener.pid)
    if (!cwd) continue
    const tree = worktreeForCwd(cwd, trees)
    if (!tree) continue
    const projectId = allTrees.find((entry) => entry.tree.path === tree.path)?.projectId
    if (!projectId) continue
    if (rows.some((row) => row.worktreePath === tree.path && row.port === listener.port &&
      row.state !== "failed" && (row.owned || row.pid === listener.pid))) continue
    rows.push({
      pid: listener.pid,
      port: listener.port,
      command: listener.command,
      worktreePath: tree.path,
      projectId,
      owned: false,
      state: "running",
    })
  }

  rows.sort((a, b) => a.port - b.port || a.pid - b.pid)
  return rows
}

export function startServer(opts: {
  home: string
  project: Project
  worktree: GitWorktree
  usedPorts: Iterable<number>
  port?: number
}): RunRecord {
  const { home, project, worktree, usedPorts } = opts
  const existing = loadRunRecords(home).find(
    (record) => record.worktreePath === worktree.path && !record.exited && isPidAlive(record.pid),
  )
  if (existing) return existing

  const startCommand = project.startCommand?.trim()
  const target = startCommand ? null : resolveDevTarget(worktree.path)
  if (!startCommand && !target) throw new Error("No dev script found. Set a start command for this project.")

  const preferred = loadPorts(home)[worktree.path]
  const taken = new Set([...usedPorts, ...listListeners().map((listener) => listener.port)])
  const port = opts.port ?? pickPort(taken, preferred, project.basePort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Enter a whole port number from 1024 to 65535")
  }
  if (taken.has(port)) throw new Error(`Port ${port} is already in use. Choose another port.`)
  const command = startCommand ? spawnCustomCommand(worktree.path, startCommand, port) : spawnCommand(target!, port)
  const logPath = join(logsDir(home), project.id, `${basename(worktree.path)}.log`)
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, "a")
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(command, {
      cwd: target?.cwd ?? worktree.path,
      env: {
        ...process.env,
        PORT: String(port),
        VITE_PORT: String(port),
      },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    })
  } finally {
    closeSync(logFd)
  }
  const record: RunRecord = {
    pid: proc.pid,
    port,
    projectId: project.id,
    worktreePath: worktree.path,
    command,
    startedAt: new Date().toISOString(),
    logPath,
  }
  saveRunRecord(home, record)
  rememberPort(home, worktree.path, port)
  proc.unref()
  return record
}

export function stopServer(home: string, row: ServerRow): void {
  if (row.state === "failed") return
  killProcessTree(row.pid)
  if (row.owned) deleteRunRecord(home, row.projectId, row.worktreePath)
}

export function readServerLog(path: string): string {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, 16000))
    const read = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
    return buffer.subarray(0, read).toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  } finally {
    closeSync(fd)
  }
}

export function serversForWorktree(rows: ServerRow[], worktreePath: string): ServerRow[] {
  return rows.filter((row) => row.worktreePath === worktreePath)
}

export function serverStatus(rows: ServerRow[]): string {
  const active = rows.filter((row) => row.state !== "failed")
  if (!active.length) return rows.some((row) => row.state === "failed") ? "! Failed · view logs" : "○ Stopped"
  const ports = [...new Set(active.map((row) => row.port))].map((port) => `:${port}`).join(", ")
  const label = active.every((row) => row.state === "starting") ? "◌ Starting" : "● Running"
  const count = active.length > 1 ? ` · ${active.length} servers` : ""
  const external = active.some((row) => !row.owned) ? " · external" : ""
  return `${label} · ${ports}${count}${external}`
}

export function forgetWorktreeRuntime(home: string, projectId: string, worktreePath: string): void {
  deleteRunRecord(home, projectId, worktreePath)
  forgetPort(home, worktreePath)
}
