import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultRenamePrompt,
  loadAutoRename,
  normalizeAutoRename,
  reasoningChoices,
  resolveReasoning,
  saveAutoRename,
} from "./auto-rename-settings.ts"

test("luna has no ultra and an unsupported level falls back to high", () => {
  expect(reasoningChoices("gpt-5.6-luna")).not.toContain("ultra")
  expect(reasoningChoices("gpt-5.6-sol")).toContain("ultra")
  expect(reasoningChoices("gpt-6-astra")).toContain("ultra")
  expect(resolveReasoning("gpt-5.6-luna", "ultra")).toBe("high")
  expect(resolveReasoning("gpt-5.6-sol", "ultra")).toBe("ultra")
})

test("auto rename settings round-trip and a blank prompt stores the built-in instructions", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-rename-cfg-"))
  expect(loadAutoRename(home)).toEqual({ provider: "codex", model: "gpt-5.6-luna", reasoning: "high", prompt: defaultRenamePrompt })
  saveAutoRename(home, { provider: "codex", model: "gpt-5.6-sol", reasoning: "ultra", prompt: "Name the branch." })
  expect(loadAutoRename(home)).toEqual({ provider: "codex", model: "gpt-5.6-sol", reasoning: "ultra", prompt: "Name the branch." })
  const stored = saveAutoRename(home, { provider: "codex", model: "gpt-5.6-luna", reasoning: "ultra", prompt: "  " })
  expect(stored).toEqual({ provider: "codex", model: "gpt-5.6-luna", reasoning: "high", prompt: defaultRenamePrompt })
  expect(normalizeAutoRename({ provider: "codex", model: "nope", reasoning: "low", prompt: "  " }).model).toBe("gpt-5.6-luna")
  expect(normalizeAutoRename({ provider: "codex", model: "gpt-5.6-luna", reasoning: "high", prompt: "" }).prompt).toBe(defaultRenamePrompt)
})
