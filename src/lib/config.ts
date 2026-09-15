import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { configPath } from "./home.ts"
import { slugify, uniqueId } from "./slug.ts"
import { isGitRepo, repoRoot } from "./git.ts"
import type { Config, Project } from "./types.ts"

const emptyConfig = (): Config => ({ version: 1, projects: [] })

export function loadConfig(home: string): Config {
  const path = configPath(home)
  if (!existsSync(path)) return emptyConfig()
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Config
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return emptyConfig()
    return parsed
  } catch {
    return emptyConfig()
  }
}

export function saveConfig(home: string, config: Config): void {
  const path = configPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
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
  saveConfig(home, { ...config, projects: next })
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
