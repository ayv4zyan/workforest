# Workforest

A terminal UI for git worktrees and the Bun/JS dev servers attached to them.

Registered projects stay where they are. Linked worktrees live under `~/.workforest/trees/<project>/<name>/`.

## Run

```bash
cd ~/Projects/Workforest
bun start
```

## Mouse

Every action has a click target. Keyboard shortcuts still work.

- Click **worktrees** / **servers** / **quit** in the header.
- Click a list row to select it. Click the same row again to activate it (open trees, start/stop, or kill).
- Scroll the wheel over a list to move the selection.
- Use the bottom bar: **add**, **new**, **rename**, **delete**, **unregister**, **start**/**stop**, **kill**, **refresh**.
- The detail pane repeats start/stop, rename, and delete for the selected worktree.
- Dialogs have **submit**/**confirm** and **cancel**. Click the input to type.

## Keys

| Key | Action |
| --- | --- |
| `1` / `2` | Worktrees / servers |
| `tab` | Switch pane |
| `a` | Register a project (path to the main checkout) |
| `n` | New worktree (directory name = branch name) |
| `r` | Rename directory and branch |
| `d` | Delete linked worktree |
| `u` | Unregister project (does not delete trees) |
| `enter` | Start or stop the worktree's dev server |
| `k` | Kill the selected server |
| `g` | Refresh |
| `q` | Quit |

On create, Workforest copies `.env*` files and symlinks `node_modules` from the main checkout when lockfiles match. If they do not match, it runs `bun install` in the new tree.

Dev servers get a free port from 5173 up. The servers view lists processes Workforest started and any other listener whose cwd is a registered worktree.
