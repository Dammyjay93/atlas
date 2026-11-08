# Atlas

See every screen of your web app as the code renders it, compare it with live, and send changes back to your coding agents.

Atlas is for people who build by prompting coding agents. Agents build many screens and flows quickly, and clicking through all of them to check the result is slow. Atlas puts every screen in one place, shows what differs from live, and turns your marks into tasks that agents pick up.

> **Status:** early. Atlas can set up a project, serve its MCP tools on your computer, connect your coding agent in one step, and teach the agent how to write state recipes. Capture, the viewer, compare and tasks come next. The [build plan](#build-plan) lists the steps.

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
node /path/to/atlas/dist/cli.js init
```

This writes:

- `.atlas/config.json`: the project name, the live ref (from your remote's default branch) and the screen widths;
- `.atlas/states/`: one recipe for each state;
- `.atlas/tasks/`: one file for each task;
- a `.gitignore` line for `.atlas/store/`, where captures are kept.

### Start Atlas and connect your coding agent

In your project's root folder:

```sh
node /path/to/atlas/dist/cli.js serve
```

Atlas runs on your computer only, with its MCP endpoint at `http://localhost:4317/mcp`. Then connect your agent with one command:

| Agent | Command |
| --- | --- |
| Claude Code | `claude mcp add --transport http atlas http://localhost:4317/mcp` |
| Codex | `codex mcp add atlas --url http://localhost:4317/mcp` |
| Cursor | Open the link that `atlas connect` prints, or run `atlas connect --write cursor` |

`atlas connect` prints these for your setup, and `atlas connect --write <claude|codex|cursor>` adds Atlas to that agent for you. Any other MCP client takes the endpoint as a streamable HTTP server.

You don't need to add anything to `AGENTS.md` or similar files. The server tells your agent how to use Atlas.

For clients that start MCP servers themselves, `atlas mcp` serves the same tools over stdio.

## Commands

| Command | What it does |
| --- | --- |
| `atlas init` | Sets up `.atlas/` in the project |
| `atlas serve` | Starts Atlas on your computer, with the MCP endpoint at `/mcp`. `--port` changes the port from 4317 |
| `atlas connect` | Shows how to connect each coding agent. `--write <claude\|codex\|cursor>` adds Atlas to that agent |
| `atlas states` | Lists state recipes, recipes that need repair, and the live and branch commits. Add `--json` for structured output |
| `atlas mcp` | Serves the MCP tools over stdio |

## MCP tools

| Tool | What it does |
| --- | --- |
| `atlas_guide` | Explains how Atlas works and how to write state recipes. Agents call it once before their first Atlas task |
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

The agent runs `setup` and `session`. Atlas opens `route` and runs `steps`. `leadsTo` draws the flow connectors between screens.

## Build plan

1. Repository, CLI, MCP server, settings and state recipes. Then one local program, `atlas serve`, for the viewer and the MCP endpoint, with one-step agent setup through `atlas connect` and instructions built into the server.
2. Capture: `atlas_capture` saves a picture and an HTML snapshot for each state at the current commit.
3. Viewer: a canvas of every captured screen and flow that updates live while agents work, a line that shows how fresh the captures are, and a Connect panel.
4. Compare with live: a slider between live and the branch, with changed areas outlined.
5. Marks and tasks: mark an area on a screen, and an agent picks it up, fixes it and captures the result for your approval.
6. Self-check: agents see every screen their change affected before they say they are done.
7. Variations: compare several versions of a screen side by side and pick one.
8. Release: documentation, an example app, a static export and a CI action.

## Licence

MIT
