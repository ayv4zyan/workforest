# Workforest

TUI at `src/app.tsx`. Domain logic in `src/lib`. Data dir `~/.workforest` (override with `WORKFOREST_HOME`).

- Config: `config.json` — projects you register by path. Main checkouts are never moved.
- Linked worktrees: `trees/<project-id>/<name>/` via `git worktree add`.
- Rename changes both the directory (`git worktree move`) and the branch (`git branch -m`).
- `node_modules` is symlinked from main when lockfiles match; otherwise `bun install`. `.env*` is copied.
- Servers: owned (spawned from the TUI, pid files in `run/`) and discovered (`lsof` listeners whose cwd is a worktree).

The TUI is fully mouse-driven: header tabs, list rows (click to select, click again to activate, wheel to move), footer and detail buttons, modal submit/cancel. Keyboard shortcuts still work.

Run `bun test` after changing `src/lib`.
