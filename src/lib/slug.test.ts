import { expect, test } from "bun:test"
import { isWorktreeName, slugify, uniqueId } from "./slug.ts"

test("slugify lowercases and dashes", () => {
  expect(slugify("Cras App")).toBe("cras-app")
  expect(slugify("  Hello___World  ")).toBe("hello-world")
})

test("uniqueId suffixes collisions", () => {
  expect(uniqueId("cras", new Set(["cras"]))).toBe("cras-2")
  expect(uniqueId("cras", new Set(["cras", "cras-2"]))).toBe("cras-3")
})

test("rejects reserved and illegal worktree names", () => {
  expect(isWorktreeName("feat-auth")).toBe(true)
  expect(isWorktreeName("main")).toBe(false)
  expect(isWorktreeName("feat auth")).toBe(false)
  expect(isWorktreeName("feat..auth")).toBe(false)
})
