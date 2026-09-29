import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import type { TreeEntry } from "./workspace.ts"
import { projectListOffset } from "./project-drag.ts"

type Target = { path: string; placement: "before" | "after" }
type Drag = { path: string; projectId: string; x: number; y: number; offset: number; dragging: boolean; target: Target | null }

export const treeEntryKey = (entry: TreeEntry) => entry.kind === "group" ? `group:${entry.group}` : entry.tree.path
export const treeVisibleCount = (height: number, dragging: boolean) => Math.max(1, height - 1 - (dragging ? 1 : 0))

export function treeRowLayout(entries: TreeEntry[], selectedPath: string | null, offset: number, count: number) {
  let top = 0
  return entries.slice(offset, offset + count).map((entry, index) => {
    const height = entry.kind === "tree" && entry.tree.path === selectedPath ? 2 : 1
    const row = { entry, index: offset + index, top, height }
    top += height
    return row
  })
}

export function createTreeDrag(options: {
  entries: Accessor<TreeEntry[]>
  selectedPath: Accessor<string | null>
  selectedIndex: Accessor<number>
  projectId: Accessor<string | null>
  list: () => BoxRenderable | undefined
  blocked: Accessor<boolean>
  canReorder: Accessor<boolean>
  onSelect: (path: string) => void
  onReorder: (path: string, targetPath: string, placement: "before" | "after") => void
}) {
  const [state, setState] = createSignal<Drag | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined
  function cancel() {
    clearInterval(timer)
    timer = undefined
    setState(null)
  }
  createEffect(() => {
    const drag = state()
    if (drag && (options.projectId() !== drag.projectId || options.blocked() || !options.canReorder() ||
      !options.entries().some((entry) => entry.kind === "tree" && entry.group === "pinned" && entry.tree.path === drag.path))) cancel()
    else if (drag?.target && !options.entries().some((entry) => entry.kind === "tree" && entry.group === "pinned" && entry.tree.path === drag.target!.path)) {
      setState({ ...drag, target: null })
    }
  })
  onCleanup(cancel)

  function layout(drag: Drag) {
    return treeRowLayout(options.entries(), options.selectedPath(), drag.offset, treeVisibleCount(options.list()?.height ?? 1, drag.dragging))
  }
  function lineTop(drag = state()): number {
    if (!drag?.target) return 0
    const row = layout(drag).find(({ entry }) => entry.kind === "tree" && entry.tree.path === drag.target!.path)
    return row ? row.top + (drag.target.placement === "after" ? row.height : 0) : 0
  }
  function targetAt(drag: Drag): Target | null {
    const list = options.list()
    if (!list || drag.x < list.x || drag.x >= list.x + list.width || drag.y < list.y || drag.y >= list.y + list.height) return null
    let y = drag.y - list.y
    if (drag.target) {
      const line = lineTop(drag)
      if (y === line) return drag.target
      if (y > line) y--
    }
    const hit = layout(drag).find((row) => y >= row.top && y < row.top + row.height)
    if (!hit || hit.entry.kind !== "tree" || hit.entry.group !== "pinned" || hit.entry.tree.path === drag.path) return null
    const source = options.entries().findIndex((entry) => entry.kind === "tree" && entry.tree.path === drag.path)
    return { path: hit.entry.tree.path, placement: hit.index < source ? "before" : "after" }
  }
  function scroll(delta: number) {
    const drag = state()
    const list = options.list()
    if (!drag?.dragging || !list) return false
    const offset = Math.max(0, Math.min(drag.offset + delta, options.entries().length - treeVisibleCount(list.height, true)))
    if (offset !== drag.offset) {
      const next = { ...drag, offset, target: null }
      setState({ ...next, target: targetAt(next) })
    }
    return true
  }
  function start(path: string, event: MouseEvent) {
    cancel()
    const projectId = options.projectId()
    if (event.button !== 0 || !projectId || options.blocked() || !options.canReorder() ||
      !options.entries().some((entry) => entry.kind === "tree" && entry.group === "pinned" && entry.tree.path === path)) return
    setState({ path, projectId, x: event.x, y: event.y, dragging: false, target: null,
      offset: projectListOffset(options.selectedIndex(), options.entries().length, treeVisibleCount(options.list()?.height ?? 1, false)) })
    options.onSelect(path)
  }
  function move(event: MouseEvent) {
    const drag = state()
    if (!drag || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    if (!drag.dragging && drag.x === event.x && drag.y === event.y) return
    const next = { ...drag, dragging: true, x: event.x, y: event.y }
    setState({ ...next, target: targetAt(next) })
    if (!timer) timer = setInterval(() => {
      const current = state()
      const list = options.list()
      if (!current?.dragging || !list || current.x < list.x || current.x >= list.x + list.width) return
      if (current.y <= list.y) scroll(-1)
      else if (current.y >= list.y + list.height - 1) scroll(1)
    }, 150)
  }
  function end(event: MouseEvent) {
    const drag = state()
    if (!drag || event.button !== 0) return
    event.stopPropagation()
    const target = targetAt({ ...drag, x: event.x, y: event.y })
    cancel()
    if (drag.dragging && target && !options.blocked() && options.canReorder()) options.onReorder(drag.path, target.path, target.placement)
  }
  return { state, start, move, end, scroll, cancel, lineTop }
}

export type TreeDrag = ReturnType<typeof createTreeDrag>
