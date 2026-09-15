export type Project = {
  id: string
  name: string
  path: string
  basePort: number
  startCommand?: string
}

export type Config = {
  version: 1
  projects: Project[]
}

export type GitWorktree = {
  path: string
  head: string
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
  isMain: boolean
}

export type RunRecord = {
  exited?: boolean
  pid: number
  port: number
  projectId: string
  worktreePath: string
  command: string[]
  startedAt: string
  logPath: string
}

export type Listener = {
  command: string
  pid: number
  port: number
  addr: string
}

export type ServerRow = {
  state?: "starting" | "running" | "failed"
  pid: number
  port: number
  command: string
  worktreePath: string
  projectId: string
  owned: boolean
  logPath?: string
}

export type DevTarget = {
  cwd: string
  script: string
  extraArgs: string[]
}
