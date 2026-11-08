#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { capture } from "./capture.js";
import { check } from "./check.js";
import { compareState } from "./compare.js";
import { readTasks, STATUSES } from "./tasks.js";
import { VariantSchema } from "./variants.js";
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
  atlas                         Start Atlas in this project: set it up if needed, serve it and open the viewer
  atlas init                    Set up .atlas/ in this project
  atlas serve [--port <n>]      Start Atlas on this computer, with the MCP endpoint at /mcp
  atlas connect [--write <app>] Show how to connect a coding agent, or add Atlas to one: ${CLIENTS.join(", ")}
  atlas states [--json]         List state recipes and the live and branch commits
  atlas capture <state> --base-url <url> [--cookie name=value]... [--width <n>]... [--live]
                                [--variant <set>/<name> --note <text> [--route <path>]]
                                Capture one state at the current commit, at live with --live, or as a version to choose from
  atlas check --base-url <url> [--cookie name=value]... [--json]
                                Capture every state and list the screens that changed since before your change
  atlas tasks [--status <s>] [--json]
                                List the changes the person asked for: ${STATUSES.join(", ")}
  atlas compare <state> [--json] Compare a state's captures at the current commit with its captures at live
  atlas mcp                     Serve MCP over stdio, for clients that start the server themselves

Options:
  --root <folder>               The project's root folder (default: the nearest folder with .atlas/config.json)
  --port <n>                    The port for atlas serve and atlas connect (default: ${DEFAULT_PORT})
  --no-open                     Start without opening the viewer in a browser
  -h, --help                    Show this help
  -v, --version                 Show the version
