# pi-archive

`pi-archive` is a Pi package that adds `/archive` and `/unarchive` commands for moving session files in and out of Pi's archive directory.

Sessions whose names start with a GitLab issue prefix like `#1234` are grouped into collapsible folds in the picker, collapsed by default.

The package stores archived sessions in Pi's config directory:

- `~/.pi/agent/session-archive/`

It restores unarchived sessions back to:

- `~/.pi/agent/sessions/`

## Commands

### `/archive`

Open a multi-select session picker for active sessions.

- `Enter`: toggle selection, or expand/collapse a highlighted issue fold
- `Ctrl+D`: archive selected sessions, or the highlighted session if none are selected
- `Tab`: switch between current-folder and all-sessions views
- `Ctrl+P`: toggle full session path display
- `Ctrl+S`: toggle name sort ascending/descending
- `Esc` / `Ctrl+C`: close

### `/unarchive`

Open a multi-select picker for archived sessions.

- `Enter`: toggle selection, or expand/collapse a highlighted issue fold
- `Ctrl+D`: unarchive selected sessions, or the highlighted session if none are selected
- `Tab`: switch between current-folder archive and all archived sessions
- `Ctrl+P`: toggle full session path display
- `Ctrl+S`: toggle name sort ascending/descending
- `Esc` / `Ctrl+C`: close

## Installation

Install from Git:

```bash
pi install git:github.com/portavion/pi-archive
```

Or locally:

```bash
pi install /Users/portavion/code/pi-archive
```

## Files

- [`package.json`](./package.json): Pi package manifest
- [`extensions/archive.ts`](./extensions/archive.ts): extension source

## License

MIT.
