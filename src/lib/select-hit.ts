export function pickSelectIndex(
  localY: number,
  height: number,
  selectedIndex: number,
  count: number,
  linesPerItem: number,
): number | null {
  if (count <= 0 || height <= 0 || localY < 0 || localY >= height) return null
  const maxVisible = Math.max(1, Math.floor(height / linesPerItem))
  const halfVisible = Math.floor(maxVisible / 2)
  const scrollOffset = Math.max(0, Math.min(selectedIndex - halfVisible, count - maxVisible))
  const index = scrollOffset + Math.floor(localY / linesPerItem)
  if (index < 0 || index >= count) return null
  if (index >= scrollOffset + maxVisible) return null
  return index
}

export function nextIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, current + delta))
}
