#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CLIENTS, connectInfo, writeClient, type Client } from "./connect.js";
import { init } from "./init.js";
import { serveStdio } from "./mcp.js";
import { overview } from "./overview.js";
import { AtlasError, findRoot, readConfig } from "./project.js";
import { DEFAULT_PORT, serve } from "./serve.js";
import { VERSION } from "./version.js";

const HELP = `atlas ${VERSION}
See every screen of your web app as the code renders it.

Usage:
  atlas init                    Set up .atlas/ in this project
  atlas serve [--port <n>]      Start Atlas on this computer, with the MCP endpoint at /mcp
  atlas connect [--write <app>] Show how to connect a coding agent, or add Atlas to one: ${CLIENTS.join(", ")}
  atlas states [--json]         List state recipes and the live and branch commits
  atlas mcp                     Serve MCP over stdio, for clients that start the server themselves

Options:
  --root <folder>               The project's root folder (default: the nearest folder with .atlas/config.json)
  --port <n>                    The port for atlas serve and atlas connect (default: ${DEFAULT_PORT})
  -h, --help                    Show this help
  -v, --version                 Show the version
`;

const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : text + "\n");

function portOf(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AtlasError(`--port must be a whole number from 0 to 65535, not "${value}".`);
  return port;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      port: { type: "string" },
      write: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });
  const [command] = positionals;
  if (values.version) return out(VERSION), 0;
  if (values.help || !command || command === "help") return out(HELP), 0;
  const here = values.root ?? process.cwd();
  switch (command) {
    case "init": {
      const result = init(here);
      out(`Set up Atlas for ${result.config.name} in ${result.root}`);
      for (const item of result.created) out(`  ${item}`);
      out(`Live is ${result.config.liveRef}. Change it in .atlas/config.json if the project deploys from another ref.`);
      out(`Next: run "atlas serve", then "atlas connect" to connect your coding agent.`);
      return 0;
    }
    case "serve": {
      const root = findRoot(here);
      const running = await serve(root, portOf(values.port));
      out(`Atlas for ${readConfig(root).name} is running.`);
      out(`MCP endpoint: ${running.url}`);
      out(`Run "atlas connect" to connect a coding agent. Press Ctrl+C to stop.`);
      return 0;
    }
    case "connect": {
      const info = connectInfo(`http://localhost:${portOf(values.port)}/mcp`);
      if (values.write) {
        if (!(CLIENTS as readonly string[]).includes(values.write)) throw new AtlasError(`--write takes one of: ${CLIENTS.join(", ")}.`);
        return out(writeClient(values.write as Client, info.url, here)), 0;
      }
      if (values.json) return out(JSON.stringify(info, null, 2)), 0;
      out(`Connect a coding agent to Atlas at ${info.url}. Atlas must be running ("atlas serve").\n`);
      for (const c of info.clients) {
        out(`${c.name}${c.installed ? "" : " (not found on this computer)"}`);
        out(`  ${c.client === "cursor" ? "Open this link" : "Run"}: ${c.command}`);
        out(`  Or let Atlas add itself: atlas connect --write ${c.client}\n`);
      }
      out(`Any other MCP client: add this to its settings.`);
      out(JSON.stringify(info.other, null, 2));
      return 0;
    }
    case "states": {
      const view = overview(findRoot(here));
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
      await serveStdio(findRoot(here));
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
