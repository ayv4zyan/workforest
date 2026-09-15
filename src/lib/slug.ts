const RESERVED = new Set(["main", "master", "head", "origin"])

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function isWorktreeName(name: string): boolean {
  if (!name) return false
  if (name !== name.trim()) return false
  if (RESERVED.has(name.toLowerCase())) return false
  if (name.startsWith("-") || name.endsWith(".lock")) return false
  if (/[\s~^:?*\[\\]/.test(name)) return false
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false
  return true
}
