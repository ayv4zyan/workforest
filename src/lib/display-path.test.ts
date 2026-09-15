import { expect, test } from "bun:test"
import { displayPath } from "./display-path.ts"

test("displayPath replaces only the home directory prefix with a tilde", () => {
  expect(displayPath("/Users/artur", "/Users/artur")).toBe("~")
  expect(displayPath("/Users/artur/Projects/Workforest", "/Users/artur")).toBe("~/Projects/Workforest")
  expect(displayPath("/Users/artur-other/project", "/Users/artur")).toBe("/Users/artur-other/project")
  expect(displayPath("/tmp/project", "/Users/artur")).toBe("/tmp/project")
})
