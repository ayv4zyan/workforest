import { For, Show, createSignal, type Accessor } from "solid-js"
import type { KeyEvent } from "@opentui/core"
import { theme } from "../theme.ts"
import type { PullRequest, PullRequestState } from "../lib/branch-metadata.ts"
import { ActionButton } from "./button.tsx"
import type { Pane } from "./workspace.ts"

export type MenuAction = {
  id: string
  label: string
  submenu?: "rename" | "git"
  trailingLabel?: string
  variant?: "accent" | "danger"
  disabled?: boolean
  onPress: () => void
}
export type RowMenu =
  | { pane: Pane; x: number; y: number; submenu: "rename" | "git" | null }
  | { pane: "pr"; x: number; y: number; submenu: null; pr: PullRequest; cwd: string; state: PullRequestState | null }

export function createContextMenu(options: {
  dimensions: Accessor<{ width: number; height: number }>
  actions: () => MenuAction[]
  submenuActions: () => MenuAction[]
}) {
  const [menu, setMenu] = createSignal<RowMenu | null>(null)
  const [menuIndex, setMenuIndex] = createSignal(0)
  const [submenuIndex, setSubmenuIndex] = createSignal(0)

  function open(next: RowMenu) {
    setMenuIndex(0)
    setSubmenuIndex(0)
    setMenu(next)
  }

  function openSubmenu(kind: "rename" | "git") {
    const current = menu()
    const action = options.actions().find((action) => action.submenu === kind)
    if (!current || current.pane !== "trees" || !action || action.disabled) return
    if (current.submenu === kind) return
    setMenu({ ...current, submenu: kind })
    setSubmenuIndex(0)
  }

  function pressSubmenu(index = submenuIndex()) {
    const action = options.submenuActions()[index]
    if (!action || action.disabled) return
    setMenu(null)
    action.onPress()
  }

  function pressMenu(index = menuIndex()) {
    const action = options.actions()[index]
    if (!action || action.disabled) return
    if (action.submenu) {
      openSubmenu(action.submenu)
      return
    }
    setMenu(null)
    action.onPress()
  }

  function handleKey(key: KeyEvent) {
    key.preventDefault()
    if (menu()?.submenu) {
      if (key.name === "escape" || key.name === "left") {
        setMenu((current) => current ? { ...current, submenu: null } : null)
      } else if (["up", "down", "tab"].includes(key.name)) {
        const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1
        setSubmenuIndex((submenuIndex() + delta + options.submenuActions().length) % options.submenuActions().length)
      } else if (["return", "enter"].includes(key.name)) pressSubmenu()
      return
    }
    if (key.name === "escape") setMenu(null)
    else if (["up", "down", "tab"].includes(key.name)) {
      const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1
      setMenuIndex((menuIndex() + delta + options.actions().length) % options.actions().length)
    } else if (key.name === "right") {
      const kind = options.actions()[menuIndex()]?.submenu
      if (kind) openSubmenu(kind)
    }
    else if (["return", "enter"].includes(key.name)) pressMenu()
  }

  function actionMenuWidth(actions: MenuAction[], maxWidth = 24): number {
    const contentWidth = Math.max(...actions.map((action) => action.label.length + (action.trailingLabel ? action.trailingLabel.length + 1 : 0)))
    return Math.min(options.dimensions().width, maxWidth, Math.max(12, contentWidth + 4))
  }
  const contextMenuWidth = () => actionMenuWidth(options.actions())
  const contextMenuHeight = () => options.actions().length + 2
  const submenuWidth = () => actionMenuWidth(options.submenuActions(), 20)

  function Layer() {
    return <Show when={menu()}>
      {(current: () => RowMenu) => <>
        <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={29}
          onMouseDown={(event) => { event.stopPropagation(); event.preventDefault(); setMenu(null) }}
          onMouseScroll={(event) => { event.stopPropagation(); event.preventDefault() }} />
        <box id="context-menu" position="absolute"
          left={Math.max(0, Math.min(current().x, options.dimensions().width - contextMenuWidth()))}
          top={Math.max(0, Math.min(current().y, options.dimensions().height - contextMenuHeight()))}
          width={contextMenuWidth()} height={contextMenuHeight()} zIndex={30}
          border borderColor={theme.accent} backgroundColor={theme.panel}
          onMouseDown={(event) => event.stopPropagation()}>
          <For each={options.actions()}>{(action, index) =>
            <ActionButton id={action.id} label={action.label} compact align="left" variant={action.variant}
              trailingLabel={action.trailingLabel}
              disabled={action.disabled} active={menuIndex() === index()} onPress={() => pressMenu(index())}
              onHover={() => {
                setMenuIndex(index())
                const now = menu()
                if (!now) return
                if (action.submenu) openSubmenu(action.submenu)
                else if (now.submenu) setMenu({ ...now, submenu: null })
              }} />
          }</For>
        </box>
        <Show when={current().submenu}>
          <box id={`${current().submenu}-submenu`} position="absolute"
            left={(() => {
              const mainLeft = Math.max(0, Math.min(current().x, options.dimensions().width - contextMenuWidth()))
              return mainLeft + contextMenuWidth() + submenuWidth() - 1 <= options.dimensions().width
                ? mainLeft + contextMenuWidth() - 1
                : Math.max(0, mainLeft - submenuWidth() + 1)
            })()}
            top={Math.max(0, Math.min(
              Math.max(0, Math.min(current().y, options.dimensions().height - contextMenuHeight())) + options.actions().findIndex((action) => action.submenu === current().submenu),
              options.dimensions().height - options.submenuActions().length - 2))}
            width={submenuWidth()} height={options.submenuActions().length + 2} zIndex={31}
            border borderColor={theme.accent} backgroundColor={theme.panel}
            onMouseDown={(event) => event.stopPropagation()}>
            <For each={options.submenuActions()}>{(action, index) =>
              <ActionButton id={action.id} label={action.label} compact align="left" disabled={action.disabled}
                active={submenuIndex() === index()} onPress={() => pressSubmenu(index())}
                onHover={() => setSubmenuIndex(index())} />
            }</For>
          </box>
        </Show>
      </>}
    </Show>
  }

  return { menu, setMenu, open, openSubmenu, handleKey, Layer }
}
