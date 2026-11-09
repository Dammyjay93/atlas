# Flowmap

[![npm](https://img.shields.io/npm/v/useflowmap)](https://www.npmjs.com/package/useflowmap)
[![CI](https://github.com/Dammyjay93/flowmap/actions/workflows/ci.yml/badge.svg)](https://github.com/Dammyjay93/flowmap/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

See every screen of your web app as the code renders it, compare it with live, and send changes back to your coding agents.

![Every screen of an admin app on one canvas, grouped by area, with the flows between them.](docs/images/canvas.png)

## Quick start

Open your coding agent (Claude Code, Codex or Cursor) in your project and paste:

> Set up Flowmap: run `npx useflowmap setup` and do what it prints.

Your agent writes a recipe for each screen, starts your app and captures every screen. You watch them appear in your browser. Flowmap needs Node 22 or later and git.

## Every screen and every state

Each route, tab, dialog, empty state and step of a flow, signed in or not, captured from the code at a commit. Each page keeps its states in a menu, so a drawer, a dialog or a filter is one click away.

![The tasks page in Flowmap, with its menu of states open: create drawer, delete dialog, row menu and more.](docs/images/states.png)

## Compare with live

Flowmap outlines what changed on each screen and names each element that was added, removed, moved or looks different. Drag between live and your branch.

![The dashboard compared with live: live on the left of the handle, the branch on the right, and the two new buttons outlined.](docs/images/compare.png)

## Mark what should change

Drag over a part of a screen and write what should change. Your agent gets it as a task, with the element under your mark.

![A box drawn around two buttons on the users page, with the request typed beside it.](docs/images/ask.png)

## Review the agent's work

When the agent is done, see before and after side by side. Approve it, or send it back with a note.

![A task ready for review: the request, the agent's note, before and after pictures, and Approve and Send back.](docs/images/review.png)

## Versions side by side

Ask for several versions of a screen. They appear next to each other, and you choose one.

![Three versions of the dashboard's stat cards side by side, each with a one-line note.](docs/images/versions.png)

## A check before "done"

Before your agent says a change is done, it captures every screen again and sees each one its change touched, including the ones it did not mean to change.

```text
$ npx useflowmap check --base-url http://localhost:5410
Checked 461f5222 against e16c87f2
  dashboard at 1440: changed
    Added: Export report
    Added: New sale
    Removed: Download
  dashboard at 390: changed
    Added: Export report
    Added: New sale
    Removed: Download
  users at 1440: same
  users at 390: same
```

## Connect your agent

Flowmap runs on your computer, with no account. Connect Claude Code, Codex or Cursor in one step, and your agent learns how to use Flowmap from the server itself.

![The Connect panel, with a button for Claude Code, Codex, Cursor and any other MCP client.](docs/images/connect.png)

## Learn more

- [Reference](docs/reference.md): commands, MCP tools, state recipes, sign-in for captures, and settings.
- [Changelog](CHANGELOG.md): what each release changed.
- [Contributing](CONTRIBUTING.md): build Flowmap, run the tests and send a change.
- [Security](SECURITY.md): report a problem privately.

## Licence

MIT. The viewer's icons are [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The agent logos are from [Simple Icons](https://simpleicons.org) (CC0). Each logo is a trademark of its owner.
