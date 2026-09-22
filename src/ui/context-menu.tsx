import { For, Show, createSignal, type Accessor } from "solid-js"
import type { KeyEvent } from "@opentui/core"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import type { Pane } from "./workspace.ts"

export type MenuAction = {
  id: string
  label: string
  trailingLabel?: string
  variant?: "accent" | "danger"
  disabled?: boolean
  onPress: () => void
}
export type RowMenu = { pane: Pane; x: number; y: number; renameOpen: boolean }

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

  function openRenameSubmenu() {
    const current = menu()
    if (!current || current.pane !== "trees" || options.actions()[0]?.disabled) return
    setMenu({ ...current, renameOpen: true })
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
    if (menu()?.pane === "trees" && index === 0) {
      openRenameSubmenu()
      return
    }
    setMenu(null)
    action.onPress()
  }

  function handleKey(key: KeyEvent) {
    key.preventDefault()
    if (menu()?.renameOpen) {
      if (key.name === "escape" || key.name === "left") {
        setMenu((current) => current ? { ...current, renameOpen: false } : null)
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
    } else if (key.name === "right" && menu()?.pane === "trees" && menuIndex() === 0) openRenameSubmenu()
    else if (["return", "enter"].includes(key.name)) pressMenu()
  }

  function actionMenuWidth(actions: MenuAction[], maxWidth = 24): number {
    const contentWidth = Math.max(...actions.map((action) => action.label.length + (action.trailingLabel ? action.trailingLabel.length + 1 : 0)))
    return Math.min(options.dimensions().width, maxWidth, Math.max(12, contentWidth + 4))
  }
  const contextMenuWidth = () => actionMenuWidth(options.actions())
  const contextMenuHeight = () => options.actions().length + 2
  const renameSubmenuWidth = () => actionMenuWidth(options.submenuActions(), 20)

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
            <ActionButton id={action.id} label={action.label} compact variant={action.variant}
              trailingLabel={action.trailingLabel}
              disabled={action.disabled} active={menuIndex() === index()} onPress={() => pressMenu(index())}
              onHover={() => {
                setMenuIndex(index())
                const now = menu()
                if (!now) return
                if (now.pane === "trees" && index() === 0) openRenameSubmenu()
                else if (now.renameOpen) setMenu({ ...now, renameOpen: false })
              }} />
          }</For>
        </box>
        <Show when={current().renameOpen}>
          <box id="rename-submenu" position="absolute"
            left={(() => {
              const mainLeft = Math.max(0, Math.min(current().x, options.dimensions().width - contextMenuWidth()))
              return mainLeft + contextMenuWidth() + renameSubmenuWidth() - 1 <= options.dimensions().width
                ? mainLeft + contextMenuWidth() - 1
                : Math.max(0, mainLeft - renameSubmenuWidth() + 1)
            })()}
            top={Math.max(0, Math.min(current().y, options.dimensions().height - contextMenuHeight()))}
            width={renameSubmenuWidth()} height={4} zIndex={31}
            border borderColor={theme.accent} backgroundColor={theme.panel}
            onMouseDown={(event) => event.stopPropagation()}>
            <For each={options.submenuActions()}>{(action, index) =>
              <ActionButton id={action.id} label={action.label} compact disabled={action.disabled}
                active={submenuIndex() === index()} onPress={() => pressSubmenu(index())}
                onHover={() => setSubmenuIndex(index())} />
            }</For>
          </box>
        </Show>
      </>}
    </Show>
  }

  return { menu, setMenu, open, openRenameSubmenu, handleKey, Layer }
}
