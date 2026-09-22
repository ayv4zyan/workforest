import { createSignal, type Accessor, type Setter } from "solid-js"
import { loadAutoRename, reasoningChoices, renameModels, resolveReasoning, saveAutoRename } from "../lib/auto-rename-settings.ts"
import type { Modal, ModalFocus } from "./modal-model.ts"
import type { SettingsField } from "./settings-modal.tsx"

export function settingsOptions(field: SettingsField, current: Extract<Modal, { kind: "settings" }>): string[] {
  if (field === "provider") return ["codex"]
  if (field === "model") return [...renameModels]
  return [...reasoningChoices(current.model)]
}

export function createSettingsWorkflow(options: {
  home: () => string
  modal: Accessor<Modal | null>
  setModal: Setter<Modal | null>
  setModalFocus: Setter<ModalFocus>
  setStatus: Setter<string>
}) {
  const [settingsOpen, setSettingsOpen] = createSignal<SettingsField | null>(null)
  const [settingsHighlight, setSettingsHighlight] = createSignal(0)
  let prompt = ""

  function openSettings() {
    const loaded = loadAutoRename(options.home())
    prompt = loaded.prompt
    setSettingsOpen(null)
    setSettingsHighlight(0)
    options.setModal({ kind: "settings", ...loaded })
    options.setModalFocus("provider")
  }

  function toggleSettings(field: SettingsField) {
    const current = options.modal()
    if (current?.kind !== "settings") return
    if (settingsOpen() === field) {
      setSettingsOpen(null)
      return
    }
    const choices = settingsOptions(field, current)
    const selected = field === "model" ? current.model : field === "reasoning" ? current.reasoning : "codex"
    setSettingsHighlight(Math.max(0, choices.indexOf(selected)))
    setSettingsOpen(field)
    options.setModalFocus(field)
  }

  function pickSettings(field: SettingsField, value: string) {
    options.setModal((current) => {
      if (current?.kind !== "settings") return current
      if (field === "model") return { ...current, model: value, reasoning: resolveReasoning(value, current.reasoning), error: undefined }
      if (field === "reasoning") return { ...current, reasoning: value, error: undefined }
      return { ...current, error: undefined }
    })
    setSettingsOpen(null)
  }

  function saveSettings() {
    const current = options.modal()
    if (current?.kind !== "settings") return
    try {
      saveAutoRename(options.home(), { provider: "codex", model: current.model, reasoning: current.reasoning, prompt })
      setSettingsOpen(null)
      options.setModal(null)
      options.setStatus("saved auto-rename settings")
    } catch {
      options.setModal({ ...current, error: "Couldn't save settings" })
      options.setModalFocus("retry")
    }
  }

  return {
    settingsOpen, setSettingsOpen, settingsHighlight, setSettingsHighlight,
    setPrompt: (value: string) => { prompt = value },
    openSettings, toggleSettings, pickSettings, saveSettings,
  }
}
