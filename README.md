# Atlas

See every screen of your web app as the code renders it, compare it with live, and send changes back to your coding agents.

Atlas is for people who build by prompting coding agents. Agents build many screens and flows quickly, and clicking through all of them to check the result is slow. Atlas puts every screen in one place, shows what differs from live, and turns your marks into tasks that agents pick up.

> **Status:** early. Atlas can set up a project, serve its MCP tools on your computer, connect your coding agent in one step, teach the agent how to write state recipes, and capture each state as a picture and an HTML snapshot. The viewer shows every captured screen and updates while your agent works. Atlas compares each screen with live, outlines what changed and names the elements in each change. You mark what should change on a screen, and your agent works through it as a task for you to approve. The [build plan](#build-plan) lists the steps.

## How it works

- **Your coding agent prepares each state.** It has the code. It seeds data, starts the app at the right commit, signs in and opens the screen.
- **Atlas captures and keeps it.** Every capture belongs to one commit and one state, so the canvas always shows what the code renders.
- **Live comes from git.** You name the ref your project deploys from. Atlas resolves it on every run and never stores a commit by hand.
- **Your feedback goes to agents as tasks.** Tasks are files in your repository, so every agent and person sees the same list and its history.

## Set up

Atlas needs Node 22 or later and git.

```sh
git clone https://github.com/Dammyjay93/atlas.git
cd atlas
pnpm install
pnpm build
```

In your project's root folder:

```sh
node /path/to/atlas/dist/cli.js
```

The first time, this sets up Atlas in the project. Then it starts Atlas and opens the viewer in your browser. Set-up writes:

- `.atlas/config.json`: the project name, the live ref (from your remote's default branch) and the screen widths;
- `.atlas/states/`: one recipe for each state;
- `.atlas/tasks/`: one file for each task;
- a `.gitignore` line for `.atlas/store/`, where captures are kept.

### Connect your coding agent

Atlas runs on your computer only. The viewer is at `http://localhost:4317/` and the MCP endpoint at `http://localhost:4317/mcp`. Click **Connect** in the viewer, or connect your agent with one command:

| Agent | Command |
| --- | --- |
| Claude Code | `claude mcp add --transport http atlas http://localhost:4317/mcp` |
| Codex | `codex mcp add atlas --url http://localhost:4317/mcp` |
| Cursor | Open the link that `atlas connect` prints, or run `atlas connect --write cursor` |

`atlas connect` prints these for your setup, and `atlas connect --write <claude|codex|cursor>` adds Atlas to that agent for you. Any other MCP client takes the endpoint as a streamable HTTP server.

Then ask your agent: "Set up Atlas for this app." You don't need to add anything to `AGENTS.md` or similar files. The server tells your agent how to use Atlas. The Connect panel lists each agent that has connected since Atlas started.

For clients that start MCP servers themselves, `atlas mcp` serves the same tools over stdio.

## Commands

| Command | What it does |
| --- | --- |
| `atlas` | Sets up the project if it is new, starts Atlas and opens the viewer. `--no-open` keeps the browser closed |
| `atlas init` | Sets up `.atlas/` in the project |
| `atlas serve` | Starts Atlas on your computer: the viewer at `/` and the MCP endpoint at `/mcp`. `--port` changes the port from 4317 |
| `atlas connect` | Shows how to connect each coding agent. `--write <claude\|codex\|cursor>` adds Atlas to that agent |
| `atlas states` | Lists state recipes, recipes that need repair, and the live and branch commits. Add `--json` for structured output |
| `atlas capture <state> --base-url <url>` | Captures one state at the current commit. `--cookie name=value` passes a test session; `--width` overrides the widths; `--live` files the capture under live's commit, for an app started from a copy of the project at live |
| `atlas check --base-url <url>` | Captures every state at your current code and lists the screens that changed since before your change. `--cookie name=value` passes a test session |
| `atlas tasks` | Lists the changes you asked for. `--status` picks one status; add `--json` for structured output |
| `atlas compare <state>` | Compares a state's captures at the current commit with its captures at live. Add `--json` for structured output |
| `atlas mcp` | Serves the MCP tools over stdio |

## MCP tools

| Tool | What it does |
| --- | --- |
| `atlas_guide` | Explains how Atlas works and how to write state recipes. Agents call it once before their first Atlas task |
| `atlas_capture` | Captures one state at the current commit: a picture and an HTML snapshot for each width, saved in `.atlas/store/<commit>/<state>/`. Returns a picture of each width for the agent to check, and the status against live. `live: true` files the capture under live's commit |
| `atlas_compare` | Compares a state with live. Returns each width's status, each element that was added, removed, moved or looks different, with its exact box, and pictures of each area at live and at the current commit |
| `atlas_check` | Before an agent says a change is done: captures every state and lists every screen the change touched, including ones it did not mean to change, with the changed elements and pictures before and now. It replaces no captures |
| `atlas_tasks` | Lists the changes the person asked for, each with their words, the marked box, the element under it, its history and a picture with the box drawn on it. `status: approved` lists decisions to build from |
| `atlas_task_update` | Sets a task to `in-progress`, or to `ready-for-review` with a note once the agent has captured the state again. Atlas attaches that capture as the after picture |
| `atlas_states` | Lists state recipes, recipes that need repair and why, and the live and branch commits resolved from git |

## State recipes

A recipe tells an agent how to reach one state. Agents write a recipe when they build a screen, and repair it when it stops working.

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

The agent runs `setup` and `session`. Atlas opens `route` and runs `steps`. `fullPage` captures a long page in full. `leadsTo` draws the flow connectors between screens.

## Compare with live

Atlas compares code with code. Your agent checks out live's commit in a second copy of the project, starts the app there on the same data, and captures the same states with `live: true`. Atlas then compares each state at each width:

- It finds the columns where the pictures differ, then matches their rows as a text diff matches lines. Content that only moved up or down is not a change.
- Each capture records every visible element with its box. Atlas pairs the elements of live and the current commit in page order, and names each one that was added, removed, moved or looks different, at its exact box. Content carried along by an element that moved is named once, at that element.
- Each width gets a status: `same`, `changed`, `new` (no live capture) or `missing` (not captured at the current commit).

In the viewer, a changed screen says **Changed from live** and has each changed area outlined. Select it and choose **Compare with live** to drag between live and the current commit.

## Check before done

Before your agent says a change is done, it calls `atlas_check`. Atlas captures every state at the agent's current code and compares each with its capture from before the change: this commit's captures while the change is uncommitted, or the newest earlier commit's once it is committed. The agent sees every screen the change touched, including screens it did not mean to change, and names what moved, appeared, disappeared or looks different. The check keeps its captures apart, so it never replaces a commit's captures.

## Tasks

In the viewer, select a screen and choose **Ask for a change**. Drag on the screen to mark a part, write what should change, and choose **Send to agent**. Atlas saves the request in `.atlas/tasks/<id>.md`, with the box, the element under it and the commit you marked. Commit these files, so every agent and person sees the same tasks and their history.

A task moves from `open` to `in-progress` to `ready-for-review`, which the agent sets. You then approve it or send it back with a note, and a task you send back goes to the agent again. When the agent marks a task ready, Atlas attaches its new capture, and the viewer shows before and after side by side. **Copy as prompt** gives the request as text for an agent without MCP.

## Settings

`.atlas/config.json`:

| Field | What it does |
| --- | --- |
| `name` | The project's name |
| `liveRef` | The git ref the project deploys from, such as `origin/main`. Atlas resolves it on every run |
| `liveUrl` | The live site's address |
| `widths` | Screen widths to capture, in CSS pixels. Default: 1440 and 390 |
| `hide` | CSS selectors removed before each capture, such as a development overlay |
| `time` | A fixed time for the browser's clock during capture. It keeps dates the page works out itself the same between captures. Dates the server works out, such as "Posted 3 days ago", follow the server's clock: seed them relative to the current time in the recipe's `setup` |

Atlas captures with Playwright's browser. When that browser is not installed, Atlas uses Google Chrome. If neither is available, run `npx playwright install chromium-headless-shell`.

## Build plan

1. Repository, CLI, MCP server, settings and state recipes. Then one local program, `atlas serve`, for the viewer and the MCP endpoint, with one-step agent setup through `atlas connect` and instructions built into the server.
2. Capture: `atlas_capture` saves a picture and an HTML snapshot for each state at the current commit.
3. Viewer: a canvas of every captured screen and flow that updates live while agents work, a line that shows how fresh the captures are, and a Connect panel.
4. Compare with live: the changed areas of each screen, named for the agent, and a slider between live and the branch in the viewer.
5. Marks and tasks: mark an area on a screen, and an agent picks it up, fixes it and captures the result for your approval.
6. Self-check: agents see every screen their change affected before they say they are done.
7. Variations: compare several versions of a screen side by side and pick one.
8. Release: documentation, an example app, a static export and a CI action.

## Licence

MIT. The viewer's icons are [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The agent logos are from [Simple Icons](https://simpleicons.org) (CC0). Each logo is a trademark of its owner.
