import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DevTarget } from "./types.ts"

type Pkg = {
  scripts?: Record<string, string>
}

function readPkg(path: string): Pkg | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Pkg
  } catch {
    return null
  }
}

export function extraArgsForScript(script: string): string[] {
  if (/\bvite\b/.test(script)) return ["--", "--port", "PORT", "--strictPort"]
  if (/\bnext\b/.test(script)) return ["--", "-p", "PORT"]
  return []
}

export function resolveDevTarget(repoRoot: string): DevTarget | null {
  const rootPkg = readPkg(join(repoRoot, "package.json"))
  if (!rootPkg) return null
  const scripts = rootPkg.scripts ?? {}
  if (scripts.dev) {
    return { cwd: repoRoot, script: "dev", extraArgs: extraArgsForScript(scripts.dev) }
  }
  if (scripts["web:dev"]) {
    return { cwd: repoRoot, script: "web:dev", extraArgs: extraArgsForScript(scripts["web:dev"]) }
  }
  for (const sub of ["web", "app", "frontend", "client"]) {
    const nested = readPkg(join(repoRoot, sub, "package.json"))
    const script = nested?.scripts?.dev
    if (script) {
      return { cwd: join(repoRoot, sub), script: "dev", extraArgs: extraArgsForScript(script) }
    }
  }
  return null
}

export function spawnCommand(target: DevTarget, port: number): string[] {
  const extras = target.extraArgs.map((part) => (part === "PORT" ? String(port) : part))
  return ["bun", "run", target.script, ...extras]
}
