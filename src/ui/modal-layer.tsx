import { For, Show, createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { Project, ServerRow } from "../lib/types.ts"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import { SettingsForm, type SettingsFocus } from "./settings-modal.tsx"
import { modalBody, modalError, modalPlaceholder, modalSize, modalTitle, modalValue, type Modal, type ModalFocus } from "./modal-model.ts"
import type { TreeRow } from "./workspace.ts"
import type { createSettingsWorkflow } from "./settings-workflow.ts"
import type { createPathWorkflow } from "./path-workflow.ts"

function RenameProgress() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 100)
  onCleanup(() => clearInterval(timer))
  return <text id="rename-progress" height={1} fg={theme.accent} selectable={false}>{`${frames[frame()]} Generating a name…`}</text>
}

function LogsView(props: {
  draft: Extract<Modal, { kind: "logs" }>
  width: number
  onSelect: (index: number) => void
  onClose: () => void
}) {
  const renderer = useRenderer()
  const selected = () => props.draft.rows[props.draft.selectedIndex]!
  const label = (row: ServerRow) => `:${row.port} ${row.command}${row.owned ? "" : " · external"}`
  const multiple = () => props.draft.rows.length > 1
  const sidebar = () => multiple() && props.width >= 80
  const step = (delta: number) => props.onSelect((props.draft.selectedIndex + delta + props.draft.rows.length) % props.draft.rows.length)

  return <>
    <box flexGrow={1} minHeight={0} flexDirection={sidebar() ? "row" : "column"}>
      <Show when={sidebar()}>
        <box width={23} flexShrink={0} flexDirection="column" paddingRight={1}>
          <text height={1} fg={theme.muted} selectable={false}>Servers</text>
          <scrollbox flexGrow={1}>
            <For each={props.draft.rows}>{(row, index) => (
              <box
                id={`log-server-${index()}`}
                height={1}
                flexShrink={0}
                backgroundColor={props.draft.selectedIndex === index() ? theme.selectedBg : theme.header}
                onMouseOver={() => renderer.setMousePointer("pointer")}
                onMouseOut={() => renderer.setMousePointer("default")}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  if (event.button === 0) props.onSelect(index())
                }}
              >
                <text height={1} wrapMode="none" truncate selectable={false}
                  fg={props.draft.selectedIndex === index() ? theme.selectedFg : theme.text}>
                  {`${props.draft.selectedIndex === index() ? "▶" : " "} ${label(row)}`}
                </text>
              </box>
            )}</For>
          </scrollbox>
        </box>
      </Show>
      <box flexGrow={1} minWidth={0} flexDirection="column" border={sidebar() ? ["left"] : []}
        borderColor={theme.border} paddingLeft={sidebar() ? 1 : 0}>
        <Show when={multiple() && !sidebar()}>
          <box height={1} flexShrink={0} flexDirection="row" gap={1}>
            <ActionButton id="btn-previous-log" label="‹" compact onPress={() => step(-1)} />
            <box flexGrow={1} minWidth={0}>
              <text height={1} wrapMode="none" truncate selectable={false} fg={theme.accent}>
                {`${props.draft.selectedIndex + 1}/${props.draft.rows.length}  ${label(selected())}`}
              </text>
            </box>
            <ActionButton id="btn-next-log" label="›" compact onPress={() => step(1)} />
          </box>
        </Show>
        <Show when={!multiple() || sidebar()}>
          <text height={1} wrapMode="none" truncate selectable={false} fg={theme.accent}>
            {label(selected())}
          </text>
        </Show>
        <scrollbox flexGrow={1} focused={true}>
          <text fg={theme.text}>{props.draft.text}</text>
        </scrollbox>
      </box>
    </box>
    <box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Show when={multiple()} fallback={<text height={1} />}>
        <text height={1} fg={theme.muted} selectable={false}>
          {props.width >= 60 ? "Tab switches servers · ↑↓ scroll" : "Tab: server"}
        </text>
      </Show>
      <ActionButton id="btn-close-logs" label="close" onPress={props.onClose} />
    </box>
  </>
}

