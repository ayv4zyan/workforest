import { expect, test } from "bun:test"
import { reconcileWorktreeOrder, sortWorktrees } from "./worktree-order.ts"

test("saved ranks survive display-name changes and new worktrees append", () => {
  const rows = [
    { path: "/c", displayName: "alpha" },
    { path: "/a", displayName: "zebra" },
    { path: "/new", displayName: "aardvark" },
    { path: "/b", displayName: "beta" },
  ]
  const order = reconcileWorktreeOrder(["/a", "/deleted", "/b", "/c"], rows.map((row) => row.path))
  expect(order).toEqual(["/a", "/b", "/c", "/new"])
  expect(sortWorktrees(rows, order).map((row) => row.path)).toEqual(order)
  // Filtered groups retain the same relative rank.
  expect(sortWorktrees(rows.filter((row) => row.path !== "/b"), order).map((row) => row.path)).toEqual(["/a", "/c", "/new"])
  expect(rows[0]?.path).toBe("/c")
})

test("initial ordering is alphabetical with numeric names, then reconciliation is idempotent", () => {
  const rows = [{ path: "/10", displayName: "item-10" }, { path: "/2", displayName: "Item-2" }, { path: "/1", displayName: "item-1" }]
  const paths = sortWorktrees(rows, []).map((row) => row.path)
  expect(paths).toEqual(["/1", "/2", "/10"])
  expect(reconcileWorktreeOrder(paths, ["/10", "/2", "/1"])).toEqual(paths)
  expect(reconcileWorktreeOrder(["/1", "/1"], ["/1", "/2", "/2"])).toEqual(["/1", "/2"])
})
