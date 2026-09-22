import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { completePath, type PathSuggestion } from "../lib/path-completion.ts"
import type { Modal, ModalFocus } from "./modal-model.ts"

export function createPathWorkflow(options: {
  modal: Accessor<Modal | null>
  setModal: Setter<Modal | null>
  setModalFocus: Setter<ModalFocus>
  terminalHeight: () => number
  input: () => InputRenderable | undefined
}) {
  const [pathSuggestions, setPathSuggestions] = createSignal<PathSuggestion[]>([])
  const [pathIndex, setPathIndex] = createSignal(-1)
  const completionValue = createMemo(() => {
    const current = options.modal()
    return current?.kind === "add-project" ? current.value : null
  })

  createEffect(() => {
    const value = completionValue()
    setPathSuggestions([])
    setPathIndex(-1)
    if (value === null) return
    const request = new AbortController()
    const timer = setTimeout(async () => {
      const suggestions = await completePath(value, request.signal)
      if (!request.signal.aborted) setPathSuggestions(suggestions)
    }, 60)
    onCleanup(() => { clearTimeout(timer); request.abort() })
  })

  // Reserve the same suggestion space even while loading or showing no matches.
  const pathListHeight = () => Math.min(4, Math.max(1, options.terminalHeight() - 14))
  const visiblePaths = () => {
    const start = Math.max(0, pathIndex() - pathListHeight() + 1)
    return pathSuggestions().slice(start, start + pathListHeight()).map((row, index) => ({ ...row, index: start + index }))
  }
  function applyPath(index = Math.max(0, pathIndex())) {
    const suggestion = pathSuggestions()[index]
    const current = options.modal()
    if (!suggestion || current?.kind !== "add-project") return
    options.setModal({ ...current, value: suggestion.value, error: undefined })
    setPathIndex(-1)
    options.setModalFocus("input")
    const input = options.input()
    if (input) input.cursorOffset = suggestion.value.length
  }

  return { pathSuggestions, pathIndex, setPathIndex, completionValue, pathListHeight, visiblePaths, applyPath }
}