function StopPickerView(props: {
  draft: Extract<Modal, { kind: "stop-picker" }>
  focus: ModalFocus
  onToggle: (index: number) => void
  onFocus: (focus: ModalFocus) => void
  onStop: (all: boolean) => void
  onCancel: () => void
}) {
  const renderer = useRenderer()
  let list: ScrollBoxRenderable | undefined
  createEffect(() => {
    if (props.focus === "server") list?.scrollChildIntoView(`stop-server-${props.draft.highlighted}`)
  })
  return <>
    <scrollbox ref={(node) => { list = node }} flexGrow={1} minHeight={1}>
      <For each={props.draft.rows}>{(row, index) => {
        const highlighted = () => props.focus === "server" && props.draft.highlighted === index()
        const checked = () => props.draft.selected.includes(index())
        return <box
          id={`stop-server-${index()}`}
          height={1}
          flexShrink={0}
          backgroundColor={highlighted() ? theme.selectedBg : theme.panel}
          onMouseOver={() => renderer.setMousePointer("pointer")}
          onMouseOut={() => renderer.setMousePointer("default")}
          onMouseDown={(event) => {
            event.stopPropagation()
            if (event.button === 0) props.onToggle(index())
          }}
        >
          <text height={1} width="100%" wrapMode="none" truncate selectable={false}
            fg={highlighted() ? theme.selectedFg : theme.text}>
            {`${checked() ? "[x]" : "[ ]"} :${row.port}  ${row.command}  ·  ${row.owned ? "Workforest" : "external"}  ·  pid ${row.pid}`}
          </text>
        </box>
      }}</For>
    </scrollbox>
    <Show when={props.draft.rows.some((row) => !row.owned)}>
      <text height={1} wrapMode="none" truncate fg={theme.muted} selectable={false}>
        External servers were started outside Workforest.
      </text>
    </Show>
    <text height={1} wrapMode="none" truncate fg={theme.muted} selectable={false}>
      ↑↓ choose · Space select · Tab actions
    </text>
    <box flexDirection="row" justifyContent="flex-end" gap={1}>
      <ActionButton id="btn-stop-selected" label={`stop selected (${props.draft.selected.length})`}
        variant="danger" disabled={props.draft.selected.length === 0} active={props.focus === "submit"}
        onPress={() => { props.onFocus("submit"); props.onStop(false) }} />
      <ActionButton id="btn-stop-all" label="stop all" variant="danger" active={props.focus === "stop-all"}
        onPress={() => { props.onFocus("stop-all"); props.onStop(true) }} />
      <ActionButton id="btn-cancel" label="cancel" active={props.focus === "cancel"}
        onPress={() => { props.onFocus("cancel"); props.onCancel() }} />
    </box>
  </>
}

type ModalLayerProps = {
  model: {
    modal: Accessor<Modal | null>
    setModal: Setter<Modal | null>
    modalFocus: Accessor<ModalFocus>
    setModalFocus: Setter<ModalFocus>
    dimensions: Accessor<{ width: number; height: number }>
    selectedProject: () => Project | null
    selectedTree: () => TreeRow | null
    servers: Accessor<ServerRow[]>
    setModalInput: (node: InputRenderable) => void
  }
  settings: Pick<ReturnType<typeof createSettingsWorkflow>,
    "settingsOpen" | "setSettingsOpen" | "settingsHighlight" | "setSettingsHighlight" |
    "toggleSettings" | "pickSettings" | "setPrompt" | "saveSettings">
  paths: ReturnType<typeof createPathWorkflow>
  actions: {
    cancelModal: () => void
    abortRename: () => void
    submitModal: (value: string) => void
    selectLog: (index: number) => void
    toggleStopRow: (index: number) => void
    stopPicked: (all: boolean) => void
    toggleSourceMenu: () => void
    pickSource: (name: string) => void
    toggleRenameFolder: () => void
    acceptModal: () => void
  }
}

