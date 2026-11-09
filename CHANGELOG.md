# Changelog

Each release of the npm package `useflowmap`. Versions follow [semantic versioning](https://semver.org).

## 0.1.3 (not released)

- `Math.random` gives the same numbers on every capture, from a fixed seed, so a chart drawn from random numbers no longer shows as changed.
- `hide` also applies on each page that a step opens, not only on the first page.
- The setup text says how to connect an agent when you have two projects, and that a chart drawn from random numbers needs no change.

## 0.1.2 (9 November 2026)

Fixes for the roadblocks found when a coding agent set up Flowmap on shadcn-admin with no help.

- A failed step names the step, the widths it failed at, and why: no element matches, none is visible, or another element covers it.
- `hide` applies before a recipe's steps run, so a development overlay never covers a control that a step clicks.
- `landedOn` checks only where the app sent the browser when the page opened. A step that writes a query, such as a filter, no longer counts.
- Each project gets its own port from 4317 to 4416, worked out from its folder, so a connected agent keeps reaching the same project.
- The setup text explains step selectors, `--no-open`, apps with no sign-in, states that exist at one width, and screens that show today's date.

## 0.1.1 (9 November 2026)

- `flowmap serve` exits when its port is in use. Before, it printed the error and kept running, so each `flowmap setup` that tried a taken port left a process behind.

## 0.1.0 (8 November 2026)

The first release on npm. Run it with `npx useflowmap setup`.

- `flowmap capture` and `flowmap check` run each recipe's `setup` and `session` commands, so one command captures every screen, signed in or not, with no `--cookie`.
- A session command prints cookies as `name=value` lines, or localStorage items as `localStorage:name=value` lines.
- States with the same `setup` are captured together after one run of it. Two different setups never run at the same time.
- When a setup or a session command fails, Flowmap reports the states it left out with the command's output, and still captures the rest.
- A capture with uncommitted changes names the changed files. The `ignoreChanges` setting leaves out files that a tool rewrites when the app starts.
- `flowmap` with no command prints the usage when a program runs it, instead of running until stopped.
- The recipe guide shows how to write a session command from the app's own sign-in code, and asks for every state of the app.
