import { opendir, access, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { expandPath } from "./config.ts"

export type PathSuggestion = { name: string; value: string }
const ignored = new Set(["node_modules", ".git", ".cache", ".next", "dist", "build", "coverage"])

/** Complete only the final segment; retain the user's relative or ~/ spelling. */
export async function completePath(input: string, signal?: AbortSignal): Promise<PathSuggestion[]> {
  if (!input.trim()) return []
  const value = input.trimStart() === "~" ? "~/" : input.trimStart()
  const slash = value.lastIndexOf("/")
  const prefix = value.slice(0, slash + 1)
  const fragment = value.slice(slash + 1)
  const parent = expandPath(prefix || ".")
  const results: PathSuggestion[] = []
  try {
    const directory = await opendir(parent)
    for await (const entry of directory) {
      if (signal?.aborted) break
      if (ignored.has(entry.name) || !entry.name.startsWith(fragment)) continue
      if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue
      try {
        const path = join(parent, entry.name)
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await stat(path)).isDirectory())) continue
        await access(path, constants.R_OK | constants.X_OK)
        results.push({ name: entry.name, value: `${prefix}${entry.name}/` })
        if (results.length === 20) break
      } catch { /* Broken links and inaccessible children are not suggestions. */ }
    }
  } catch { /* Missing or unreadable prefixes leave the field editable. */ }
  return results.sort((a, b) => a.name.localeCompare(b.name))
}
