#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { capture, captureMany, type CaptureResult } from "./capture.js";
import { check } from "./check.js";
import { compareState } from "./compare.js";
import { readTasks, STATUSES } from "./tasks.js";
import { VariantSchema } from "./variants.js";
import { CLIENTS, connectInfo, writeClient, type Client } from "./connect.js";
import { init } from "./init.js";
import { serveStdio } from "./mcp.js";
import { overview } from "./overview.js";
import { FlowmapError, findRoot, readConfig } from "./project.js";
import { DEFAULT_PORT, serve } from "./serve.js";
import { TOPICS } from "./guide.js";
import { PACKAGE, VERSION } from "./version.js";

const HELP = `flowmap ${VERSION}
See every screen of your web app as the code renders it.

Usage:
  flowmap [start]                 In a terminal: set Flowmap up if needed, serve it and open the viewer, until Ctrl+C
  flowmap setup                   For your coding agent: set Flowmap up, start it in the background, open the viewer,
                                and print what the agent does next
  flowmap init                    Set up .flowmap/ in this project
  flowmap serve [--port <n>]      Start Flowmap on this computer, with the MCP endpoint at /mcp
  flowmap connect [--write <app>] Show how to connect a coding agent, or add Flowmap to one: ${CLIENTS.join(", ")}
  flowmap states [--json]         List state recipes and the live and branch commits
  flowmap capture [<state>...] --base-url <url> [--cookie name=value]... [--width <n>]... [--live]
                                [--variant <set>/<name> --note <text> [--route <path>]]
                                Capture every state, or the ones named, at the current commit; one state at live with --live,
                                or as a version to choose from. Runs each recipe's setup and session first, one setup at a time
  flowmap check --base-url <url> [--cookie name=value]... [--json]
                                Capture every state and list the screens that changed since before your change
  flowmap tasks [--status <s>] [--json]
                                List the changes the person asked for: ${STATUSES.join(", ")}
  flowmap compare <state> [--json] Compare a state's captures at the current commit with its captures at live
  flowmap mcp                     Serve MCP over stdio, for clients that start the server themselves

Options:
  --root <folder>               The project's root folder (default: the nearest folder with .flowmap/config.json)
  --port <n>                    The port for flowmap serve and flowmap connect (default: ${DEFAULT_PORT})
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

/** Names the files that make a capture show more than its commit. */
const withChanges = (changes: string[]) =>
  changes.length ? ` with uncommitted changes in ${changes.slice(0, 3).join(", ")}${changes.length > 3 ? ` and ${changes.length - 3} more` : ""}` : "";
const IGNORE_HINT = `If a tool rewrote one of these files when the app started, such as AGENTS.md under next dev, list it in "ignoreChanges" in .flowmap/config.json.`;

function portOf(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FlowmapError(`--port must be a whole number from 0 to 65535, not "${value}".`);
  return port;
}

/** The port where Flowmap already serves this project, or null. Flowmap answers on the first free port from 4317 up. */
async function servingAt(root: string): Promise<number | null> {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10; port++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/flowmap`, { signal: AbortSignal.timeout(1500) });
      const data = (await res.json()) as { project?: { root?: string } };
      if (data.project?.root === root) return port;
    } catch {
      // Nothing answers there, or something other than Flowmap does: look further.
      continue;
    }
  }
  return null;
}

/** Starts "flowmap serve" for the project in the background, on the first port that takes it, and waits until it answers. */
async function startInBackground(root: string): Promise<number> {
  const cli = fileURLToPath(import.meta.url);
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10; port++) {
    const child = spawn(process.execPath, [cli, "serve", "--root", root, "--port", String(port)], { detached: true, stdio: "ignore" });
    child.unref();
    for (let wait = 0; wait < 20; wait++) {
      await new Promise((done) => setTimeout(done, 150));
      if (child.exitCode !== null) break;
      if ((await servingAt(root)) === port) return port;
    }
  }
  throw new FlowmapError(`Flowmap could not start on any port from ${DEFAULT_PORT} to ${DEFAULT_PORT + 9}. Stop a program that uses them, then run setup again.`);
}

/**
 * How the agent ran Flowmap, so the commands it is told to run next work: "npx <package>" from npx or the project's own install,
 * "flowmap" from a global install, or the built file of a copy of the repository.
 */
const self = () => {
  const ran = process.argv[1] ?? "";
  if (/[\\/](_npx|node_modules)[\\/]/.test(ran)) return `npx ${PACKAGE}`;
  return /[\\/]flowmap$/.test(ran) ? "flowmap" : `node ${ran || "dist/cli.js"}`;
};

