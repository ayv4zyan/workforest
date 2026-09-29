export function reconcileWorktreeOrder(saved: string[], paths: string[]): string[] {
  const live = new Set(paths)
  return [...new Set([...saved.filter((path) => live.has(path)), ...paths])]
}

export function sortWorktrees<T extends { path: string; displayName: string }>(trees: T[], order: string[]): T[] {
  const ranks = new Map(order.map((path, index) => [path, index]))
  return [...trees].sort((a, b) => (ranks.get(a.path) ?? Infinity) - (ranks.get(b.path) ?? Infinity) ||
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base", numeric: true }) || a.path.localeCompare(b.path))
}
