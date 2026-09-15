import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addProject, loadConfig, removeProject } from "./config.ts"
import { execOk } from "./exec.ts"

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-cfg-"))
  execOk(["git", "init"], { cwd: dir })
  execOk(["git", "checkout", "-B", "main"], { cwd: dir })
  execOk(["git", "config", "user.email", "wf@test"], { cwd: dir })
  execOk(["git", "config", "user.name", "wf"], { cwd: dir })
  execOk(["git", "config", "commit.gpgsign", "false"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), "hi\n")
  execOk(["git", "add", "."], { cwd: dir })
  execOk(["git", "commit", "-m", "init"], { cwd: dir })
  return dir
}

test("add and remove a registered project", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-home-"))
  const repo = initRepo()
  const project = addProject(home, repo)
  expect(project.path).toBe(execOk(["git", "-C", repo, "rev-parse", "--show-toplevel"]).trim())
  expect(loadConfig(home).projects).toHaveLength(1)
  expect(() => addProject(home, repo)).toThrow(/already registered/)
  removeProject(home, project.id)
  expect(loadConfig(home).projects).toHaveLength(0)
})
