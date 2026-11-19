# dsh-terminal-hub

English | [中文](README.zh.md)

> A **terminal overview** plugin for DeepSeek Harness: one sidebar panel that lists the terminals of **every session**, shows their status, and opens the session with the chosen terminal selected. It also adds a read-only **launcher candidates** tab (the Hosts tab).

DSH terminals are **session-owned**: each session keeps its own section of the right sidebar, so switching to another session hides the terminals opened before. This plugin gathers them in one place and answers "which session did I open that terminal in?".

## Features

- **Cross-session overview** — the terminals of every session at once (including sessions that are not open), grouped by session
- **Click to select** — click any row to open the session that owns the terminal and select that terminal in the right sidebar; a collapsed sidebar expands automatically
- **Works without a tab** — if the terminal has no tab in this window yet and is still running, a tab bound to it is opened (the same path the official terminal UI uses for Agent terminals)
- **Two names** — the main title is the **display name** (falling back to the **real title**, then to `shell + short id`), and the **real title** always stays visible as the grey sub line
- **Status dot** — green = running, grey = exited, red = failed, with the origin (user / Agent) next to it
- **Sub line** — `real title · shell · start directory`; the full path is in the hover title
- **Automatic numbering** — terminals sharing session + directory + shell get `#1 #2`
- **Display name** — double-click a title to rename it in place; the name lives in this panel only and never changes the DSH terminal header
- **Close** — a second confirmation really kills the terminal process (only for terminals of the current session)
- **Tags and colours** — give a terminal a short tag and pick one of five colours; both are panel-local
- **Search** — one box filters both tabs (display name / real title / tag / directory / session / launcher name and path)
- **Two tabs** — `Terminals (N)` / `Hosts (M)`; the numbers count **current search results**
- **Hosts tab (read-only, no configuration)** — lists the launcher candidates the terminal controller actually registered (`name` without `.cmd` plus the full path), unfiltered, with no action buttons
- **Collapsed exits** — exited and failed terminals start collapsed and can be expanded
- Metadata lives in the browser's `localStorage`; entries expire once their terminal is gone

## Install

From npm:

```sh
dsh plugin --profile web add dsh-terminal-hub
```

From GitHub (tracks the latest code):

```sh
dsh plugin --profile web add github:<owner>/dsh-terminal-hub
```

Local development:

```sh
git clone <repo-url> dsh-terminal-hub
dsh plugin --profile web add link:$PWD/dsh-terminal-hub
```

**Restart `dsh web` after installing** (client plugins load into `window.__DSH_BOOT__` at startup). After that, edits to `client.js` are usually hot-updated by `dsh-client-hmr`; at worst press F5 once.

## How it works

