import { homedir } from "node:os"
import { isAbsolute, relative } from "node:path"

export function displayPath(path: string, home = process.env.HOME ?? homedir()): string {
  const fromHome = relative(home, path)
  if (!fromHome) return "~"
  if (fromHome === ".." || fromHome.startsWith("../") || isAbsolute(fromHome)) return path
  return `~/${fromHome}`
}
