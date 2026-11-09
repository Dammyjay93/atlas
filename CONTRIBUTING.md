# Contributing to Flowmap

Thank you for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug or ask for a feature

Open an issue and choose a template. For a bug, give the Flowmap version (`npx useflowmap --version`), what you ran, what Flowmap printed, and what you expected. The quickest bugs to fix come with a recipe from `.flowmap/states/` that shows the problem.

## Build Flowmap

You need Node 22 or later, pnpm and git.

```sh
git clone https://github.com/Dammyjay93/flowmap.git
cd flowmap
pnpm install
pnpm build
```

The tests capture real pages, so they need a browser: Playwright's own browser, or Google Chrome. To install Playwright's browser:

```sh
npx playwright install chromium-headless-shell
```

Run every test. `pnpm test` builds first, because some tests run the built command:

```sh
pnpm test
```

## Try your change on a real app

Run your build in any web project instead of `npx useflowmap`. In the project's folder:

```sh
node /path/to/flowmap/dist/cli.js setup
```

Flowmap tells your coding agent to run that same file for the next steps, so the whole first run uses your build.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/cli.ts` | The `flowmap` command and the text that `flowmap setup` prints for agents |
| `src/guide.ts` | What the MCP server teaches agents: its instructions and each `flowmap_guide` topic |
| `src/mcp.ts` | The MCP tools |
| `src/capture.ts` | Capture: running `setup` and `session`, opening each page and taking its pictures |
| `src/check.ts`, `src/compare.ts` | The check before done, and the comparison with live |
| `src/states.ts`, `src/project.ts` | The recipe format and the settings in `.flowmap/config.json` |
| `src/serve.ts`, `viewer/index.html` | The local server and the viewer |
| `src/tasks.ts`, `src/variants.ts` | Tasks and versions |
| `test/` | Tests. Each one makes a throwaway git project and a small app to capture |

## Rules for a change

- **Flowmap works for any web app.** A fix must not depend on one framework, one sign-in system or one project's files.
- **Every change comes with a test** that fails without it.
- **Keep the agent's instructions true.** If a change alters a command, a tool or a file format, update `src/guide.ts`, the text in `src/cli.ts` and `docs/reference.md` in the same pull request. Agents follow that text word for word.
- **Write plain text.** Short sentences, one name for each thing, no jargon. This applies to messages Flowmap prints, the guide and the README.
- **No `any`, no `console.log`, no empty `catch`.** TypeScript must pass with `pnpm typecheck`.

## Send a pull request

1. Branch from `main`.
2. Make the change, with its test.
3. Run `pnpm test`, and try the change on a real app when it touches capture, setup or the agent's instructions.
4. Add a line under a new version at the top of `CHANGELOG.md`.
5. Open the pull request and fill in the template.

## Release

The maintainer releases from `main`:

1. Set the new version in `package.json`, and give its section in `CHANGELOG.md` a date.
2. Commit, and push `main`.
3. Run `npm publish`. It builds and runs every test first.
4. Tag the commit as `v<version>` and push the tag.
