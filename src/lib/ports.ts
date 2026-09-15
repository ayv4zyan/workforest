import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { portsPath } from "./home.ts"

export type PortMap = Record<string, number>

export function loadPorts(home: string): PortMap {
  const path = portsPath(home)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PortMap
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function savePorts(home: string, ports: PortMap): void {
  const path = portsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(ports, null, 2)}\n`)
}

export function pickPort(used: Iterable<number>, preferred: number | undefined, base: number): number {
  const taken = new Set(used)
  if (preferred && preferred >= 1024 && preferred <= 65535 && !taken.has(preferred)) {
    return preferred
  }
  let port = Math.max(base, 1024)
  while (taken.has(port)) {
    port++
    if (port > 65535) throw new Error("No free TCP port")
  }
  return port
}

export function rememberPort(home: string, worktreePath: string, port: number): void {
  const ports = loadPorts(home)
  ports[worktreePath] = port
  savePorts(home, ports)
}

export function forgetPort(home: string, worktreePath: string): void {
  const ports = loadPorts(home)
  if (!(worktreePath in ports)) return
  delete ports[worktreePath]
  savePorts(home, ports)
}

export function movePort(home: string, from: string, to: string): void {
  const ports = loadPorts(home)
  const port = ports[from]
  if (port === undefined) return
  delete ports[from]
  ports[to] = port
  savePorts(home, ports)
}
