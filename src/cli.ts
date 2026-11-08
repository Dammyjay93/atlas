#!/usr/bin/env node
import { parseArgs } from "node:util";
import { init } from "./init.js";
import { serveMcp } from "./mcp.js";
import { overview } from "./overview.js";
import { AtlasError, findRoot } from "./project.js";
import { VERSION } from "./version.js";

const HELP = `atlas ${VERSION}
See every screen of your web app as the code renders it.

Usage:
  atlas init            Set up .atlas/ in this project
  atlas states [--json] List state recipes and the live and branch commits
  atlas mcp             Start the MCP server for coding agents (stdio)

Options:
  --root <folder>       The project's root folder (default: the nearest folder with .atlas/config.json)
  -h, --help            Show this help
  -v, --version         Show the version
`;

const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : text + "\n");

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });
  const [command] = positionals;
  if (values.version) return out(VERSION), 0;
  if (values.help || !command || command === "help") return out(HELP), 0;
  switch (command) {
    case "init": {
      const result = init(values.root ?? process.cwd());
      out(`Set up Atlas for ${result.config.name} in ${result.root}`);
      for (const item of result.created) out(`  ${item}`);
      out(`Live is ${result.config.liveRef}. Change it in .atlas/config.json if the project deploys from another ref.`);
      return 0;
    }
    case "states": {
      const view = overview(findRoot(values.root ?? process.cwd()));
      if (values.json) return out(JSON.stringify(view, null, 2)), 0;
      out(`${view.project}: branch ${view.branch.name ?? "(detached)"} at ${view.branch.commit ?? "no commit"}, live ${view.live.ref} at ${view.live.commit ?? "not found"}`);
      out(`${view.states.length} ${view.states.length === 1 ? "state" : "states"}`);
      for (const s of view.states) out(`  ${s.id}  ${s.name}  ${s.route}`);
      if (view.invalid.length) {
        out(`${view.invalid.length} invalid ${view.invalid.length === 1 ? "recipe" : "recipes"}`);
        for (const i of view.invalid) out(`  ${i.file}: ${i.problem}`);
      }
      return view.invalid.length ? 1 : 0;
    }
    case "mcp":
      await serveMcp(findRoot(values.root ?? process.cwd()));
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}". Run "atlas --help".\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code) process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof AtlasError || error instanceof TypeError ? error.message : error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
