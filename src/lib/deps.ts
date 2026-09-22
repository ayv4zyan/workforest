import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { exec } from "./exec.ts"

export const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
export const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test"]

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"])

export function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false
  const left = readFileSync(a)
  const right = readFileSync(b)
  return Buffer.compare(left, right) === 0
}

export function lockfilesMatch(mainDir: string, treeDir: string): boolean {
  const names = LOCKFILES.filter((name) => existsSync(join(mainDir, name)) || existsSync(join(treeDir, name)))
  if (names.length === 0) return true
  return names.every((name) => filesEqual(join(mainDir, name), join(treeDir, name)))
}

export function findNodeModulesDirs(root: string, maxDepth = 4): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (name === "node_modules") {
        found.push(full)
        continue
      }
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

export function packageDirs(root: string): string[] {
  const dirs = [root]
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return dirs
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const full = join(root, name)
    try {
      if (lstatSync(full).isDirectory() && existsSync(join(full, "package.json"))) {
        dirs.push(full)
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return dirs
}

export function copyEnvFiles(mainRoot: string, treeRoot: string): string[] {
  const notes: string[] = []
  for (const pkg of packageDirs(mainRoot)) {
    const relPkg = relative(mainRoot, pkg)
    const destPkg = relPkg ? join(treeRoot, relPkg) : treeRoot
    if (!existsSync(destPkg)) continue
    for (const name of ENV_FILES) {
      const src = join(pkg, name)
      const dest = join(destPkg, name)
      if (!existsSync(src) || existsSync(dest)) continue
      copyFileSync(src, dest)
      notes.push(`copied ${join(relPkg, name) || name}`)
    }
  }
  return notes
}

export function bunInstall(cwd: string): void {
  const result = exec(["bun", "install"], { cwd, timeoutMs: 120_000 })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `bun install failed in ${cwd}`)
  }
}

async function bunInstallAsync(cwd: string): Promise<void> {
  const child = Bun.spawn(["bun", "install"], { cwd, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error(`bun install timed out in ${cwd}`)
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `bun install failed in ${cwd}`)
  } finally {
    clearTimeout(timer)
  }
}

function prepareWorktreeDeps(mainRoot: string, treeRoot: string): { notes: string[]; installDirs: Set<string> } {
  const notes = copyEnvFiles(mainRoot, treeRoot)
  const moduleDirs = findNodeModulesDirs(mainRoot)
  const installDirs = new Set<string>()

  for (const mainModules of moduleDirs) {
    const rel = relative(mainRoot, mainModules)
    const pkgRel = dirname(rel)
    const mainPkg = pkgRel === "." ? mainRoot : join(mainRoot, pkgRel)
    const treePkg = pkgRel === "." ? treeRoot : join(treeRoot, pkgRel)
    if (!existsSync(treePkg)) continue
    const dest = join(treeRoot, rel)
    if (lockfilesMatch(mainPkg, treePkg)) {
      if (existsSync(dest)) continue
      mkdirSync(dirname(dest), { recursive: true })
      symlinkSync(mainModules, dest)
      notes.push(`linked ${rel}`)
    } else {
      if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) unlinkSync(dest)
      installDirs.add(treePkg)
      notes.push(`lockfile differs in ${pkgRel === "." ? "root" : pkgRel}`)
    }
  }

  if (moduleDirs.length === 0) installDirs.add(treeRoot)
  return { notes, installDirs }
}

export function setupWorktreeDeps(mainRoot: string, treeRoot: string): string[] {
  const { notes, installDirs } = prepareWorktreeDeps(mainRoot, treeRoot)
  for (const dir of installDirs) {
    bunInstall(dir)
    const rel = relative(treeRoot, dir)
    notes.push(`bun install in ${rel || "."}`)
  }
  return notes
}

export async function setupWorktreeDepsAsync(mainRoot: string, treeRoot: string): Promise<string[]> {
  const { notes, installDirs } = prepareWorktreeDeps(mainRoot, treeRoot)
  for (const dir of installDirs) {
    await bunInstallAsync(dir)
    const rel = relative(treeRoot, dir)
    notes.push(`bun install in ${rel || "."}`)
  }
  return notes
}
