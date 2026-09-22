import { For, Show, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { displayPath } from "../lib/display-path.ts"
import { nextIndex } from "../lib/select-hit.ts"
import { serverStatus, serversForWorktree } from "../lib/servers.ts"
import type { Project, ServerRow } from "../lib/types.ts"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import type { TreeEntry, TreeGroup } from "./workspace.ts"

type Props = {
  focus: { selected: boolean; row: "header" | "panes" | "pane-actions" }
  busy: boolean
  blocked: boolean
  query: string
  project: Project | null
  trees: TreeEntry[]
  selectedIndex: number
  focusedGroup: TreeGroup | null
  collapsedGroups: Record<TreeGroup, boolean>
  servers: ServerRow[]
  on: {
    focus: () => void
    new: () => void
    pickEntry: (index: number) => void
    pickTree: (path: string) => void
    toggleGroup: (group: TreeGroup) => void
    menu: (x: number, y: number) => void
    listLayout: (node: BoxRenderable, height: number) => void
  }
}

function visibleRows<T>(rows: T[], selected: number, height: number) {
  const count = Math.max(1, height)
  const offset = Math.max(0, Math.min(selected - Math.floor(count / 2), rows.length - count))
  return rows.slice(offset, offset + count).map((row, index) => ({ row, index: offset + index }))
}

export function TreePane(props: Props) {
  const renderer = useRenderer()
  const [listHeight, setListHeight] = createSignal(0)
  const [hoveredIndex, setHoveredIndex] = createSignal<number | null>(null)
  const treeCount = () => props.trees.reduce((count, entry) => count + (entry.kind === "group" ? entry.count : 0), 0)

  function wheel(event: MouseEvent) {
    props.on.focus()
    event.stopPropagation()
    if (props.blocked) return
    const direction = event.scroll?.direction
    const delta = direction === "down" || direction === "right" ? 1 : direction === "up" || direction === "left" ? -1 : 0
    if (delta) props.on.pickEntry(nextIndex(props.selectedIndex, props.trees.length, delta))
  }

  return <box
    id="pane-trees" flexGrow={1} minWidth={0} overflow="hidden"
    border={["top", "right", "bottom"]}
    borderColor={props.focus.selected && props.focus.row === "panes" ? theme.borderFocus : theme.border}
    titleColor={props.focus.selected && props.focus.row === "panes" ? theme.accent : theme.muted}
    backgroundColor={theme.panel}
    onMouseDown={() => { if (!props.blocked) props.on.focus() }}
  >
    <box height={1} flexDirection="row" gap={1}>
      <ActionButton id="btn-new" label="+" compact disabled={!props.project || props.busy}
        active={props.focus.selected && props.focus.row === "pane-actions"} onPress={() => { props.on.focus(); props.on.new() }} />
      <text fg={props.focus.selected ? theme.accent : theme.muted} selectable={false}>{`worktrees (${treeCount()})${props.query ? ` /${props.query}` : ""}`}</text>
    </box>
    <Show when={treeCount() > 0} fallback={<text fg={theme.muted} selectable={false}>{props.query ? "no matching worktrees" : "no worktrees"}</text>}>
      <box flexGrow={1} flexDirection="row" ref={(node) => {
        node.onSizeChange = () => setListHeight(node.height)
        setListHeight(node.height)
      }}>
        <box ref={(node) => {
          node.onSizeChange = () => props.on.listLayout(node, node.height)
          props.on.listLayout(node, node.height)
        }} flexGrow={1} flexDirection="column" overflow="hidden" onMouseScroll={wheel}>
          <For each={visibleRows(props.trees, props.selectedIndex, listHeight() - 1)}>{({ row: entry, index }) => {
            if (entry.kind === "group") return <box
              id={`tree-group-${entry.group}`} height={1} flexShrink={0}
              backgroundColor={props.focusedGroup === entry.group ? theme.selectedBg : theme.panel}
              onMouseOver={() => renderer.setMousePointer("pointer")}
              onMouseOut={() => renderer.setMousePointer("default")}
              onMouseDown={(event) => {
                event.stopPropagation()
                if (props.blocked || event.button !== 0) return
                props.on.focus()
                props.on.toggleGroup(entry.group)
              }}
            ><text height={1} wrapMode="none" truncate selectable={false} fg={theme.accent}>{`${props.collapsedGroups[entry.group] ? "▸" : "▾"} ${entry.group === "running" ? "Running" : "Not running"} (${entry.count})`}</text></box>
            const tree = entry.tree
            const selected = () => index === props.selectedIndex
            const name = () => {
              const [indicator, ...statusParts] = serverStatus(serversForWorktree(props.servers, tree.path)).split(" ")
              const status = statusParts.join(" ")
              return `${indicator} ${tree.displayName}${tree.isMain ? "  (main)" : ""}${tree.dirty ? "  *" : ""}${status ? `  ${status}` : ""}`
            }
            return <box height={selected() ? 2 : 1} flexShrink={0} flexDirection="column" overflow="hidden"
              backgroundColor={selected()
                ? hoveredIndex() === index ? theme.selectedHoverBg : theme.selectedBg
                : hoveredIndex() === index ? theme.hoverBg : theme.panel}
              onMouseOver={() => { setHoveredIndex(index); renderer.setMousePointer("pointer") }}
              onMouseOut={() => { setHoveredIndex(null); renderer.setMousePointer("default") }}
              onMouseDown={(event) => {
                event.stopPropagation()
                if (props.blocked || (event.button !== 0 && event.button !== 2)) return
                props.on.focus()
                props.on.pickTree(tree.path)
                if (event.button === 2) props.on.menu(event.x, event.y)
              }}
            >
              <text width="100%" height={1} wrapMode="none" truncate overflow="hidden" fg={selected() ? theme.selectedFg : theme.text} selectable={false}>{`${selected() ? "▶" : " "} ${name()}`}</text>
              <Show when={selected()}>
                <text width="100%" height={1} wrapMode="none" truncate overflow="hidden" fg={theme.selectedFg} selectable={false}>{`   ${tree.isMain ? `${tree.branch ?? "detached"}  ` : !tree.branch ? "detached  " : ""}${displayPath(tree.path)}`}</text>
              </Show>
            </box>
          }}</For>
        </box>
      </box>
    </Show>
  </box>
}
