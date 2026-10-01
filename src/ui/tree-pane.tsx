import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import type { PullRequest } from "../lib/branch-metadata.ts"
import { displayPath } from "../lib/display-path.ts"
import { nextIndex } from "../lib/select-hit.ts"
import { serverStatus, serversForWorktree } from "../lib/servers.ts"
import type { Project, ServerRow } from "../lib/types.ts"
import { theme } from "../theme.ts"
import { ActionButton } from "./button.tsx"
import type { TreeEntry, TreeGroup, TreeRow } from "./workspace.ts"
import { projectListOffset } from "./project-drag.ts"
import { treeEntryKey, treeVisibleCount, type TreeDrag } from "./tree-drag.ts"

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
  pullingPath: string | null
  mergingPath: string | null
  shipping: { path: string; text: string } | null
  drag: TreeDrag
  on: {
    openPR: (url: string) => void
    prMenu: (tree: TreeRow, pr: PullRequest, x: number, y: number) => void
    focus: () => void
    new: () => void
    pickEntry: (index: number) => void
    pickTree: (path: string) => void
    toggleGroup: (group: TreeGroup) => void
    menu: (x: number, y: number) => void
    listLayout: (node: BoxRenderable, height: number) => void
  }
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function TreePane(props: Props) {
  const renderer = useRenderer()
  const [listHeight, setListHeight] = createSignal(0)
  const [hoveredKey, setHoveredKey] = createSignal<string | null>(null)
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const treeCount = () => props.trees.reduce((count, entry) => count + (entry.kind === "group" ? entry.count : 0), 0)
  const keys = createMemo(() => props.trees.map(treeEntryKey))
  const dragging = () => Boolean(props.drag.state()?.dragging)
  const offset = () => props.drag.state()?.offset ?? projectListOffset(props.selectedIndex, props.trees.length, treeVisibleCount(listHeight(), false))
  const visible = (index: number) => index >= offset() && index < offset() + treeVisibleCount(listHeight(), dragging())

  createEffect(() => {
    if (!props.pullingPath && !props.mergingPath && !props.shipping) return
    const timer = setInterval(() => {
      setSpinnerFrame((value) => (value + 1) % spinnerFrames.length)
      renderer.requestRender()
    }, 100)
    onCleanup(() => clearInterval(timer))
  })

  function wheel(event: MouseEvent) {
    props.on.focus()
    event.stopPropagation()
    if (props.blocked) return
    const direction = event.scroll?.direction
    const delta = direction === "down" || direction === "right" ? 1 : direction === "up" || direction === "left" ? -1 : 0
    if (delta) {
      if (props.drag.scroll(delta)) return
      props.drag.cancel()
      props.on.pickEntry(nextIndex(props.selectedIndex, props.trees.length, delta))
    }
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
          <For each={keys()}>{(key, index) => {
            if (key.startsWith("group:")) {
              const group = key.slice(6) as TreeGroup
              const count = () => {
                const entry = props.trees.find((row) => row.kind === "group" && row.group === group)
                return entry?.kind === "group" ? entry.count : 0
              }
              return <box
                id={`tree-group-${group}`} height={1} flexShrink={0} visible={visible(index())}
                backgroundColor={props.focusedGroup === group ? theme.selectedBg : theme.panel}
                onMouseOver={() => renderer.setMousePointer(dragging() ? "move" : "pointer")}
                onMouseOut={() => renderer.setMousePointer(dragging() ? "move" : "default")}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  if (props.blocked || event.button !== 0) return
                  props.drag.cancel()
                  props.on.focus()
                  props.on.toggleGroup(group)
                }}
              ><text height={1} wrapMode="none" truncate selectable={false} fg={theme.accent}>{`${props.collapsedGroups[group] ? "▸" : "▾"} ${{ pinned: "Pinned", running: "Running", stopped: "Not running" }[group]} (${count()})`}</text></box>
            }
            const entry = () => props.trees.find((row) => row.kind === "tree" && row.tree.path === key) as Extract<TreeEntry, { kind: "tree" }>
            const tree = () => entry().tree
            const selected = () => index() === props.selectedIndex
            const lifted = () => dragging() && props.drag.state()?.path === key
            const drop = () => props.drag.state()?.target?.path === key ? props.drag.state()?.target : null
            const rowFg = () => lifted() ? theme.muted : selected() ? theme.selectedFg : theme.text
            const prFg = () => props.blocked ? theme.muted : tree().prState === "OPEN" ? theme.danger : tree().prState === "MERGED" ? theme.selectedFg : theme.text
            const title = () => {
              const [indicator, ...statusParts] = serverStatus(serversForWorktree(props.servers, tree().path)).split(" ")
              const status = statusParts.join(" ")
              const frame = spinnerFrames[spinnerFrame()]
              const activity = props.shipping?.path === tree().path
                ? ` ${frame}${props.shipping.text.trim() ? ` ${props.shipping.text.trim()}` : ""}`
                : props.pullingPath === tree().path ? ` ${frame} pulling`
                : ""
              return `${indicator} ${tree().displayName}${tree().isMain ? "  (main)" : ""}${activity}${tree().dirty ? "  *" : ""}${status ? `  ${status}` : ""}`
            }
            const rowBg = () => lifted() ? theme.panel : selected()
              ? hoveredKey() === key ? theme.selectedHoverBg : theme.selectedBg
              : hoveredKey() === key ? theme.hoverBg : theme.panel
            return <box id={`tree-row-${key}`} height={selected() ? 2 : 1} flexShrink={0} flexDirection="column" overflow="hidden"
              visible={visible(index())} marginTop={drop()?.placement === "before" ? 1 : 0} marginBottom={drop()?.placement === "after" ? 1 : 0}
              backgroundColor={rowBg()}
              onMouseOver={() => { setHoveredKey(key); renderer.setMousePointer(dragging() ? "move" : "pointer") }}
              onMouseOut={() => { setHoveredKey(null); renderer.setMousePointer(dragging() ? "move" : "default") }}
              onMouseDown={(event) => {
                event.stopPropagation()
                if (props.blocked || (event.button !== 0 && event.button !== 2)) return
                props.on.focus()
                if (event.button === 0 && entry().group === "pinned" && !props.busy) props.drag.start(key, event)
                else {
                  props.drag.cancel()
                  props.on.pickTree(key)
                  if (event.button === 2) props.on.menu(event.x, event.y)
                }
              }}
            >
              <box height={1} flexDirection="row" minWidth={0}>
                <text height={1} flexShrink={1} minWidth={0} wrapMode="none" truncate overflow="hidden" fg={rowFg()} selectable={false}>{`${selected() ? "▶" : " "} ${title()}`}</text>
                <Show when={tree().pr}>{(pr: () => PullRequest) =>
                  <>
                    <ActionButton id={`pr-link-${pr().number}`} label={`#${pr().number}`} compact underlined backgroundColor={rowBg()}
                      variant={tree().prState === "OPEN" ? "danger" : tree().prState === "MERGED" ? "accent" : "default"}
                      disabled={props.blocked} onPress={() => props.on.openPR(pr().url)}
                      onContextMenu={(x, y) => props.on.prMenu(tree(), pr(), x, y)} />
                    <Show when={props.mergingPath === key}>
                      <text id="merge-spinner" height={1} flexShrink={0} wrapMode="none" fg={prFg()} selectable={false}>{`${spinnerFrames[spinnerFrame()]} merging`}</text>
                    </Show>
                  </>
                }</Show>
              </box>
              <Show when={selected()}>
                <text width="100%" height={1} wrapMode="none" truncate overflow="hidden" fg={lifted() ? theme.muted : theme.selectedFg} selectable={false}>{`   ${tree().isMain ? `${tree().branch ?? "detached"}  ` : !tree().branch ? "detached  " : ""}${displayPath(tree().path)}`}</text>
              </Show>
            </box>
          }}</For>
          <Show when={dragging() && props.drag.state()?.target}>
            <box id="tree-drop-indicator" position="absolute" left={0} top={props.drag.lineTop()}
              width="100%" height={1} border={["top"]} borderColor={theme.accent} backgroundColor={theme.panel} zIndex={1} />
          </Show>
        </box>
      </box>
    </Show>
  </box>
}
