import { loadConfig, saveConfig } from "./config.ts"
import { resolveReasoning, type AutoRenameSettings } from "./auto-rename-settings.ts"
import type { Config } from "./types.ts"

export type ShipSettings = AutoRenameSettings
export const defaultShipPrompt = `Prepare this branch for review. Use tools to inspect the actual Git diff and relevant repository code; supplied Git evidence is a starting point, not a restriction on investigation. Write concise commit messages and a PR description explaining the problem, resulting behavior, and relevant validation.
When a pre-push check fails, investigate the actual cause and make the smallest correct fix. Run the failing checks to verify the fix. Preserve the user's intended behavior. Never skip, disable, delete, or weaken checks merely to make them pass. Do not bypass hooks.
Report brief, specific progress messages while working, including which check you are fixing. Do not make unrelated changes.`

export function defaultShip(): ShipSettings {
  return { provider: "codex", model: "gpt-6-sol", reasoning: "high", prompt: defaultShipPrompt }
}
export function readShip(config: Config): ShipSettings {
  const defaults = defaultShip()
  const raw = config.ship
  const model = typeof raw?.model === "string" && raw.model.trim() ? raw.model.trim() : defaults.model
  return {
    provider: "codex", model,
    reasoning: resolveReasoning(model, raw?.reasoning ?? defaults.reasoning),
    prompt: typeof raw?.prompt === "string" && raw.prompt.trim() ? raw.prompt : defaults.prompt,
  }
}
export function loadShip(home: string): ShipSettings { return readShip(loadConfig(home)) }
export function saveShip(home: string, settings: ShipSettings): ShipSettings {
  const config = loadConfig(home)
  const next = readShip({ ...config, ship: settings })
  config.ship = next
  saveConfig(home, config)
  return next
}