- The session list comes from the client's `ctx.sessions.list` (`SnapshotStore`)
- Each session's terminals come from the Host's `remote.terminal.list(sessionId)` — **the method accepts any session id, including offline ones**, which is what makes the cross-session overview possible
- Sessions with terminals also subscribe to `ctx.webTerminals.watch(sessionId, listener)` for a live roster
- The jump calls `ctx.uiWorkspace.openSession(sessionId)`, which only switches sessions
- Selecting the terminal uses `ctx.sidebarRight`: after the switch the sidebar's seat has to render before its store is minted, so the plugin **waits for `mounted` to become the target session**, then resolves the tab bound to that terminal from the cross-session tab inventory (`sidebarRight.openTabs`) and the controller binding (`webTerminals.boundTerminal`), expands the column when needed and calls `focus(tabId)`
- When no tab exists and the terminal is still running, it opens one with `sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId } })` and binds it with `webTerminals.bind(...)` — the same path the official terminal UI uses for Agent terminals
- Selection is **asynchronous and time-bounded** (4 s): `openSession` closes this panel first, so the remaining steps touch services only, never React state; every step is read back through `active()`, and a failure leaves a single console warning instead of pretending to succeed
- Close calls `remote.terminal.close(sessionId, id)` directly. The Gateway validates the wire `agentId` against the calling connection's own agent, so **only the current session's terminals can be operated on**; a cross-session attempt is refused and the panel shows a readable notice
- Display names live only in the browser's `localStorage`; nothing is written to the Host and the DSH terminal header is untouched
- The Hosts tab reads `ctx.webTerminals.launchShells(sessionId, signal)` (the official terminal UI's own path) and falls back to `remote.terminal.shells(...)` (which itself tries three wire shapes). It **reads no plugin configuration** and keeps no second copy of the list

## The Hosts tab (read-only)

This tab is **read-only and has no configuration**: it shows the launcher candidates the terminal controller (`terminal-controller`) **actually registered in the running environment**, so it is always in sync with the system and there is no second list to maintain.

### Where the data comes from

Tried in order; the first success wins:

1. `ctx.webTerminals.launchShells(sessionId, signal)` — the path the official terminal UI itself takes
2. `remote.terminal.shells(sessionId, signal)` — the lower-level Remote fallback

The second one still tries three wire shapes in turn (`{id}` / a bare string / `{agentId}`) and remembers the shape that worked.

The top of the tab shows:

```
Source: terminal candidate list
18 launcher candidates
shells() shape: webTerminals.launchShells · probe session: <session id>
Read-only view: no action buttons here.
```

### How the session id is chosen

`shells()`'s agent parameter is resolved by the Gateway (`agentId` lookup) and authorised against the **calling connection**, so the plugin **tries sessions in order** from the `ctx.sessions.list` snapshot (at most the first 16), uses the **first one that answers**, and shows that id on the source line.

When every attempt fails:

- A yellow bar at the top: `Reading launcher candidates failed: <code>: <message>` (the raw code/message of the last failure)
- The list area: `The candidate list is unavailable, so there is nothing to list here.` plus the number of sessions tried

**Never** is "could not read" shown as "no launchers", and never is an empty list shown without an explanation.

### Row contents

| Position | Content |
|---|---|
| Main title | The candidate's `name` without the `.cmd` suffix (e.g. `web-01`) |
| Sub line (grey) | The candidate's full `path` (the hover title shows it too) |
| Order | Ascending by main title (that is, by `name`) |
| Search | Matches `name` and `path` (shares the top search box) |

Candidates are **not filtered at all**: a launcher outside `~/.dsh/ssh-hosts` is listed just the same — the point of this tab is "what does this machine actually have".

## Known limitations

- **Selection needs the right-sidebar service** — on DSH versions without `sidebarRight`, a click degrades to switching the session only (no error, and no fake selection)
- **An exited terminal with no tab gets none** — the jump only switches to its session; there is no process for a new tab to attach to, so it would only show "unavailable"
- **The 4 s selection window** — if the session's sidebar seat does not render in time (a frozen UI, for example), the plugin gives up focusing and leaves one console warning; the session switch itself still happens
- **Not cross-session takeover** — the panel sees, navigates and selects; it cannot move another session's terminal into the current session
- **The start directory does not follow `cd`** — `cwd` is where the terminal started, not its live directory
- **Display names and colours are panel-local** — DSH's terminal header is owned by the terminal UI; this plugin does not change it
- **Close is cross-session-limited** — the Gateway boundary only admits the caller's own session terminals
- **The Hosts tab depends on Gateway authorisation** — `shells()`'s agent parameter is checked against the calling connection; if every candidate session is refused, the tab shows the error code/message and never invents a list
- **Terminals of offline sessions** — the Host keeps terminals only for the life of its process; they are gone after a DSH restart
- At most 400 sessions are scanned; the panel says so when there are more

## Compatibility

- Requires `dsh >= 0.2.0`
- Depends on the built-in client services `sessions` / `webTerminals` / `uiWorkspace` / `sidebarRight` / `slots` / `locale`, and on the `terminal-controller` Remote methods and bindings
- These are DSH-internal APIs, so **a DSH upgrade may need adaptation** (`tabsIn` / `openTabIn` / `tabDomain` are not on `ISidebarRight`'s type surface but exist at runtime; run the tests after upgrading)
- The UI ships both English and Chinese dictionaries; DSH picks the one matching the user's locale

## Development

```sh
git clone <repo>
dsh plugin --profile web add link:$PWD
```

`client.js` is a hand-written browser bundle in this shape:

```js
window.__ModuleLoader__.load({ id: '<package>', factory(require) { ... return { inject, apply } } })
```

There is no build step; `node --check client.js` checks the syntax. Tests:

```sh
npm test    # node --test: selection logic + module wiring, no browser required
```

`test/jump.test.mjs` reads `client.js` and evaluates the source between the `// BEGIN/END terminal-jump helpers` sentinels (the contract lives in the same file), then drives the selection flow with fake `sidebarRight` / `webTerminals` services.

## Licence

MIT
