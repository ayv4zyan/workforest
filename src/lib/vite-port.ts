import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveDevTarget } from "./dev.ts"

const configNames = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"]

function literalPort(source: string): number | null {
  // Importing a Vite config would execute project code. Read only a literal port.
  const start = source.search(/\bexport\s+default\b/)
  if (start < 0) return null
  const config = source.slice(start)
  const server = /\bserver\s*:\s*\{/.exec(config)
  if (!server) return null
  const body = config.slice(server.index + server[0].length)
  let depth = 1
  let end = body.length
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++
    else if (body[i] === "}" && --depth === 0) { end = i; break }
  }
  const match = /(?:^|[,\n])\s*port\s*:\s*(\d+)\s*(?=[,\n}]|$)/m.exec(body.slice(0, end))
  const port = match ? Number(match[1]) : NaN
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

export function vitePort(worktreePath: string): number | null {
  const target = resolveDevTarget(worktreePath)
  const dirs = [...new Set([target?.cwd, worktreePath, ...["web", "app", "frontend", "client"].map((name) => join(worktreePath, name))]
    .filter((path): path is string => !!path))]
  for (const dir of dirs) {
    for (const name of configNames) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      try {
        const port = literalPort(readFileSync(path, "utf8"))
        if (port !== null) return port
      } catch { /* Fall back to the next config. */ }
    }
  }
  return null
}
