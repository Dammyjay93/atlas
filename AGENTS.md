# Working on Flowmap

Flowmap is a command and an MCP server that captures every screen of a web app from its code. Read `CONTRIBUTING.md` for the layout and the rules. This file adds what an agent needs.

## Commands

- `pnpm install`: install.
- `pnpm build`: compile `src/` to `dist/`. The tests run the built command, so build before you run a single test file.
- `pnpm test`: build, then run every test. It needs Playwright's browser or Google Chrome.
- `pnpm typecheck`: TypeScript only.

## Rules

- Flowmap is generic. Never fix a problem for one app, framework or sign-in system only.
- `src/guide.ts` and the text that `flowmap setup` prints in `src/cli.ts` are instructions that other agents follow word for word. Describe only commands, tools and formats that exist. Change them in the same change as the behaviour.
- Every behaviour change has a test in `test/` that fails without it. Tests make a throwaway git project and a small local app; they never use a real app or the network.
- Each test that starts `flowmap serve` or `flowmap setup` must stop the server it started.
- Keep the README, `CHANGELOG.md` and the agent text in step with the code.
- Never commit `dist/`. It is built on publish.
