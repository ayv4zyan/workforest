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

- Click **refresh** / **quit** in the header.
- Click a list row to select it. Click the same row again to activate it (open trees, start/stop, or kill).
- Scroll the wheel over a list to move the selection.
- The three panes are **projects**, **worktrees**, and **servers**. Servers always belong to the selected worktree.
- The bottom bar follows the focused pane: projects gets **add**, **unregister**; worktrees gets **new**, **rename**, **delete**, **start**/**stop**; servers gets **kill**.
- Dialogs have **submit**/**confirm** and **cancel**. Click the input to type.

## Keys

Arrow keys move spatially. The shell is three rows: header (`refresh` / `quit`), the project / worktree / server panes, then footer actions. Dialogs use the same idea: the text field, then `submit` / `confirm` and `cancel`.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Next / previous control in the current row, or in a dialog |
| `←` / `→` | Previous / next pane, header button, footer button, or dialog button. In a dialog text field, move the cursor |
| `↓` | Header → panes → footer. In a dialog, the text field → submit |
| `↑` | Footer → panes → header. In a dialog, buttons → text field |
| `a` | Register a project (path to the main checkout) |
| `n` | New worktree (directory name = branch name) |
| `r` | Open rename choices: manual or auto |
| `shift+r` | Suggest a name with Codex Luna High |
| `d` | Delete linked worktree |
| `u` | Unregister project (does not delete trees) |
| `enter` | Activate the focused list item, header / footer / dialog button, or submit the dialog field |
| `esc` | Close the open dialog |
| `j` / `k` | Move down / up in the focused list |
| `k` | Kill the selected server (servers pane) |
| `g` | Refresh |
| `q` | Quit |

On create, Workforest copies `.env*` files and symlinks `node_modules` from the main checkout when lockfiles match. If they do not match, it runs `bun install` in the new tree.

Dev servers get a free port from 5173 up. The servers pane lists processes Workforest started and any other listener whose cwd is the selected worktree.

## Auto-rename

Select a linked worktree and click **rename** (or press **r**) to open a popup with **manual** and **auto** buttons. **Manual** opens the name field; **auto** asks Codex for a suggestion. Click outside the popup or press **Esc** to close it. **Shift+R** opens auto directly. Codex Luna (`gpt-5.6-luna`, high reasoning effort) suggests a name from the branch diff, staged and unstaged changes, and untracked filenames. Review or edit the suggestion, then submit to rename both the directory and branch using the existing rename flow. Press **Esc** while generating to cancel.

Requires the `codex` CLI on your PATH, signed in with `codex login`, and access to Luna. Workforest sends bounded diff excerpts to Codex; `.env` and `.env.*` files are excluded and untracked file contents are omitted. Requests time out after two minutes. Main and detached worktrees cannot be auto-renamed.
