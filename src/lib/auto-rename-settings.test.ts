import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultRenamePrompt,
  codexModels,
  loadAutoRename,
  normalizeAutoRename,
  reasoningChoices,
  renameModels,
  resolveReasoning,
  saveAutoRename,
} from "./auto-rename-settings.ts"

test("model choices come from the Codex catalog", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-codex-models-"))
  const cache = join(home, "models_cache.json")
  writeFileSync(cache, JSON.stringify({ models: [
    { slug: "gpt-6-sol", visibility: "list", default_reasoning_level: "ultra", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    { slug: "gpt-6-luna", visibility: "list", supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "hidden", visibility: "hide", supported_reasoning_levels: [] },
  ] }))
  const catalog = codexModels(cache)
  expect(catalog).toEqual([
    { model: "gpt-6-sol", reasoning: ["low", "ultra"], defaultReasoning: "ultra" },
    { model: "gpt-6-luna", reasoning: ["high"] },
  ])
  expect(renameModels(undefined, catalog)).toEqual(["gpt-6-sol", "gpt-6-luna"])
  expect(renameModels("my-custom-model", catalog)).toContain("my-custom-model")
  expect(reasoningChoices("gpt-6-sol", catalog)).toEqual(["low", "ultra"])
  expect(reasoningChoices("unlisted", catalog, "custom")).toEqual(["custom"])
  expect(resolveReasoning("gpt-6-sol", "invalid", catalog)).toBe("ultra")
  expect(resolveReasoning("gpt-6-luna", "ultra", catalog)).toBe("high")
  expect(resolveReasoning("my-custom-model", "ultra", catalog)).toBe("ultra")
})

test("auto rename settings round-trip and a blank prompt stores the built-in instructions", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-rename-cfg-"))
  expect(loadAutoRename(home)).toEqual({ provider: "codex", model: "gpt-6-luna", reasoning: "high", prompt: defaultRenamePrompt })
  saveAutoRename(home, { provider: "codex", model: "my-custom-model", reasoning: "ultra", prompt: "Name the branch." })
  expect(loadAutoRename(home)).toEqual({ provider: "codex", model: "my-custom-model", reasoning: "ultra", prompt: "Name the branch." })
  const stored = saveAutoRename(home, { provider: "codex", model: "my-custom-model", reasoning: "ultra", prompt: "  " })
  expect(stored).toEqual({ provider: "codex", model: "my-custom-model", reasoning: "ultra", prompt: defaultRenamePrompt })
  expect(normalizeAutoRename({ provider: "codex", model: "nope", reasoning: "low", prompt: "  " }).model).toBe("nope")
  expect(normalizeAutoRename({ provider: "codex", model: "gpt-5.6-luna", reasoning: "high", prompt: "" }).prompt).toBe(defaultRenamePrompt)
})
