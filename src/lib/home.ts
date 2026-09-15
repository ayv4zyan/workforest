import { homedir } from "node:os"
import { join } from "node:path"

export function workforestHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKFOREST_HOME ?? join(env.HOME ?? homedir(), ".workforest")
}

export function treesRoot(home: string): string {
  return join(home, "trees")
}

export function projectTreesDir(home: string, projectId: string): string {
  return join(home, "trees", projectId)
}

export function runDir(home: string): string {
  return join(home, "run")
}

export function logsDir(home: string): string {
  return join(home, "logs")
}

export function configPath(home: string): string {
  return join(home, "config.json")
}

export function portsPath(home: string): string {
  return join(home, "ports.json")
}
