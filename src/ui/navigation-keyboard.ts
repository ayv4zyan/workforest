import type { KeyEvent } from "@opentui/core"
import type { Pane, TreeGroup } from "./workspace.ts"

export type NavigationState = {
  searchEditing: boolean
  query: string
  pane: Pane
  focusRow: "header" | "panes" | "pane-actions"
  busy: boolean
  selectedIndex: number
  focusedGroup: TreeGroup | null
}

export type NavigationAction =
  | { type: "clear-search" | "stop-search" | "open-search" | "quit" | "refresh" }
  | { type: "cycle-row" | "move-selection"; delta: number }
  | { type: "focus-panes" | "focus-header" | "toggle-group" | "press-pane" | "press-header" }
  | { type: "open-menu"; pane: Pane }
  | { type: "add-project" | "unregister" | "new-tree" | "auto-rename" | "rename" | "delete" }

export function navigationKey(key: KeyEvent, state: NavigationState): NavigationAction | null {
  if (state.searchEditing) {
    if (key.name === "escape") {
      key.preventDefault()
      return { type: "clear-search" }
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      return { type: "stop-search" }
    }
    return null
  }
  if (key.name === "/" || key.sequence === "/") {
    key.preventDefault()
    return { type: "open-search" }
  }
  if (key.name === "escape" && state.query) {
    key.preventDefault()
    return { type: "clear-search" }
  }
  if (key.name === "q") return { type: "quit" }
  if (key.name === "g") return { type: "refresh" }
  if (key.name === "tab") return { type: "cycle-row", delta: key.shift ? -1 : 1 }
  if (key.name === "left") return { type: "cycle-row", delta: -1 }
  if (key.name === "right") return { type: "cycle-row", delta: 1 }
  if (key.name === "down") {
    key.preventDefault()
    return state.focusRow === "panes" ? { type: "move-selection", delta: 1 } : { type: "focus-panes" }
  }
  if (key.name === "up") {
    key.preventDefault()
    if (state.focusRow === "pane-actions") return { type: "focus-panes" }
    if (state.focusRow === "panes") return state.selectedIndex === 0 ? { type: "focus-header" } : { type: "move-selection", delta: -1 }
    return null
  }
  if (["space", "return", "enter"].includes(key.name) && state.pane === "trees" && state.focusRow === "panes" && state.focusedGroup) {
    key.preventDefault()
    return { type: "toggle-group" }
  }
  if (key.name === "return" || key.name === "enter") {
    if (state.focusRow === "pane-actions") {
      key.preventDefault()
      return { type: "press-pane" }
    }
    if (state.focusRow === "header") {
      key.preventDefault()
      return { type: "press-header" }
    }
    return null
  }
  if (key.name === "m" || (key.name === "f10" && key.shift)) {
    key.preventDefault()
    return { type: "open-menu", pane: state.pane }
  }
  if (state.busy) return null
  if (key.name === "a") return { type: "add-project" }
  if (key.name === "u") return { type: "unregister" }
  if (key.name === "n") return { type: "new-tree" }
  if (key.name === "r") return { type: key.shift ? "auto-rename" : "rename" }
  if (key.name === "d") return { type: "delete" }
  return null
}
