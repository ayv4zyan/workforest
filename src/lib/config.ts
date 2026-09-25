import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { configPath } from "./home.ts"
import { slugify, uniqueId } from "./slug.ts"
import { isGitRepo, repoRoot } from "./git.ts"
import type { Config, Project } from "./types.ts"

const emptyConfig = (): Config => ({ version: 1, projects: [] })

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isConfig(value: unknown): value is Config {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects)) return false
  if (!value.projects.every((project: unknown) => isRecord(project) &&
    typeof project.id === "string" && project.id.length > 0 &&
    typeof project.name === "string" && project.name.length > 0 &&
    typeof project.path === "string" && project.path.length > 0 &&
    Number.isInteger(project.basePort) &&
    (project.startCommand === undefined || typeof project.startCommand === "string"))) return false
  if (value.ui !== undefined && (!isRecord(value.ui) ||
    (value.ui.projectPaneWidth !== undefined &&
      (typeof value.ui.projectPaneWidth !== "number" || !Number.isFinite(value.ui.projectPaneWidth))) ||
    (value.ui.selectedProjectId !== undefined &&
      (typeof value.ui.selectedProjectId !== "string" || value.ui.selectedProjectId.length === 0)))) return false
  return true
}

export function loadConfig(home: string): Config {
  const path = configPath(home)
  if (!existsSync(path)) return emptyConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read config at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isConfig(parsed)) throw new Error(`Invalid config at ${path}: expected version 1 with valid projects`)
  return parsed
}

export function saveConfig(home: string, config: Config): void {
  const path = configPath(home)
  if (!isConfig(config)) throw new Error(`Refusing to write invalid config at ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
}

export function setProjectPaneWidth(home: string, width: number): void {
  const config = loadConfig(home)
  config.ui = { ...config.ui, projectPaneWidth: width }
  saveConfig(home, config)
}

export function setSelectedProjectId(home: string, projectId: string): void {
  const config = loadConfig(home)
  if (!config.projects.some((project) => project.id === projectId)) throw new Error(`Unknown project "${projectId}"`)
  if (config.ui?.selectedProjectId === projectId) return
  config.ui = { ...config.ui, selectedProjectId: projectId }
  saveConfig(home, config)
}

export function addProject(home: string, rawPath: string, name?: string): Project {
  const expanded = expandPath(rawPath)
  if (!isGitRepo(expanded)) {
    throw new Error(`Not a git repository: ${expanded}`)
  }
  const path = repoRoot(expanded)
  const config = loadConfig(home)
  if (config.projects.some((project) => project.path === path)) {
    throw new Error(`Project already registered: ${path}`)
  }
  const id = uniqueId(slugify(name ?? basenameSafe(path)), new Set(config.projects.map((p) => p.id)))
  const project: Project = {
    id,
    name: name ?? basenameSafe(path),
    path,
    basePort: 5173,
  }
  config.projects.push(project)
  saveConfig(home, config)
  return project
}

export function setProjectStartCommand(home: string, projectId: string, rawCommand: string): Project {
  const startCommand = rawCommand.trim()
  if (!startCommand) throw new Error("command required")
  const config = loadConfig(home)
  const project = config.projects.find((row) => row.id === projectId)
  if (!project) throw new Error(`Unknown project "${projectId}"`)
  project.startCommand = startCommand
  saveConfig(home, config)
  return project
}

export function removeProject(home: string, projectId: string): void {
  const config = loadConfig(home)
  const next = config.projects.filter((project) => project.id !== projectId)
  if (next.length === config.projects.length) {
    throw new Error(`Unknown project "${projectId}"`)
  }
  const ui = config.ui?.selectedProjectId === projectId
    ? { ...config.ui, selectedProjectId: next[0]?.id }
    : config.ui
  saveConfig(home, { ...config, projects: next, ui })
}

export function expandPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return process.env.HOME ?? trimmed
  if (trimmed.startsWith("~/")) return `${process.env.HOME ?? ""}${trimmed.slice(1)}`
  return resolve(trimmed)
}

function basenameSafe(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}
