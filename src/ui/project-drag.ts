import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import type { Project } from "../lib/types.ts"

type DropTarget = { id: string; placement: "before" | "after" }
type Drag = {
  id: string
  x: number
  y: number
  offset: number
  activate: boolean
  dragging: boolean
  target: DropTarget | null
}

export function projectListOffset(selected: number, count: number, height: number) {
  const visible = Math.max(1, height)
  return Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
}

export function projectVisibleCount(height: number, dragging: boolean) {
  return Math.max(1, height - (dragging ? 1 : 0))
}

export function createProjectDrag(options: {
  projects: Accessor<Project[]>
  selectedId: Accessor<string | null>
  list: () => BoxRenderable | undefined
  blocked: Accessor<boolean>
  canReorder: Accessor<boolean>
  onSelect: (id: string) => void
  onActivate: () => void
  onReorder: (id: string, targetId: string, placement: "before" | "after") => void
}) {
  const [state, setState] = createSignal<Drag | null>(null)
  let scrollTimer: ReturnType<typeof setInterval> | undefined

  function cancel() {
    clearInterval(scrollTimer)
    scrollTimer = undefined
    setState(null)
  }

  createEffect(() => {
    const current = state()
    if (current && (options.blocked() || (current.dragging && !options.canReorder()) ||
      !options.projects().some((row) => row.id === current.id))) cancel()
  })
  onCleanup(cancel)

  function targetAt(current: Drag): DropTarget | null {
    const list = options.list()
    const rows = options.projects()
    if (!list || current.x < list.x || current.x >= list.x + list.width ||
      current.y < list.y || current.y >= list.y + list.height) return null
    let row = current.y - list.y
    if (current.dragging && current.target) {
      const gap = rows.findIndex((project) => project.id === current.target!.id) - current.offset +
        (current.target.placement === "after" ? 1 : 0)
      // The insertion line occupies a terminal row. Keep the destination stable over it.
      if (row === gap) return current.target
      if (row > gap) row--
    }
    const index = Math.min(rows.length - 1, current.offset + Math.min(row, projectVisibleCount(list.height, current.dragging) - 1))
    const project = rows[index]
    const source = rows.findIndex((project) => project.id === current.id)
    if (!project || index === source) return null
    return { id: project.id, placement: index < source ? "before" : "after" }
  }

  function scroll(delta: number) {
    const current = state()
    const list = options.list()
    if (!current?.dragging || !list) return false
    const offset = Math.max(0, Math.min(current.offset + delta, options.projects().length - projectVisibleCount(list.height, true)))
    if (offset !== current.offset) {
      const next = { ...current, offset }
      setState({ ...next, target: targetAt({ ...next, target: null }) })
    }
    return true
  }

  function start(id: string, event: MouseEvent) {
    if (options.blocked() || event.button !== 0) return
    cancel()
    const rows = options.projects()
    const selected = Math.max(0, rows.findIndex((row) => row.id === options.selectedId()))
    setState({ id, x: event.x, y: event.y,
      offset: projectListOffset(selected, rows.length, options.list()?.height ?? 1),
      activate: id === options.selectedId(), dragging: false, target: null })
    options.onSelect(id)
  }

  function move(event: MouseEvent) {
    const current = state()
    if (!current || event.button !== 0 || !options.canReorder()) return
    event.stopPropagation()
    event.preventDefault()
    if (!current.dragging && event.x === current.x && event.y === current.y) return
    const next = { ...current, x: event.x, y: event.y, dragging: true }
    setState({ ...next, target: targetAt(next) })
    if (!scrollTimer) scrollTimer = setInterval(() => {
      const drag = state()
      const list = options.list()
      if (!drag?.dragging || !list || drag.x < list.x || drag.x >= list.x + list.width) return
      if (drag.y <= list.y) scroll(-1)
      else if (drag.y >= list.y + list.height - 1) scroll(1)
    }, 150)
  }

  function end(event: MouseEvent) {
    const current = state()
    if (!current || event.button !== 0) return
    event.stopPropagation()
    const target = targetAt({ ...current, x: event.x, y: event.y })
    const list = options.list()
    const releasedOnSource = list && event.x >= list.x && event.x < list.x + list.width &&
      event.y >= list.y && event.y < list.y + list.height &&
      options.projects()[current.offset + event.y - list.y]?.id === current.id
    cancel()
    if (options.blocked()) return
    if (current.dragging && target && options.canReorder()) options.onReorder(current.id, target.id, target.placement)
    else if (!current.dragging && current.activate && releasedOnSource) options.onActivate()
  }

  return { state, start, move, end, scroll, cancel }
}

export type ProjectDrag = ReturnType<typeof createProjectDrag>
