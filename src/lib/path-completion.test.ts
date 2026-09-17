import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { completePath } from "./path-completion.ts"

test("completes directory segments, preserves spelling and skips noise and broken links", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-path-"))
  const oldHome = process.env.HOME
  try {
    for (const name of ["workforest", "workshop", "with spaces", ".hidden", "node_modules", ".git"]) mkdirSync(join(root, name))
    writeFileSync(join(root, "work.txt"), "")
    symlinkSync(join(root, "workforest"), join(root, "work-link"))
    symlinkSync(join(root, "missing"), join(root, "work-broken"))
    expect((await completePath(`${root}/wor`)).map((row) => row.name)).toEqual(["work-link", "workforest", "workshop"])
    expect((await completePath(`${root}/`)).map((row) => row.name)).toEqual(["with spaces", "work-link", "workforest", "workshop"])
    expect(await completePath(`${root}/.h`)).toEqual([{ name: ".hidden", value: `${root}/.hidden/` }])
    expect(await completePath(`${root}/with `)).toEqual([{ name: "with spaces", value: `${root}/with spaces/` }])
    const rel = relative(process.cwd(), root)
    expect((await completePath(`${rel}/workf`))[0]?.value).toBe(`${rel}/workforest/`)
    process.env.HOME = root
    expect((await completePath("~/workf"))[0]?.value).toBe("~/workforest/")
    expect(await completePath("~")).toEqual(await completePath("~/"))
    expect(await completePath(`${root}/missing/`)).toEqual([])
    expect(await completePath(`${root}/work.txt/`)).toEqual([])
    expect(await completePath("")).toEqual([])
    expect(await completePath(`${root}/`, AbortSignal.abort())).toEqual([])
  } finally {
    process.env.HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test("caps suggestions at twenty directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-path-cap-"))
  try {
    for (let index = 0; index < 50; index++) mkdirSync(join(root, `dir-${index}`))
    expect(await completePath(`${root}/`)).toHaveLength(20)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
