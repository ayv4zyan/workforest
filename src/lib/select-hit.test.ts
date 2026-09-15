import { expect, test } from "bun:test"
import { nextIndex, pickSelectIndex } from "./select-hit.ts"

test("pickSelectIndex maps a click onto the visible item", () => {
  expect(pickSelectIndex(0, 10, 0, 5, 2)).toBe(0)
  expect(pickSelectIndex(2, 10, 0, 5, 2)).toBe(1)
  expect(pickSelectIndex(9, 10, 0, 5, 2)).toBe(4)
  expect(pickSelectIndex(-1, 10, 0, 5, 2)).toBeNull()
  expect(pickSelectIndex(0, 10, 0, 0, 2)).toBeNull()
})

test("pickSelectIndex accounts for the same centering scroll as Select", () => {
  expect(pickSelectIndex(0, 6, 5, 10, 2)).toBe(4)
  expect(pickSelectIndex(4, 6, 5, 10, 2)).toBe(6)
})

test("nextIndex clamps", () => {
  expect(nextIndex(0, 3, -1)).toBe(0)
  expect(nextIndex(2, 3, 1)).toBe(2)
  expect(nextIndex(1, 3, 1)).toBe(2)
})
