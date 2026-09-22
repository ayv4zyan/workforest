import { For, Show, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { nextIndex } from "../lib/select-hit.ts"
import type { Project } from "../lib/types.ts"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"

type Props = {
  width: number
  active: boolean
  selectedPane: boolean
  actionActive: boolean
  busy: boolean
  blocked: boolean
  query: string
  projects: Project[]
  selectedId: string | null
  onFocus: () => void
  onAdd: () => void
  onSelect: (id: string) => void
  onActivate: () => void
  onMenu: (x: number, y: number) => void
  onListLayout: (node: BoxRenderable, height: number) => void
}

function visibleRows<T>(rows: T[], selected: number, height: number) {
  const count = Math.max(1, height)
  const offset = Math.max(0, Math.min(selected - Math.floor(count / 2), rows.length - count))
  return rows.slice(offset, offset + count).map((row, index) => ({ row, index: offset + index }))
}

export function ProjectPane(props: Props) {
  const renderer = useRenderer()
  const [listHeight, setListHeight] = createSignal(0)
  const [hoveredIndex, setHoveredIndex] = createSignal<number | null>(null)
  const selectedIndex = () => Math.max(0, props.projects.findIndex((project) => project.id === props.selectedId))

  function wheel(event: MouseEvent) {
    props.onFocus()
    event.stopPropagation()
    if (props.blocked) return
    const direction = event.scroll?.direction
    const delta = direction === "down" || direction === "right" ? 1 : direction === "up" || direction === "left" ? -1 : 0
    if (!delta) return
    const project = props.projects[nextIndex(selectedIndex(), props.projects.length, delta)]
    if (project) props.onSelect(project.id)
  }

  return <box
    id="pane-projects"
    width={props.width}
    border={["top", "bottom", "left"]}
    borderColor={props.active ? theme.borderFocus : theme.border}
    titleColor={props.active ? theme.accent : theme.muted}
    backgroundColor={theme.panel}
    onMouseDown={() => { if (!props.blocked) props.onFocus() }}
  >
    <box height={1} flexDirection="row" gap={1}>
      <ActionButton id="btn-add" label="+" compact disabled={props.busy}
        active={props.actionActive} onPress={() => { props.onFocus(); props.onAdd() }} />
      <text fg={props.selectedPane ? theme.accent : theme.muted} selectable={false}>{`projects (${props.projects.length})${props.query ? ` /${props.query}` : ""}`}</text>
    </box>
    <Show when={props.projects.length > 0} fallback={
      <box onMouseDown={(event) => { event.stopPropagation(); if (!props.query) props.onAdd() }}>
        <text fg={theme.muted} selectable={false}>{props.query ? "no matching projects" : "no projects"}</text>
      </box>
    }>
      <box flexGrow={1} flexDirection="row" ref={(node) => {
        node.onSizeChange = () => setListHeight(node.height)
        setListHeight(node.height)
      }}>
        <box ref={(node) => {
          node.onSizeChange = () => props.onListLayout(node, node.height)
          props.onListLayout(node, node.height)
        }}
          flexGrow={1} flexDirection="column" overflow="hidden"
          onMouseScroll={wheel}>
          <For each={visibleRows(props.projects, selectedIndex(), listHeight())}>{({ row: project, index }) => {
            const selected = () => index === selectedIndex()
            return <box height={1} flexShrink={0} overflow="hidden"
              backgroundColor={selected()
                ? hoveredIndex() === index ? theme.selectedHoverBg : theme.selectedBg
                : hoveredIndex() === index ? theme.hoverBg : theme.panel}
              onMouseOver={() => { setHoveredIndex(index); renderer.setMousePointer("pointer") }}
              onMouseOut={() => { setHoveredIndex(null); renderer.setMousePointer("default") }}
              onMouseDown={(event) => {
                event.stopPropagation()
                if (props.blocked || (event.button !== 0 && event.button !== 2)) return
                const activate = event.button === 0 && selected()
                props.onFocus()
                props.onSelect(project.id)
                if (event.button === 2) props.onMenu(event.x, event.y)
                if (activate) props.onActivate()
              }}
            ><text width="100%" height={1} overflow="hidden" fg={selected() ? theme.selectedFg : theme.text} selectable={false}>{`${selected() ? "▶" : " "} ${project.name}`}</text></box>
          }}</For>
        </box>
      </box>
    </Show>
  </box>
}
