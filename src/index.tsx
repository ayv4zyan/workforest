#!/usr/bin/env bun
import { render } from "@opentui/solid"
import { App } from "./app.tsx"

await render(() => <App />, {
  exitOnCtrlC: true,
  targetFps: 30,
})