export function ModalLayer(props: ModalLayerProps) {
  const { modal, setModal, modalFocus, setModalFocus, dimensions,
    selectedProject, selectedTree, servers } = props.model
  const { settingsOpen, setSettingsOpen, settingsHighlight, setSettingsHighlight,
    toggleSettings, pickSettings, saveSettings } = props.settings
  const { pathListHeight, completionValue, visiblePaths, pathIndex, setPathIndex,
    pathSuggestions, applyPath } = props.paths
  const { cancelModal, submitModal, toggleSourceMenu, pickSource,
    toggleRenameFolder, acceptModal } = props.actions
  const renderer = useRenderer()
  let sourceClickClaimed = false
  function claimSourceClick() {
    sourceClickClaimed = true
    queueMicrotask(() => { sourceClickClaimed = false })
  }
  function pointAt() {
    renderer.setMousePointer("pointer")
    renderer.requestRender()
  }
  function pointAway() {
    renderer.setMousePointer("default")
    renderer.requestRender()
  }
  return <>
      <Show when={modal()?.kind === "auto-rename"}>
        <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={19}
          onMouseDown={(event) => { event.stopPropagation(); event.preventDefault() }}
          onMouseScroll={(event) => { event.stopPropagation(); event.preventDefault() }} />
      </Show>
      <Show when={modal()} fallback={<box width={0} height={0} />}>
        {(current: () => Modal) => (
          <box
            position="absolute"
            id="modal-dialog"
            left={modalSize(current(), dimensions().width, dimensions().height, pathListHeight()).left}
            top={modalSize(current(), dimensions().width, dimensions().height, pathListHeight()).top}
            width={modalSize(current(), dimensions().width, dimensions().height, pathListHeight()).width}
            height={modalSize(current(), dimensions().width, dimensions().height, pathListHeight()).height}
            zIndex={20}
            border
            borderColor={theme.accent}
            title={modalTitle(current())}
            titleColor={theme.accent}
            backgroundColor={theme.header}
            padding={1}
            flexDirection="column"
            gap={current().kind === "add-project" || current().kind === "settings" ? 0 : 1}
            onMouseDown={(event) => {
              event.stopPropagation()
              const open = modal()
              if (!sourceClickClaimed && open?.kind === "new-tree" && open.branchOpen) {
                setModal({ ...open, branchOpen: false })
              }
            }}
          >
            <Show when={current().kind !== "logs" && current().kind !== "settings"}>
              <text height={current().kind === "add-project" ? 1 : 2} overflow="hidden" fg={theme.text} selectable={false}>{modalBody(current(), selectedProject(), selectedTree(), servers())}</text>
            </Show>
            {current().kind === "settings" ? (
              <SettingsForm
                draft={current() as Extract<Modal, { kind: "settings" }>}
                error={(current() as Extract<Modal, { kind: "settings" }>).error}
                focus={modalFocus() as SettingsFocus}
                open={settingsOpen()}
                highlight={settingsHighlight()}
                onFocus={setModalFocus}
                onToggle={toggleSettings}
                onHighlight={setSettingsHighlight}
                onPick={pickSettings}
                onDismiss={() => setSettingsOpen(null)}
                onPrompt={props.settings.setPrompt}
                onSave={saveSettings}
                onCancel={cancelModal}
              />
            ) : current().kind === "logs" ? (
              <LogsView draft={current() as Extract<Modal, { kind: "logs" }>}
                width={modalSize(current(), dimensions().width, dimensions().height, pathListHeight()).width}
                onSelect={props.actions.selectLog} onClose={cancelModal} />
            ) : current().kind === "stop-picker" ? (
              <StopPickerView draft={current() as Extract<Modal, { kind: "stop-picker" }>}
                focus={modalFocus()} onToggle={props.actions.toggleStopRow} onFocus={setModalFocus}
                onStop={props.actions.stopPicked} onCancel={cancelModal} />
            ) : current().kind === "auto-rename" ? (
              <>
                <RenameProgress />
                <box flexDirection="row" justifyContent="flex-end">
                  <ActionButton id="btn-cancel-generation" label="cancel" active onPress={props.actions.abortRename} />
                </box>
              </>
            ) : (
              <>
                {"value" in current() ? (
                  <input
                    id="modal-input"
                    ref={props.model.setModalInput}
                    focused={modalFocus() === "input"}
                    value={modalValue(current())}
                    placeholder={modalPlaceholder(current())}
                    width="100%"
                    backgroundColor={theme.panel}
                    focusedBackgroundColor="#21262d"
                    textColor={theme.text}
                    cursorColor={theme.accent}
                    onMouseDown={() => setModalFocus("input")}
                    onInput={(value) => {
                      const now = modal()
                      if (now && "value" in now) setModal({ ...now, value, error: undefined })
                    }}
                    onSubmit={() => {
                      const now = modal()
                      if (now && "value" in now) submitModal(now.value)
                    }}
                  />
                ) : null}
                <Show when={current().kind === "new-tree"}>
                  {(() => {
                    const draft = current() as Extract<Modal, { kind: "new-tree" }>
                    const open = () => Boolean(draft.branchOpen)
                    const active = () => modalFocus() === "source" || open()
                    return (
                      <box flexGrow={1} flexShrink={0} flexDirection="column">
                        <text height={1} fg={active() ? theme.accent : theme.muted} selectable={false}>Source branch</text>
                        <box height={3} flexShrink={0}>
                          <box
                            id="source-branch"
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
                              claimSourceClick()
                              if (event.button !== 0) return
                              setModalFocus("source")
                              toggleSourceMenu()
                            }}
                          >
                            <text fg={theme.text} selectable={false} onMouseOver={pointAt} onMouseOut={pointAway}>{draft.source || "no branches"}</text>
                            <text fg={theme.muted} selectable={false} onMouseOver={pointAt} onMouseOut={pointAway}>{open() ? "▴" : "▾"}</text>
                          </box>
                        </box>
                        <Show when={open()}>
                          <box
                            id="source-branch-menu"
                            position="absolute"
                            top={4}
                            left={0}
                            width="100%"
                            height={draft.branches.length + 2}
                            zIndex={40}
                            border
                            borderColor={theme.accent}
                            backgroundColor={theme.header}
                            onMouseDown={(event) => {
                              event.stopPropagation()
                              claimSourceClick()
                            }}
                          >
                            <For each={draft.branches}>{(name, index) => {
                              const hot = () => settingsHighlight() === index()
                              const selected = () => name === draft.source
                              return (
                                <box
                                  height={1}
                                  flexShrink={0}
                                  paddingLeft={1}
                                  paddingRight={1}
                                  backgroundColor={hot() ? theme.selectedBg : theme.header}
                                  onMouseOver={() => { pointAt(); setSettingsHighlight(index()) }}
                                  onMouseOut={pointAway}
                                  onMouseDown={(event) => {
                                    event.stopPropagation()
                                    claimSourceClick()
                                    if (event.button === 0) pickSource(name)
                                  }}
                                >
                                  <text fg={hot() || selected() ? theme.selectedFg : theme.text} selectable={false} onMouseOver={() => { pointAt(); setSettingsHighlight(index()) }} onMouseOut={pointAway}>
                                    {`${selected() ? "●" : "○"} ${name}`}
                                  </text>
                                </box>
                              )
                            }}</For>
                          </box>
                        </Show>
                      </box>
                    )
                  })()}
                </Show>
                <Show when={current().kind === "add-project"}>
                  <box flexDirection="column" height={pathListHeight() + 2} flexShrink={0}>
                    <box height={pathListHeight()} flexShrink={0} flexDirection="column">
                      <Show when={!completionValue()?.trim()}>
                        <text height={1} fg={theme.muted} selectable={false}>Type a path to see matching directories.</text>
                      </Show>
                      <For each={visiblePaths()}>{(row) => (
                        <box id={`path-suggestion-${row.index}`} height={1} flexShrink={0}
                          backgroundColor={pathIndex() === row.index ? theme.selectedBg : theme.panel}
                          onMouseDown={(event) => { if (event.button === 0) applyPath(row.index) }}
                          onMouseScroll={(event) => {
                            setPathIndex(Math.max(0, Math.min(pathSuggestions().length - 1, pathIndex() + (event.scroll?.direction === "up" ? -1 : 1))))
                            setModalFocus("input")
                          }}>
                          <text truncate fg={pathIndex() === row.index ? theme.selectedFg : theme.text} selectable={false}>{`${pathIndex() === row.index ? "▶" : " "} ${row.name}/`}</text>
                        </box>
                      )}</For>
                    </box>
                    <text height={1} fg={theme.muted} selectable={false}>Tab / → complete · ↑↓ choose · Enter pick / submit</text>
                    <text height={1} fg={theme.muted} selectable={false}>{!completionValue()?.trim() ? "Absolute, relative and ~/ paths" : pathSuggestions().length ? `${pathSuggestions().length}${pathSuggestions().length === 20 ? "+" : ""} directories · type to narrow` : "No matching directories"}</text>
                  </box>
                </Show>
                <Show when={current().kind === "rename"}>
                  <ActionButton
                    id="btn-rename-folder"
                    compact
                    label={`${(current() as Extract<Modal, { kind: "rename" }>).renameFolder ? "[x]" : "[ ]"} Also rename worktree folder`}
                    active={modalFocus() === "rename-folder"}
                    onPress={() => {
                      setModalFocus("rename-folder")
                      toggleRenameFolder()
                    }}
                  />
                </Show>
                <text fg={theme.danger} selectable={false}>{modalError(current()) ?? ""}</text>
                <box flexDirection="row" justifyContent="flex-end" gap={1}>
                  <ActionButton
                    id="btn-submit"
                    label={"value" in current() ? "submit" : "confirm"}
                    variant="accent"
                    active={modalFocus() === "submit"}
                    onPress={() => {
                      setModalFocus("submit")
                      acceptModal()
                    }}
                  />
                  <ActionButton
                    id="btn-cancel"
                    label="cancel"
                    active={modalFocus() === "cancel"}
                    onPress={() => {
                      setModalFocus("cancel")
                      cancelModal()
                    }}
                  />
                </box>
              </>
            )}
          </box>
        )}
      </Show>
  </>
}
