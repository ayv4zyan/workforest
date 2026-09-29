import { For, Show, createMemo, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { nextIndex } from "../lib/select-hit.ts"
import type { Project } from "../lib/types.ts"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import { projectListOffset, projectVisibleCount, type ProjectDrag } from "./project-drag.ts"

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
  drag: ProjectDrag
  onFocus: () => void
  onAdd: () => void
  onSelect: (id: string) => void
  onMenu: (x: number, y: number) => void
  onListLayout: (node: BoxRenderable, height: number) => void
}

export function ProjectPane(props: Props) {
  const renderer = useRenderer()
  const [listHeight, setListHeight] = createSignal(0)
  const [hoveredId, setHoveredId] = createSignal<string | null>(null)
  const selectedIndex = () => Math.max(0, props.projects.findIndex((project) => project.id === props.selectedId))
  const projectIds = createMemo(() => props.projects.map((project) => project.id))
  const offset = () => props.drag.state()?.offset ?? projectListOffset(selectedIndex(), props.projects.length, listHeight())
  const dragging = () => Boolean(props.drag.state()?.dragging)
  const insertionTop = () => {
    const target = props.drag.state()?.target
    if (!target) return 0
    return props.projects.findIndex((project) => project.id === target.id) - offset() + (target.placement === "after" ? 1 : 0)
  }

  function wheel(event: MouseEvent) {
    props.onFocus()
    event.stopPropagation()
    if (props.blocked) return
    const direction = event.scroll?.direction
    const delta = direction === "down" || direction === "right" ? 1 : direction === "up" || direction === "left" ? -1 : 0
    if (!delta) return
    if (props.drag.scroll(delta)) return
    props.drag.cancel()
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
          <For each={projectIds()}>{(id, index) => {
            const selected = () => id === props.selectedId
            const drop = () => props.drag.state()?.target?.id === id ? props.drag.state()?.target : null
            const lifted = () => dragging() && props.drag.state()?.id === id
            // Keep rows mounted while scrolling or refreshing so mouse capture survives a drag.
            return <box id={`project-row-${id}`} height={1} flexShrink={0} overflow="hidden"
              visible={index() >= offset() && index() < offset() + projectVisibleCount(listHeight(), dragging())}
              marginTop={drop()?.placement === "before" ? 1 : 0}
              marginBottom={drop()?.placement === "after" ? 1 : 0}
              backgroundColor={lifted() ? theme.panel : selected()
                ? hoveredId() === id ? theme.selectedHoverBg : theme.selectedBg
                : hoveredId() === id ? theme.hoverBg : theme.panel}
              onMouseOver={() => { setHoveredId(id); renderer.setMousePointer(dragging() ? "move" : "pointer") }}
              onMouseOut={() => { setHoveredId(null); renderer.setMousePointer(dragging() ? "move" : "default") }}
              onMouseDown={(event) => {
                event.stopPropagation()
                if (props.blocked || (event.button !== 0 && event.button !== 2)) return
                props.onFocus()
                if (event.button === 0) props.drag.start(id, event)
                else {
                  props.drag.cancel()
                  props.onSelect(id)
                  props.onMenu(event.x, event.y)
                }
              }}
            ><text width="100%" height={1} overflow="hidden" fg={lifted() ? theme.muted : selected() ? theme.selectedFg : theme.text} selectable={false}>{`${selected() ? "▶" : " "} ${props.projects.find((project) => project.id === id)?.name ?? ""}`}</text></box>
          }}</For>
          <Show when={dragging() && props.drag.state()?.target}>
            <box id="project-drop-indicator" position="absolute" left={0} top={insertionTop()}
              width="100%" height={1} border={["top"]} borderColor={theme.accent}
              backgroundColor={theme.panel} zIndex={1} />
          </Show>
        </box>
      </box>
    </Show>
  </box>
}
