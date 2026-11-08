# Flowmap

See every screen of your web app as the code renders it, compare it with live, and send changes back to your coding agents.

Flowmap is for people who build by prompting coding agents. Agents build many screens and flows quickly, and clicking through all of them to check the result is slow. Flowmap puts every screen in one place, shows what differs from live, and turns your marks into tasks that agents pick up.

> **Status:** early. Flowmap can set up a project, serve its MCP tools on your computer, connect your coding agent in one step, teach the agent how to write state recipes, and capture each state as a picture and an HTML snapshot. The viewer shows every captured screen and updates while your agent works. Flowmap compares each screen with live, outlines what changed and names the elements in each change. You mark what should change on a screen, and your agent works through it as a task for you to approve. The [build plan](#build-plan) lists the steps.

## How it works

- **Your coding agent prepares each state.** It has the code. It seeds data, starts the app at the right commit, signs in and opens the screen.
- **Flowmap captures and keeps it.** Every capture belongs to one commit and one state, so the canvas always shows what the code renders.
- **Live comes from git.** You name the ref your project deploys from. Flowmap resolves it on every run and never stores a commit by hand.
- **Your feedback goes to agents as tasks.** Tasks are files in your repository, so every agent and person sees the same list and its history.

## Set up

Flowmap needs Node 22 or later and git. Open your coding agent (Claude Code, Codex or Cursor) in your project and paste:

> Set up Flowmap: run `npx flowmap setup` and do what it prints.

Your agent sets Flowmap up, starts it in the background and opens it in your browser. Then it writes a recipe for each screen, starts your app and captures every screen, and you watch them appear. You never open a terminal.

Flowmap is not on npm yet. Until it is, build it once and give your agent the built file instead of `npx flowmap`:

```sh
git clone https://github.com/Dammyjay93/flowmap.git
cd flowmap
pnpm install
pnpm build
```

> Set up Flowmap: run `node /path/to/flowmap/dist/cli.js setup` and do what it prints.

Set-up writes:

- `.flowmap/config.json`: the project name, the live ref (from your remote's default branch) and the screen widths;
- `.flowmap/states/`: one recipe for each state;
- `.flowmap/tasks/`: one file for each task;
- `.flowmap/.gitignore`, which keeps `.flowmap/store/`, where captures are kept, out of git. Set-up changes none of your own files.

To start Flowmap yourself instead, run `npx flowmap` in your project's root folder.

### Connect your coding agent

Flowmap runs on your computer only. The viewer is at `http://localhost:4317/` and the MCP endpoint at `http://localhost:4317/mcp`. Click **Connect** in the viewer, or connect your agent with one command:

| Agent | Command |
| --- | --- |
| Claude Code | `claude mcp add --transport http flowmap http://localhost:4317/mcp` |
| Codex | `codex mcp add flowmap --url http://localhost:4317/mcp` |
| Cursor | Open the link that `flowmap connect` prints, or run `flowmap connect --write cursor` |

`flowmap connect` prints these for your setup, and `flowmap connect --write <claude|codex|cursor>` adds Flowmap to that agent for you. Any other MCP client takes the endpoint as a streamable HTTP server.

Then ask your agent: "Set up Flowmap for this app." You don't need to add anything to `AGENTS.md` or similar files. The server tells your agent how to use Flowmap. The Connect panel lists each agent that has connected since Flowmap started.

For clients that start MCP servers themselves, `flowmap mcp` serves the same tools over stdio.

## Commands

| Command | What it does |
| --- | --- |
| `flowmap` | In a terminal: sets up the project if it is new, starts Flowmap and opens the viewer, and runs until you press Ctrl+C. If Flowmap already runs for the project, it opens the viewer. Started by a program, such as a coding agent, it prints the usage instead; `flowmap start` starts Flowmap anyway. `--no-open` keeps the browser closed |
| `flowmap init` | Sets up `.flowmap/` in the project |
| `flowmap serve` | Starts Flowmap on your computer: the viewer at `/` and the MCP endpoint at `/mcp`. `--port` changes the port from 4317 |
| `flowmap connect` | Shows how to connect each coding agent. `--write <claude\|codex\|cursor>` adds Flowmap to that agent |
| `flowmap states` | Lists state recipes, recipes that need repair, and the live and branch commits. Add `--json` for structured output |
| `flowmap setup` | For your coding agent: sets Flowmap up, starts it in the background on a free port, opens the viewer and prints what the agent does next |
| `flowmap capture [<state>...] --base-url <url>` | Captures every state, or the ones named, at the current commit, in one browser. It runs each recipe's `setup` and `session` first, one setup at a time, and captures the states of each setup several at a time. `--cookie name=value` adds a cookie to every state; `--width` overrides the widths; `--live`, for one state, files the capture under live's commit, for an app started from a copy of the project at live |
| `flowmap check --base-url <url>` | Captures every state at your current code and lists the screens that changed since before your change. It runs each recipe's `setup` and `session` as `capture` does. `--cookie name=value` adds a cookie to every state |
| `flowmap tasks` | Lists the changes you asked for. `--status` picks one status; add `--json` for structured output |
| `flowmap capture <state> --base-url <url> --variant <set>/<name> --note <text> --route <path>` | Captures a version of a screen for the person to choose from, from the address that shows it, filed under its set |
| `flowmap compare <state>` | Compares a state's captures at the current commit with its captures at live. Add `--json` for structured output |
| `flowmap mcp` | Serves the MCP tools over stdio |

## MCP tools

| Tool | What it does |
| --- | --- |
| `flowmap_guide` | Explains how Flowmap works and how to write state recipes. Agents call it once before their first Flowmap task |
| `flowmap_capture` | Captures one state at the current commit: a picture and an HTML snapshot for each width, saved in `.flowmap/store/<commit>/<state>/`. Returns a picture of each width for the agent to check, and the status against live. `live: true` files the capture under live's commit |
| `flowmap_capture` with `variant` | Files a version of a screen under its set: `{ set, name, note, route }`, where `route` is the address that shows it, such as `/checkout?version=b`. The versions of a set appear side by side in the viewer |
| `flowmap_version_start` | Marks a version as being built, before the agent changes code for it. The viewer shows its frame as a moving mosaic of its name until the agent captures it, then the mosaic dissolves into the screen |
| `flowmap_compare` | Compares a state with live. Returns each width's status, each element that was added, removed, moved or looks different, with its exact box, and pictures of each area at live and at the current commit |
| `flowmap_check` | Before an agent says a change is done: captures every state and lists every screen the change touched, including ones it did not mean to change, with the changed elements and pictures before and now. On committed code it files the captures under the commit, so the map shows every screen |
| `flowmap_tasks` | Lists the changes the person asked for, each with their words, the marked box, the element under it, its history and a picture with the box drawn on it. `status: approved` lists decisions to build from |
| `flowmap_task_update` | Sets a task to `in-progress`, or to `ready-for-review` with a note once the agent has captured the state again. Flowmap attaches that capture as the after picture |
| `flowmap_states` | Lists state recipes, recipes that need repair and why, and the live and branch commits resolved from git |

## State recipes

A recipe tells an agent how to reach one state. Agents write a recipe when they build a screen, and repair it when it stops working. Each recipe is one file, `.flowmap/states/<id>.json`, where `id` matches the file name. `id`, `name` and `route` are required; the rest are optional.

```json
{
  "id": "cart-with-items",
  "name": "Cart with two items",
  "area": "Shop",
  "page": "Cart",
  "route": "/cart",
  "setup": "pnpm seed cart-two-items",
  "session": "pnpm tsx scripts/test-session.ts",
  "steps": [{ "click": "button[aria-label='Apply code']" }, { "fill": "#code", "value": "SAVE10" }],
  "widths": [1440, 390],
  "leadsTo": [{ "state": "checkout", "action": "Check out" }]
}
```

Before it captures a state, Flowmap runs the recipe's `setup`, then its `session`, as shell commands in the project's folder, with `FLOWMAP_BASE_URL` set to the app's address. Then it opens `route` with the session's cookies and runs `steps`. `fullPage` captures a long page in full. `leadsTo` draws the flow connectors between screens.

- `setup` puts the app's data in the state the screen needs. It must reset everything the screen depends on, because opening a page can change data, and running it twice must give the same state.
- `session` signs in a test account and prints its cookies, one `name=value` on each line, such as `sid=abc123`. Text after a `;` on a line, such as Set-Cookie attributes, is ignored. The usual session command is a small script that calls the app's own session code for a test account.
- States with the same `setup` form a group. Flowmap runs the group's setup once, then each of its session commands once, then captures its states several at a time. It never runs two different setups at the same time, so states that need data in states that conflict get different setup commands and are captured one after the other.
- Each command may run for 5 minutes. If one fails, the capture stops and shows the command and the end of its output.

## Compare with live

Flowmap compares code with code. Your agent checks out live's commit in a second copy of the project, starts the app there on the same data, and captures the same states with `live: true`. Flowmap then compares each state at each width:

- It finds the columns where the pictures differ, then matches their rows as a text diff matches lines. Content that only moved up or down is not a change.
- Each capture records every visible element with its box. Flowmap pairs the elements of live and the current commit in page order, and names each one that was added, removed, moved or looks different, at its exact box. Content carried along by an element that moved is named once, at that element.
- Each width gets a status: `same`, `changed`, `new` (no live capture) or `missing` (not captured at the current commit).

In the viewer, a changed screen says **Changed from live** and has each changed area outlined. Select it and choose **Compare with live** to drag between live and the current commit.

## Check before done

Before your agent says a change is done, it calls `flowmap_check`. Flowmap captures every state at the agent's current code and compares each with its capture from before the change: this commit's captures while the change is uncommitted, or the newest earlier commit's once it is committed. The agent sees every screen the change touched, including screens it did not mean to change, and names what moved, appeared, disappeared or looks different. On committed code, the check files its captures under the commit, so the map shows every screen at that commit. On uncommitted code, it keeps its captures apart and replaces nothing.

## Versions

Ask your agent for several versions of a screen. It builds them side by side in your working copy, behind a switch the address sets, such as `?version=b`, and captures each with `variant: { set, name, note, route }`. One app runs; there are no extra branches. While the agent builds a version, its frame shows the version's name as a moving mosaic of dots, and the mosaic dissolves into the screen when the agent captures it. In the viewer, each set gets a section with its versions side by side. In comment mode you can comment on any version, for example "B, but with A's button", and the agent changes that version. Select the one you want and choose **Choose this version**: Flowmap makes a task for the agent to keep it, remove the other versions and the switch, capture again and check, which you then approve like any task.

## Tasks

In the viewer, select a screen and choose **Ask for a change**. Drag on the screen to mark a part, write what should change, and choose **Send to agent**. Flowmap saves the request in `.flowmap/tasks/<id>.md`, with the box, the element under it and the commit you marked. Commit these files, so every agent and person sees the same tasks and their history.

A task moves from `open` to `in-progress` to `ready-for-review`, which the agent sets. You then approve it or send it back with a note, and a task you send back goes to the agent again. When the agent marks a task ready, Flowmap attaches its new capture, and the viewer shows before and after side by side. **Copy as prompt** gives the request as text for an agent without MCP.

## Settings

`.flowmap/config.json`:

| Field | What it does |
| --- | --- |
| `name` | The project's name |
| `liveRef` | The git ref the project deploys from, such as `origin/main`. Flowmap resolves it on every run |
| `liveUrl` | The live site's address |
| `widths` | Screen widths to capture, in CSS pixels. Default: 1440 and 390 |
| `hide` | CSS selectors removed before each capture, such as a development overlay |
| `ignoreChanges` | Files a tool rewrites when the app starts, such as `AGENTS.md` under `next dev`. Their uncommitted changes do not mark captures as uncommitted. Every capture with uncommitted changes names the changed files |
| `time` | A fixed time for the browser's clock during capture. It keeps dates the page works out itself the same between captures. Dates the server works out, such as "Posted 3 days ago", follow the server's clock: seed them relative to the current time in the recipe's `setup` |

Flowmap captures with Playwright's browser. When that browser is not installed, Flowmap uses Google Chrome. If neither is available, run `npx playwright install chromium-headless-shell`.

## Build plan

1. Repository, CLI, MCP server, settings and state recipes. Then one local program, `flowmap serve`, for the viewer and the MCP endpoint, with one-step agent setup through `flowmap connect` and instructions built into the server.
2. Capture: `flowmap_capture` saves a picture and an HTML snapshot for each state at the current commit.
3. Viewer: a canvas of every captured screen and flow that updates live while agents work, a line that shows how fresh the captures are, and a Connect panel.
4. Compare with live: the changed areas of each screen, named for the agent, and a slider between live and the branch in the viewer.
5. Marks and tasks: mark an area on a screen, and an agent picks it up, fixes it and captures the result for your approval.
6. Self-check: agents see every screen their change affected before they say they are done.
7. Variations: compare several versions of a screen side by side and pick one.
8. Release: documentation, an example app, a static export and a CI action.

## Licence

MIT. The viewer's icons are [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The agent logos are from [Simple Icons](https://simpleicons.org) (CC0). Each logo is a trademark of its owner.
