import type { InputRenderable, KeyEvent } from "@opentui/core"
import type { Accessor, Setter } from "solid-js"
import { settingsFocusOrder, type SettingsField } from "./settings-modal.tsx"
import { settingsOptions } from "./settings-workflow.ts"
import type { Modal, ModalFocus } from "./modal-model.ts"
import type { PathSuggestion } from "../lib/path-completion.ts"

type Context = {
  model: {
    modal: Accessor<Modal | null>
    setModal: Setter<Modal | null>
    modalFocus: Accessor<ModalFocus>
    setModalFocus: Setter<ModalFocus>
    cycleModalFocus: (delta: number) => void
    handleModalArrow: (name: string, preventDefault: () => void) => void
    cancelModal: () => void
    acceptModal: () => void
    toggleSourceMenu: () => void
    pickSource: (name: string) => void
    toggleRenameFolder: () => void
    abortRename: () => void
  }
  settings: {
    settingsOpen: Accessor<SettingsField | null>
    setSettingsOpen: Setter<SettingsField | null>
    settingsHighlight: Accessor<number>
    setSettingsHighlight: Setter<number>
    pickSettings: (field: SettingsField, value: string) => void
    toggleSettings: (field: SettingsField) => void
    saveSettings: () => void
  }
  path: {
    pathSuggestions: Accessor<PathSuggestion[]>
    pathIndex: Accessor<number>
    setPathIndex: Setter<number>
    input: () => InputRenderable | undefined
    applyPath: (index?: number) => void
  }
}

export function handleModalKey(key: KeyEvent, context: Context) {
  const {
    modal, setModal, modalFocus, setModalFocus, cycleModalFocus, handleModalArrow,
    cancelModal, acceptModal, toggleSourceMenu, pickSource, toggleRenameFolder, abortRename,
  } = context.model
  const {
    settingsOpen, setSettingsOpen, settingsHighlight, setSettingsHighlight,
    pickSettings, toggleSettings, saveSettings,
  } = context.settings
  const { pathSuggestions, pathIndex, setPathIndex, input, applyPath } = context.path
      if (modal()?.kind === "settings") {
        const open = settingsOpen()
        const current = modal()
        if (current?.kind !== "settings") return
        const options = open ? settingsOptions(open, current) : []
        if (open) {
          key.preventDefault()
          if (key.name === "escape") setSettingsOpen(null)
          else if (key.name === "up" || key.name === "down") {
            const delta = key.name === "up" ? -1 : 1
            setSettingsHighlight((settingsHighlight() + delta + options.length) % options.length)
          } else if (["return", "enter"].includes(key.name)) {
            const value = options[settingsHighlight()]
            if (value) pickSettings(open, value)
          }
          return
        }
        if (modalFocus() === "prompt") {
          if (key.name === "escape") {
            key.preventDefault()
            cancelModal()
          } else if (key.name === "tab") {
            key.preventDefault()
            cycleModalFocus(key.shift ? -1 : 1)
          }
          return
        }
        key.preventDefault()
        if (key.name === "escape") cancelModal()
        else if (key.name === "tab" || key.name === "up" || key.name === "down") {
          const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1
          cycleModalFocus(delta)
        } else if (key.name === "left" || key.name === "right") {
          const items = settingsFocusOrder(Boolean(current.error)).filter((item) => item === "retry" || item === "save" || item === "cancel")
          const focus = modalFocus()
          const index = items.findIndex((item) => item === focus)
          if (index >= 0) {
            const delta = key.name === "left" ? -1 : 1
            setModalFocus(items[(index + delta + items.length) % items.length]!)
          }
        } else if (["return", "enter", "space"].includes(key.name)) {
          const focus = modalFocus()
          if (focus === "provider" || focus === "model" || focus === "reasoning") toggleSettings(focus)
          else if (focus === "save" || focus === "retry") saveSettings()
          else if (focus === "cancel") cancelModal()
        }
        return
      }
      if (modal()?.kind === "auto-rename") {
        key.preventDefault()
        if (["escape", "enter", "return"].includes(key.name)) abortRename()
        return
      }
      const openTreeModal = modal()
      if (openTreeModal?.kind === "new-tree" && openTreeModal.branchOpen) {
        const branches = openTreeModal.branches
        key.preventDefault()
        if (key.name === "escape") {
          setModal({ ...openTreeModal, branchOpen: false })
        } else if (key.name === "up" || key.name === "down") {
          const delta = key.name === "up" ? -1 : 1
          const count = Math.max(1, branches.length)
          setSettingsHighlight((settingsHighlight() + delta + count) % count)
        } else if (["return", "enter"].includes(key.name)) {
          const value = branches[settingsHighlight()]
          if (value) pickSource(value)
        }
        return
      }
      if (modal()?.kind === "logs") {
        if (["escape", "enter", "return"].includes(key.name)) {
          key.preventDefault()
          cancelModal()
        }
        return
      }
      if (key.name === "escape") {
        cancelModal()
        return
      }
      if (modal()?.kind === "add-project" && modalFocus() === "input" && pathSuggestions().length) {
        if ((key.name === "tab" && !key.shift) || (key.name === "right" && input()?.cursorOffset === input()?.value.length)) {
          key.preventDefault()
          applyPath()
          return
        }
        if (key.name === "down" || key.name === "up") {
          key.preventDefault()
          const next = pathIndex() + (key.name === "down" ? 1 : -1)
          if (next >= pathSuggestions().length) { setPathIndex(-1); setModalFocus("submit") }
          else setPathIndex(Math.max(-1, next))
          return
        }
        if (["return", "enter"].includes(key.name) && pathIndex() >= 0) {
          key.preventDefault()
          applyPath()
          return
        }
      }
      if (key.name === "tab") {
        key.preventDefault()
        cycleModalFocus(key.shift ? -1 : 1)
        return
      }
      if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down") {
        handleModalArrow(key.name, () => key.preventDefault())
        return
      }
      if (modalFocus() === "source" && ["space", "return", "enter"].includes(key.name)) {
        key.preventDefault()
        toggleSourceMenu()
        return
      }
      if (modalFocus() === "rename-folder" && ["space", "return", "enter"].includes(key.name)) {
        key.preventDefault()
        toggleRenameFolder()
        return
      }
      if (key.name === "return" || key.name === "enter") {
        if (modalFocus() === "cancel") {
          key.preventDefault()
          cancelModal()
        } else if (modalFocus() === "submit") {
          key.preventDefault()
          acceptModal()
        }
      }
}
