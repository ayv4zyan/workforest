import { createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { MouseEvent } from "@opentui/core"
import { theme } from "../theme.ts"

type Variant = "default" | "accent" | "danger" | "ghost"

export function ActionButton(props: {
  id?: string
  label: string
  trailingLabel?: string
  onPress: () => void
  variant?: Variant
  disabled?: boolean
  active?: boolean
  compact?: boolean
  onHover?: () => void
}) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const variant = () => props.variant ?? "default"

  const border = () => {
    if (hover() || props.active) {
      if (props.disabled) return theme.borderFocus
      return variant() === "danger" ? theme.danger : theme.accent
    }
    if (props.disabled) return theme.border
    if (variant() === "accent") return theme.accent
    if (variant() === "danger") return theme.danger
    return theme.border
  }

  const fg = () => {
    if (props.disabled) return theme.muted
    if (variant() === "danger") return theme.danger
    if (variant() === "accent" || props.active) return theme.selectedFg
    return theme.text
  }

  const bg = () => {
    if (props.disabled) return theme.panel
    if (props.active && variant() === "danger") return "#3d1114"
    if (props.active) return theme.selectedBg
    if (hover()) return theme.hoverBg
    return theme.panel
  }

  function press(event: MouseEvent) {
    event.stopPropagation()
    event.preventDefault()
    if (props.disabled || event.button !== 0) return
    props.onPress()
  }

  return (
    <box
      id={props.id}
      border={props.compact ? [] : true}
      height={props.compact ? 1 : 3}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
      alignItems="center"
      justifyContent={props.trailingLabel ? "space-between" : "center"}
      flexShrink={0}
      borderColor={border()}
      backgroundColor={bg()}
      onMouseDown={press}
      onMouseOver={() => {
        if (props.disabled) return
        setHover(true)
        props.onHover?.()
        renderer.setMousePointer("pointer")
        renderer.requestRender()
      }}
      onMouseOut={() => {
        setHover(false)
        renderer.setMousePointer("default")
        renderer.requestRender()
      }}
    >
      <text fg={fg()} selectable={false} onMouseDown={press}>
        {props.label}
      </text>
      {props.trailingLabel ? (
        <text fg={fg()} selectable={false} onMouseDown={press}>
          {props.trailingLabel}
        </text>
      ) : null}
    </box>
  )
}
