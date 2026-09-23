import { For, Show, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import {
  promptSoftLimit,
  reasoningChoices,
  renameModels,
  type AutoRenameSettings,
} from "../lib/auto-rename-settings.ts"

export type SettingsFocus = "provider" | "model" | "reasoning" | "prompt" | "save" | "retry" | "cancel"
export type SettingsField = "provider" | "model" | "reasoning"

const fieldOrder: SettingsFocus[] = ["provider", "model", "reasoning", "prompt", "save", "cancel"]

export function settingsFocusOrder(hasError: boolean): SettingsFocus[] {
  return hasError ? ["provider", "model", "reasoning", "prompt", "retry", "save", "cancel"] : fieldOrder
}

function choices(field: SettingsField, draft: AutoRenameSettings): { value: string; label: string }[] {
  if (field === "provider") return [{ value: "codex", label: "Codex" }]
  if (field === "model") return renameModels(draft.model).map((model) => ({ value: model, label: model }))
  return reasoningChoices(draft.model, undefined, draft.reasoning).map((level) => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) }))
}

function fieldValue(field: SettingsField, draft: AutoRenameSettings): string {
  if (field === "provider") return "Codex"
  if (field === "model") return draft.model
  return draft.reasoning.charAt(0).toUpperCase() + draft.reasoning.slice(1)
}