`;

/** Opens the viewer in the person's default browser. A failure only means they open the address themselves. */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(command, args as string[], () => undefined);
}

const STATUS_TEXT = { same: "same as live", changed: "changed from live", new: "no live capture", missing: "not captured at this commit" } as const;

const KIND_TEXT = { added: "Added", removed: "Removed", moved: "Moved", changed: "Looks different" } as const;

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
      "base-url": { type: "string" },
      cookie: { type: "string", multiple: true },
      width: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      status: { type: "string" },
      variant: { type: "string" },
      note: { type: "string" },
      route: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });
  const [command] = positionals;
  if (values.version) return out(VERSION), 0;
  if (values.help || command === "help") return out(HELP), 0;
  const here = values.root ?? process.cwd();
  switch (command ?? "start") {
    case "start": {
      let root: string;
      try {
        root = findRoot(here);
      } catch {
        if (!existsSync(join(here, ".git"))) throw new AtlasError(`${here} is not the root of a git project. Run atlas in your project's root folder.`);
        root = init(here).root;
        out(`Set up Atlas in ${root}.`);
      }
      const running = await serve(root, portOf(values.port));
      out(`Atlas for ${readConfig(root).name} is running at ${running.viewer}`);
      out(`Connect your coding agent with one command:`);
      for (const c of connectInfo(running.url).clients.filter((x) => x.client !== "cursor")) out(`  ${c.name}: ${c.command}`);
      out(`  Cursor: atlas connect --write cursor`);
      out(`Then ask your agent to set up Atlas for this app. Press Ctrl+C to stop.`);
      if (!values["no-open"]) openInBrowser(running.viewer);
      return 0;
    }
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
      out(`Viewer: ${running.viewer}`);
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
    case "capture": {
      const id = positionals[1];
      if (!id || !values["base-url"]) throw new AtlasError('Usage: atlas capture <state> --base-url <url> [--cookie name=value]... [--width <n>]... [--live]');
      const cookies = (values.cookie ?? []).map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new AtlasError(`--cookie takes name=value, not "${pair}".`);
        return { name: pair.slice(0, at), value: pair.slice(at + 1) };
      });
      const widths = values.width?.map((w) => portOf(w));
      let variant;
      if (values.variant) {
        const [set, name] = values.variant.split("/");
        const parsed = VariantSchema.safeParse({ set, name, note: values.note, ...(values.route ? { route: values.route } : {}) });
        if (!parsed.success) throw new AtlasError(`--variant takes <set>/<name> with --note, and --route for the address that shows it: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        variant = parsed.data;
      }
      const result = await capture(findRoot(here), { state: id, baseUrl: values["base-url"], cookies, live: values.live, ...(variant ? { variant } : {}), ...(widths ? { widths } : {}) });
      if (values.json) return out(JSON.stringify({ ...result, widths: result.widths.map(({ preview, ...w }) => w) }, null, 2)), 0;
      out(`Captured ${result.state} at ${values.live ? "live, " : ""}${result.commit}${result.uncommitted ? " with uncommitted changes" : ""}`);
      for (const w of result.widths) {
        const status = w.entry.status >= 200 && w.entry.status < 300 ? "" : `, the page answered HTTP ${w.entry.status}`;
        out(`  ${w.width}: ${w.entry.png}${w.changed ? "" : " (same as before)"}${w.entry.landedOn ? `, landed on ${w.entry.landedOn}` : ""}${status}`);
      }
      return 0;
    }
    case "check": {
      if (!values["base-url"]) throw new AtlasError("Usage: atlas check --base-url <url> [--cookie name=value]... [--json]");
      const cookies = (values.cookie ?? []).map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new AtlasError(`--cookie takes name=value, not "${pair}".`);
        return { name: pair.slice(0, at), value: pair.slice(at + 1) };
      });
      const result = await check(findRoot(here), { baseUrl: values["base-url"], cookies });
      if (values.json) return out(JSON.stringify(result, null, 2)), 0;
      out(`Checked ${result.head.commit}${result.head.uncommitted ? " with uncommitted changes" : ""} against ${result.base?.commit ?? "nothing (no earlier captures)"}`);
      for (const w of result.widths) {
        out(`  ${w.state} at ${w.width}: ${w.status}${w.problem ? `: ${w.problem}` : ""}`);
        for (const line of new Set(w.areas.flatMap((a) => a.changes.map((c) => `${KIND_TEXT[c.kind]}: ${c.name}`)))) out(`    ${line}`);
      }
      return result.widths.some((w) => w.status === "failed") ? 1 : 0;
    }
    case "tasks": {
      if (values.status && !(STATUSES as readonly string[]).includes(values.status)) throw new AtlasError(`--status takes one of: ${STATUSES.join(", ")}.`);
      const { tasks, invalid } = readTasks(findRoot(here));
      const chosen = tasks.filter((t) => !values.status || t.status === values.status);
      if (values.json) return out(JSON.stringify({ tasks: chosen, invalid }, null, 2)), 0;
      out(`${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}`);
      for (const t of chosen) {
        out(`  ${t.id}  ${t.status}  ${t.state} at ${t.width}px${t.element ? `, on ${t.element.tag} "${t.element.text}"` : ""}`);
        out(`    ${t.words.split("\n").join("\n    ")}`);
      }
      for (const i of invalid) out(`  ${i.file} cannot be read: ${i.problem}`);
      return invalid.length ? 1 : 0;
    }
    case "compare": {
      const id = positionals[1];
      if (!id) throw new AtlasError("Usage: atlas compare <state> [--json]");
      const result = compareState(findRoot(here), id);
      if (values.json) return out(JSON.stringify(result, null, 2)), 0;
      out(`${result.state}: ${result.branch.commit} against live ${result.live.ref} at ${result.live.commit}`);
      if (!result.live.captured) out(`  Nothing is captured at live yet. Capture with --live from a copy of the project checked out at ${result.live.commit}.`);
      for (const w of result.widths) {
        out(`  ${w.width}: ${STATUS_TEXT[w.status]}${w.moved ? ", and content moved" : ""}`);
        for (const a of w.areas) {
          out(`    Changed area at x ${a.x}, y ${a.y}, ${a.w} × ${a.h}`);
          if (!a.changes.length) out(`      Pixels changed that no element accounts for`);
          for (const c of a.changes) {
            const box = c.box ?? c.liveBox;
            out(`      ${KIND_TEXT[c.kind]}: ${c.name} (${c.tag}${box ? ` at x ${box.x}, y ${box.y}, ${box.w} × ${box.h}` : ""}${c.kind === "removed" ? " on live" : ""})`);
          }
        }
      }
      return 0;
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
