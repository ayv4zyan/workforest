import { expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findNodeModulesDirs, lockfilesMatch, setupWorktreeDeps } from "./deps.ts"

test("lockfilesMatch compares lock contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-lock-"))
  const a = join(dir, "a")
  const b = join(dir, "b")
  mkdirSync(a)
  mkdirSync(b)
  writeFileSync(join(a, "bun.lock"), "same\n")
  writeFileSync(join(b, "bun.lock"), "same\n")
  expect(lockfilesMatch(a, b)).toBe(true)
  writeFileSync(join(b, "bun.lock"), "other\n")
  expect(lockfilesMatch(a, b)).toBe(false)
})

test("setupWorktreeDeps symlinks node_modules when lockfiles match", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-deps-"))
  const main = join(root, "main")
  const tree = join(root, "tree")
  mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true })
  mkdirSync(join(main, "web", "node_modules", "react"), { recursive: true })
  mkdirSync(join(tree, "web"), { recursive: true })
  writeFileSync(join(main, "bun.lock"), "lock\n")
  writeFileSync(join(tree, "bun.lock"), "lock\n")
  writeFileSync(join(main, "web", "bun.lock"), "web\n")
  writeFileSync(join(tree, "web", "bun.lock"), "web\n")
  writeFileSync(join(main, ".env"), "SECRET=1\n")

  const notes = setupWorktreeDeps(main, tree)
  expect(lstatSync(join(tree, "node_modules")).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(tree, "node_modules"))).toBe(join(main, "node_modules"))
  expect(lstatSync(join(tree, "web", "node_modules")).isSymbolicLink()).toBe(true)
  expect(notes.some((note) => note.includes("copied .env"))).toBe(true)
  expect(findNodeModulesDirs(main)).toHaveLength(2)
})