export function SettingsForm(props: {
  draft: AutoRenameSettings
  error?: string
  focus: SettingsFocus
  open: SettingsField | null
  highlight: number
  onFocus: (focus: SettingsFocus) => void
  onToggle: (field: SettingsField) => void
  onHighlight: (index: number) => void
  onPick: (field: SettingsField, value: string) => void
  onDismiss: () => void
  onPrompt: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const renderer = useRenderer()
  const [count, setCount] = createSignal(props.draft.prompt.length)
  const over = () => count() > promptSoftLimit
  let promptArea: TextareaRenderable | undefined
  let clickClaimed = false

  function claimClick() {
    clickClaimed = true
    queueMicrotask(() => { clickClaimed = false })
  }

  function pointAt() {
    renderer.setMousePointer("pointer")
    renderer.requestRender()
  }

  function pointAway() {
    renderer.setMousePointer("default")
    renderer.requestRender()
  }

  function menuTop(field: SettingsField): number {
    const provider = 1 + 3
    const model = provider + 1 + 3
    if (field === "provider") return provider
    if (field === "model") return model
    return model + 1 + 3
  }

  function menu(field: SettingsField) {
    const options = choices(field, props.draft)
    const selectedValue = field === "provider" ? "codex" : field === "model" ? props.draft.model : props.draft.reasoning
    return (
      <box
        id={`settings-menu-${field}`}
        position="absolute"
        top={menuTop(field)}
        left={1}
        right={0}
        height={options.length + 2}
        zIndex={40}
        border
        borderColor={theme.accent}
        backgroundColor={theme.header}
        onMouseDown={(event) => {
          event.stopPropagation()
          claimClick()
        }}
      >
        <For each={options}>{(option, index) => {
          const selected = () => option.value === selectedValue
          const hot = () => props.highlight === index()
          return (
            <box
              height={1}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={hot() ? theme.selectedBg : theme.header}
              onMouseOver={() => { pointAt(); props.onHighlight(index()) }}
              onMouseOut={pointAway}
              onMouseDown={(event) => {
                event.stopPropagation()
                claimClick()
                if (event.button === 0) props.onPick(field, option.value)
              }}
            >
              <text fg={hot() || selected() ? theme.selectedFg : theme.text} selectable={false} onMouseOver={() => { pointAt(); props.onHighlight(index()) }} onMouseOut={pointAway}>
                {`${selected() ? "●" : "○"} ${option.label}`}
              </text>
            </box>
          )
        }}</For>
      </box>
    )
  }

  function field(id: SettingsField, label: string) {
    const open = () => props.open === id
    const active = () => props.focus === id || open()
    return (
      <box flexDirection="column" gap={0} flexShrink={0}>
        <text height={1} fg={active() ? theme.accent : theme.muted} selectable={false}>{label}</text>
        <box height={3} flexShrink={0}>
          <box
            id={`settings-${id}`}
            height={3}
            border
            borderColor={active() ? theme.accent : theme.border}
            backgroundColor={active() ? "#21262d" : theme.panel}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            onMouseOver={pointAt}
            onMouseOut={pointAway}
            onMouseDown={(event) => {
              event.stopPropagation()
              claimClick()
              if (event.button !== 0) return
              props.onFocus(id)
              props.onToggle(id)
            }}
          >
            <text fg={theme.text} selectable={false} onMouseOver={pointAt} onMouseOut={pointAway}>{fieldValue(id, props.draft)}</text>
            <text fg={theme.muted} selectable={false} onMouseOver={pointAt} onMouseOut={pointAway}>{open() ? "▴" : "▾"}</text>
          </box>
        </box>
      </box>
    )
  }

  return (
    <box flexGrow={1} flexDirection="row" gap={1} onMouseDown={() => { if (!clickClaimed && props.open) props.onDismiss() }}>
      <box width={16} flexShrink={0} border borderColor={theme.border} backgroundColor={theme.panel} flexDirection="column">
        <box height={1} paddingLeft={1} backgroundColor={theme.selectedBg}>
          <text fg={theme.selectedFg} selectable={false}>Auto rename</text>
        </box>
      </box>
      <box flexGrow={1} flexDirection="column" gap={0} paddingLeft={1}>
        <box flexGrow={1} flexDirection="column" gap={0}>
        {field("provider", "Provider")}
        {field("model", "Model")}
        {field("reasoning", "Reasoning")}
        <text height={1} flexShrink={0} fg={props.focus === "prompt" ? theme.accent : theme.muted} selectable={false}>Prompt</text>
        <box flexGrow={1} minHeight={4} border borderColor={props.focus === "prompt" ? theme.accent : theme.border} backgroundColor={theme.panel}>
          <textarea
            id="settings-prompt"
            ref={(node) => { promptArea = node }}
            width="100%"
            height="100%"
            focused={props.focus === "prompt" && !props.open}
            initialValue={props.draft.prompt}
            placeholder=""
            backgroundColor={theme.panel}
            focusedBackgroundColor="#21262d"
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.muted}
            onMouseDown={() => props.onFocus("prompt")}
            onContentChange={() => {
              const text = promptArea?.plainText ?? ""
              setCount(text.length)
              props.onPrompt(text)
            }}
          />
        </box>
        <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
          <text fg={over() ? theme.warn : theme.muted} selectable={false}>{`${count()} / ${promptSoftLimit}`}</text>
        </box>
        </box>
        <Show when={props.error}>
        <box height={1} flexShrink={0}>
          <text fg={theme.danger} selectable={false}>{props.error}</text>
        </box>
      </Show>
      <box
        height={3}
        flexShrink={0}
        marginTop={1}
        border={["top"]}
        borderColor={theme.border}
        flexDirection="row"
        justifyContent="flex-end"
        alignItems="center"
        gap={1}
        paddingRight={1}
      >
        <Show when={props.error}>
          <ActionButton id="btn-settings-retry" label="Retry" active={props.focus === "retry"} onPress={() => { props.onFocus("retry"); props.onSave() }} />
        </Show>
        <ActionButton id="btn-settings-save" label="Save" variant="accent" active={props.focus === "save"} onPress={() => { props.onFocus("save"); props.onSave() }} />
        <ActionButton id="btn-settings-cancel" label="Cancel" active={props.focus === "cancel"} onPress={() => { props.onFocus("cancel"); props.onCancel() }} />
      </box>
        <Show when={props.open} keyed>{(field: SettingsField) => menu(field)}</Show>
      </box>
    </box>
  )
}