/** What the agent does after setup, printed for the agent that ran it. */
function nextForAgent(viewer: string, mcp: string, recipes: number): string {
  return `Flowmap is running at ${viewer} and is open in the person's browser. Do the next steps now, without asking the person:

1. ${recipes ? `The project has ${recipes} recipes in .flowmap/states/. Add a recipe for every state that has none.` : "Find the app's screens from its routes, and write a recipe in .flowmap/states/<id>.json for every state."} Every state means each route, and on each page each tab, menu, dialog, drawer, step of a flow, and each empty, error, plan or role state a person can reach. Do not leave out a screen because it needs sign-in or data: give it a setup command that puts the data in that state, and a session command that signs in a test account. The recipe guide below shows how.
2. Start the app's development server if it is not running.
3. Check the recipes with ${self()} states, and fix any it lists as invalid.
4. Capture every screen with one command: ${self()} capture --base-url <the app's address>. Flowmap runs each recipe's setup and session itself. Each screen appears in the person's browser as it is captured. Fix any recipe whose capture failed or landed on the wrong page. If the pictures show development-only buttons or badges, such as a router or query devtools button, add their CSS selectors to "hide" in .flowmap/config.json. If the capture reports uncommitted changes only in files the development server rewrote as it started, add those files to "ignoreChanges" in .flowmap/config.json. Then capture again.
5. Connect yourself to Flowmap for later work. Its tools, such as flowmap_capture and flowmap_tasks, load in your next session; until then, use the commands above. ${connectInfo(mcp).clients.filter((c) => c.client !== "cursor").map((c) => `${c.name}: ${c.command}.`).join(" ")} Cursor: ${self()} connect --write cursor.
6. Tell the person how many screens are in Flowmap, and that they can mark any of them for you to change.

${TOPICS.recipes.replace("Call flowmap_states after you write or change recipes", `Run ${self()} states after you write or change recipes`)}`;
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
      // Started by a program, such as a coding agent, it would serve until stopped and the program would see nothing.
      if (!command && !process.stdout.isTTY) {
        out(`"flowmap" with no command starts Flowmap and runs until you press Ctrl+C, so run it in a terminal. A coding agent runs "${self()} setup" instead.\n\n${HELP}`);
        return 2;
      }
      let root: string;
      try {
        root = findRoot(here);
      } catch {
        if (!existsSync(join(here, ".git"))) throw new FlowmapError(`${here} is not the root of a git project. Run flowmap in your project's root folder.`);
        root = init(here).root;
        out(`Set up Flowmap in ${root}.`);
      }
      const already = await servingAt(resolve(root));
      if (already !== null) {
        out(`Flowmap for ${readConfig(root).name} is already running at http://localhost:${already}/`);
        if (!values["no-open"]) openInBrowser(`http://localhost:${already}/`);
        return 0;
      }
      const running = await serve(root, portOf(values.port));
      out(`Flowmap for ${readConfig(root).name} is running at ${running.viewer}`);
      out(`Connect your coding agent with one command:`);
      for (const c of connectInfo(running.url).clients.filter((x) => x.client !== "cursor")) out(`  ${c.name}: ${c.command}`);
      out(`  Cursor: ${self()} connect --write cursor`);
      out(`Then ask your agent to set up Flowmap for this app. Press Ctrl+C to stop.`);
      if (!values["no-open"]) openInBrowser(running.viewer);
      return 0;
    }
    case "setup": {
      // Run by the person's coding agent: set up the project if needed, start Flowmap in the background, open the viewer,
      // and tell the agent what to do next. The person never opens a terminal.
      let root: string;
      try {
        root = findRoot(here);
      } catch {
        if (!existsSync(join(here, ".git"))) throw new FlowmapError(`${here} is not the root of a git project. Run flowmap setup in the project's root folder.`);
        root = init(here).root;
      }
      root = resolve(root);
      const port = (await servingAt(root)) ?? (await startInBackground(root));
      const viewer = `http://localhost:${port}/`;
      if (!values["no-open"]) openInBrowser(viewer);
      out(nextForAgent(viewer, `${viewer}mcp`, overview(root).states.length));
      return 0;
    }
    case "init": {
      const result = init(here);
      out(`Set up Flowmap for ${result.config.name} in ${result.root}`);
      for (const item of result.created) out(`  ${item}`);
      out(`Live is ${result.config.liveRef}. Change it in .flowmap/config.json if the project deploys from another ref.`);
      out(`Next: run "flowmap serve", then "flowmap connect" to connect your coding agent.`);
      return 0;
    }
    case "serve": {
      const root = findRoot(here);
      const running = await serve(root, portOf(values.port));
      out(`Flowmap for ${readConfig(root).name} is running.`);
      out(`Viewer: ${running.viewer}`);
      out(`MCP endpoint: ${running.url}`);
      out(`Run "flowmap connect" to connect a coding agent. Press Ctrl+C to stop.`);
      return 0;
    }
    case "connect": {
      const info = connectInfo(`http://localhost:${portOf(values.port)}/mcp`);
      if (values.write) {
        if (!(CLIENTS as readonly string[]).includes(values.write)) throw new FlowmapError(`--write takes one of: ${CLIENTS.join(", ")}.`);
        return out(writeClient(values.write as Client, info.url, here)), 0;
      }
      if (values.json) return out(JSON.stringify(info, null, 2)), 0;
      out(`Connect a coding agent to Flowmap at ${info.url}. Flowmap must be running ("flowmap serve").\n`);
      for (const c of info.clients) {
        out(`${c.name}${c.installed ? "" : " (not found on this computer)"}`);
        out(`  ${c.client === "cursor" ? "Open this link" : "Run"}: ${c.command}`);
        out(`  Or let Flowmap add itself: ${self()} connect --write ${c.client}\n`);
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
      const ids = positionals.slice(1), id = ids[0];
      if (!values["base-url"]) throw new FlowmapError("Usage: flowmap capture [<state>...] --base-url <url> [--cookie name=value]... [--width <n>]... [--live]");
      const cookies = (values.cookie ?? []).map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new FlowmapError(`--cookie takes name=value, not "${pair}".`);
        return { name: pair.slice(0, at), value: pair.slice(at + 1) };
      });
      const widths = values.width?.map((w) => portOf(w));
      let variant;
      if (values.variant) {
        const [set, name] = values.variant.split("/");
        const parsed = VariantSchema.safeParse({ set, name, note: values.note, ...(values.route ? { route: values.route } : {}) });
        if (!parsed.success) throw new FlowmapError(`--variant takes <set>/<name> with --note, and --route for the address that shows it: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        variant = parsed.data;
      }
      if (ids.length !== 1) {
        // No state, or several: every one named (or every recipe) in one browser, several at a time.
        if (values.live || variant) throw new FlowmapError("--live and --variant capture one state at a time. Name the state.");
        const started = Date.now();
        const all = await captureMany(findRoot(here), { states: ids, baseUrl: values["base-url"], cookies, ...(widths ? { widths } : {}) });
        const results = all.filter((r): r is CaptureResult => "widths" in r), failed = all.length - results.length;
        if (values.json) return out(JSON.stringify(all.map((r) => ("widths" in r ? { ...r, widths: r.widths.map(({ preview, ...w }) => w) } : r)), null, 2)), failed ? 1 : 0;
        out(`Captured ${results.length} of ${all.length} ${all.length === 1 ? "state" : "states"} at ${results[0]?.commit ?? ""}${withChanges(results[0]?.changes ?? [])} in ${Math.round((Date.now() - started) / 100) / 10} s`);
        for (const r of all) {
          if (!("widths" in r)) {
            out(`  ${r.state}: not captured. ${r.problem.split("\n").join("\n    ")}`);
            continue;
          }
          const odd = r.widths.filter((w) => w.entry.landedOn || w.entry.status < 200 || w.entry.status >= 300);
          out(`  ${r.state}${odd.map((w) => `, at ${w.width}: ${w.entry.landedOn ? `landed on ${w.entry.landedOn}` : `HTTP ${w.entry.status}`}`).join("")}`);
        }
        if (results[0]?.uncommitted) out(IGNORE_HINT);
        return failed ? 1 : 0;
      }
      const result = await capture(findRoot(here), { state: id ?? "", baseUrl: values["base-url"], cookies, live: values.live, ...(variant ? { variant } : {}), ...(widths ? { widths } : {}) });
      if (values.json) return out(JSON.stringify({ ...result, widths: result.widths.map(({ preview, ...w }) => w) }, null, 2)), 0;
      out(`Captured ${result.state} at ${values.live ? "live, " : ""}${result.commit}${withChanges(result.changes)}`);
      for (const w of result.widths) {
        const status = w.entry.status >= 200 && w.entry.status < 300 ? "" : `, the page answered HTTP ${w.entry.status}`;
        out(`  ${w.width}: ${w.entry.png}${w.changed ? "" : " (same as before)"}${w.entry.landedOn ? `, landed on ${w.entry.landedOn}` : ""}${status}`);
      }
      if (result.uncommitted) out(IGNORE_HINT);
      return 0;
    }
    case "check": {
      if (!values["base-url"]) throw new FlowmapError("Usage: flowmap check --base-url <url> [--cookie name=value]... [--json]");
      const cookies = (values.cookie ?? []).map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new FlowmapError(`--cookie takes name=value, not "${pair}".`);
        return { name: pair.slice(0, at), value: pair.slice(at + 1) };
      });
      const result = await check(findRoot(here), { baseUrl: values["base-url"], cookies });
      if (values.json) return out(JSON.stringify(result, null, 2)), 0;
      out(`Checked ${result.head.commit}${withChanges(result.head.changes)} against ${result.base?.commit ?? "nothing (no earlier captures)"}`);
      if (result.head.uncommitted) out(IGNORE_HINT);
      for (const w of result.widths) {
        out(`  ${w.state} at ${w.width}: ${w.status}${w.problem ? `: ${w.problem}` : ""}`);
        for (const line of new Set(w.areas.flatMap((a) => a.changes.map((c) => `${KIND_TEXT[c.kind]}: ${c.name}`)))) out(`    ${line}`);
      }
      return result.widths.some((w) => w.status === "failed") ? 1 : 0;
    }
    case "tasks": {
      if (values.status && !(STATUSES as readonly string[]).includes(values.status)) throw new FlowmapError(`--status takes one of: ${STATUSES.join(", ")}.`);
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
      if (!id) throw new FlowmapError("Usage: flowmap compare <state> [--json]");
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
      process.stderr.write(`Unknown command "${command}". Run "flowmap --help".\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code) process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof FlowmapError || error instanceof TypeError ? error.message : error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
