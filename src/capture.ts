import { exec, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { currentBranch, readConfig, resolveRef, FlowmapError } from "./project.js";
import { snapshotPage } from "./snapshot.js";
import { readStates, type State } from "./states.js";
import { saveCapture, type Entry } from "./store.js";
import { layoutMap, type LayoutItem } from "./text-map.js";
import { markBuilding, saveVariant, type Variant } from "./variants.js";

export interface CookieInput {
  name: string;
  value: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface CaptureInput {
  state: string;
  /** Where the agent started the app, such as http://localhost:3000. */
  baseUrl: string;
  /** The test session for states that need sign-in. */
  cookies?: CookieInput[];
  widths?: number[];
  /** True when baseUrl serves the live ref's code, such as a second copy of the project checked out at live. The capture is filed under the live commit. */
  live?: boolean;
  /** A version of a screen the person will choose from, captured from its own address. It is filed under its set. */
  variant?: Variant;
}

export interface WidthResult {
  width: number;
  entry: Entry;
  /** False when this commit already had the same picture for this state and width. */
  changed: boolean;
  /** A small picture for the agent to look at. */
  preview: Buffer;
}

export interface CaptureResult {
  state: string;
  commit: string;
  branch: string | null;
  uncommitted: boolean;
  /** The files with uncommitted changes, when `uncommitted`. */
  changes: string[];
  widths: WidthResult[];
}

/** A page counts as settled when two pictures this far apart match. Flowmap waits at most SETTLE_TRIES times the gap. */
const SETTLE_GAP_MS = 150;
const SETTLE_TRIES = 20;

/** The window height for a width: a laptop screen for wide layouts, a phone screen for narrow ones. */
const heightFor = (width: number) => (width >= 768 ? 900 : 844);

/** Launches Playwright's own browser, or the Chrome already on this computer when Playwright's is not installed. */
export async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw new FlowmapError(
        `Flowmap could not start a browser. Install Google Chrome, or run "npx playwright install chromium-headless-shell". (${(bundled as Error).message.split("\n")[0]})`
      );
    }
  }
}

/**
 * The project's files with uncommitted changes, so a capture that shows more than its commit says which. Leaves out .flowmap/
 * and the files in "ignoreChanges", which a tool rewrites when the app starts.
 */
export function uncommittedFiles(root: string): string[] {
  const skip = [".flowmap", ...readConfig(root).ignoreChanges].map((path) => `:(exclude)${path}`);
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", ".", ...skip], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
  } catch {
    return [];
  }
}

/** One width of one state, taken but not yet saved. */
export interface Shot {
  width: number;
  png: Buffer;
  preview: Buffer;
  html: string;
  layout: LayoutItem[];
  route: string;
  landedOn?: string;
  status: number;
  capturedAt: string;
}

/** The address of the app the agent started, checked. */
export function baseOf(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw new FlowmapError(`baseUrl "${baseUrl}" is not a web address, such as http://localhost:3000.`);
  }
}

/**
 * Opens one state at each width in an open browser and takes a picture at twice the pixel density, a smaller picture for the
 * agent, the visible elements and a self-contained HTML snapshot. Saving is up to the caller.
 */
export async function shoot(browser: Browser, root: string, state: State, base: URL, cookies: CookieInput[] | undefined, widths: number[]): Promise<Shot[]> {
  const config = readConfig(root);
  // Each width has its own window, so the widths are captured at the same time.
  const one = async (width: number): Promise<Shot> => {
      const context = await browser.newContext({ viewport: { width, height: heightFor(width) }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      try {
        // Set by host and path, not by URL: Playwright marks a cookie set by URL as secure only on https, which rejects
        // secure and __Host- session cookies on http://localhost, where browsers do allow them.
        if (cookies?.length) {
          await context.addCookies(cookies.map((c) => ({ ...c, domain: base.hostname, path: c.path ?? "/", secure: c.secure ?? (base.protocol === "https:" || c.name.startsWith("__Host-") || c.name.startsWith("__Secure-")) })));
        }
        const page = await context.newPage();
        if (config.time) await page.clock.setFixedTime(new Date(config.time));
        const target = new URL(state.route, base);
        const response = await page.goto(target.href, { waitUntil: "networkidle", timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        for (const step of state.steps ?? []) {
          if ("click" in step) await page.click(step.click);
          else if ("fill" in step) await page.fill(step.fill, step.value);
          else if ("press" in step) await page.keyboard.press(step.press);
          else await page.waitForSelector(step.waitFor);
        }
        if (state.steps?.length) await page.waitForLoadState("networkidle");
        for (const selector of config.hide) await page.locator(selector).evaluateAll((els) => els.forEach((el) => el.remove()));
        const opts = { fullPage: state.fullPage ?? false, animations: "disabled" as const, caret: "hide" as const };
        // Wait until the page stops changing: a loading bar or late content would otherwise show as a change that is not one.
        let last = await page.screenshot({ ...opts, type: "png", scale: "css" });
        for (let tries = 0; tries < SETTLE_TRIES; tries++) {
          await page.waitForTimeout(SETTLE_GAP_MS);
          const next = await page.screenshot({ ...opts, type: "png", scale: "css" });
          if (next.equals(last)) break;
          last = next;
        }
        const png = await page.screenshot({ ...opts, type: "png" });
        const preview = await page.screenshot({ ...opts, type: "jpeg", quality: 70, scale: "css" });
        // Before the snapshot, which rewrites the page's styles and so its layout.
        const layout = await page.evaluate(layoutMap, opts.fullPage);
        const html = await page.evaluate(snapshotPage);
        const landed = new URL(page.url());
        return {
          width, png, preview, html, layout,
          route: state.route,
          ...(landed.pathname + landed.search !== target.pathname + target.search ? { landedOn: landed.pathname + landed.search } : {}),
          status: response?.status() ?? 0,
          capturedAt: new Date().toISOString()
        };
      } finally {
        await context.close();
      }
  };
  try {
    return await Promise.all(widths.map(one));
  } catch (error) {
    if (error instanceof FlowmapError) throw error;
    throw new FlowmapError(`Capturing "${state.id}" failed: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** Runs `run` on each item, at most `limit` at a time, and returns the results in the items' order. */
async function inParallel<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await run(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** How many states Flowmap captures at the same time, each with all its widths. */
const AT_ONCE = 4;

/** The longest a recipe's setup or session command may run. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;

/** Runs a recipe's setup or session command in the project's folder, with FLOWMAP_BASE_URL set to the app's address, and returns what it printed. */
function runCommand(root: string, command: string, what: string, base: URL): Promise<string> {
  return new Promise((done, fail) => {
    exec(command, { cwd: root, env: { ...process.env, FLOWMAP_BASE_URL: base.origin }, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return done(stdout);
      const said = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
      const how = error.killed ? `did not finish in ${COMMAND_TIMEOUT_MS / 60_000} minutes` : `failed with exit code ${error.code ?? "unknown"}`;
      fail(new FlowmapError(`The ${what} ${how}: ${command}${said ? `\n${said}` : ""}`));
    });
  });
}

/**
 * The cookies a session command printed: one name=value on each line, such as sid=abc123. Blank lines are skipped. A line may
 * end with cookie attributes after a semicolon, as in a Set-Cookie header; Flowmap ignores them.
 */
export function parseSession(output: string, command: string): CookieInput[] {
  const cookies = output.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const pair = (line.split(";")[0] ?? "").trim(), at = pair.indexOf("=");
    if (at < 1) throw new FlowmapError(`The session command must print one cookie on each line as name=value, but printed "${line.slice(0, 80)}": ${command}`);
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
  });
  if (!cookies.length) throw new FlowmapError(`The session command printed no cookies. It must print one cookie on each line as name=value: ${command}`);
  return cookies;
}

/** Runs captures one call at a time, so two different setups never change the app's data at the same time. */
let turn: Promise<unknown> = Promise.resolve();
export function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = turn.then(run);
  turn = result.catch(() => undefined);
  return result;
}

/**
 * Prepares states and captures them, one setup at a time: states with the same setup form a group, the group's setup runs once
 * just before its states, then each session command runs once, and the group's states are captured several at a time with
 * the cookies their session printed. Results keep the states' order.
 */
export async function bySetup<R>(root: string, states: State[], base: URL, run: (state: State, cookies: CookieInput[]) => Promise<R>): Promise<R[]> {
  const groups = new Map<string, State[]>();
  for (const state of states) groups.set(state.setup ?? "", [...(groups.get(state.setup ?? "") ?? []), state]);
  const results = new Map<string, R>();
  const names = (group: State[]) => group.map((s) => `"${s.id}"`).join(", ");
  for (const [setup, group] of groups) {
    if (setup) await runCommand(root, setup, `setup of ${names(group)}`, base);
    const sessions = new Map<string, CookieInput[]>();
    for (const command of new Set(group.flatMap((s) => (s.session ? [s.session] : [])))) {
      const users = group.filter((s) => s.session === command);
      sessions.set(command, parseSession(await runCommand(root, command, `session command of ${names(users)}`, base), command));
    }
    const done = await inParallel(group, AT_ONCE, (state) => run(state, (state.session && sessions.get(state.session)) || []));
    group.forEach((state, at) => results.set(state.id, done[at] as R));
  }
  return states.map((state) => results.get(state.id) as R);
}

/**
 * Captures one state at each width and files it in the store under the current commit, or live's commit with `live`.
 * Flowmap runs the recipe's setup, then its session command, and opens the page with the cookies the session printed.
 */
export function capture(root: string, input: CaptureInput): Promise<CaptureResult> {
  return oneAtATime(async () => {
    const { states } = readStates(root);
    const state = states.find((s) => s.id === input.state);
    if (!state) throw new FlowmapError(`No valid recipe with id "${input.state}". Recipes: ${states.map((s) => s.id).join(", ") || "none"}. Call flowmap_states to see recipes that need repair.`);
    if (input.live && input.variant) throw new FlowmapError("A capture is either of live or of a version to choose from, not both.");
    const base = baseOf(input.baseUrl);
    const browser = await launch();
    try {
      const [result] = await bySetup(root, [state], base, (s, cookies) => captureState(root, input, s, cookies, browser));
      return result as CaptureResult;
    } finally {
      await browser.close();
    }
  });
}

/** Captures a state that is already prepared, in an open browser, with its session's cookies, and files it. */
async function captureState(root: string, input: CaptureInput, state: State, session: CookieInput[], browser: Browser): Promise<CaptureResult> {
  const config = readConfig(root);
  const commit = input.live ? resolveRef(root, config.liveRef) : resolveRef(root, "HEAD");
  if (!commit) {
    throw new FlowmapError(input.live ? `Live's ref "${config.liveRef}" does not resolve to a commit. Fetch it, or set "liveRef" in .flowmap/config.json.` : "The project has no commit yet. Commit once, then capture.");
  }
  const base = baseOf(input.baseUrl);
  const at = { commit, branch: input.live ? config.liveRef : currentBranch(root) };
  const changes = input.live ? [] : uncommittedFiles(root);
  const uncommitted = changes.length > 0;
  // A version is captured from its own address; the rest of the recipe (steps, widths) applies as it is.
  const shown = input.variant?.route ? { ...state, route: input.variant.route } : state;
  const shots = await shoot(browser, root, shown, base, [...(input.cookies ?? []), ...session], input.widths ?? state.widths ?? config.widths);
  const variant = input.variant;
  const results = shots.map((s): WidthResult => {
    if (variant) {
      const paths = saveVariant(root, variant, commit, state.id, s.width, { png: s.png, html: s.html, layout: s.layout }, s.capturedAt);
      const entry: Entry = { ...paths, hash: createHash("sha256").update(s.png).digest("hex"), route: s.route, ...(s.landedOn ? { landedOn: s.landedOn } : {}), status: s.status, capturedAt: s.capturedAt, uncommitted };
      return { width: s.width, entry, changed: true, preview: s.preview };
    }
    const entry = { hash: createHash("sha256").update(s.png).digest("hex"), route: s.route, ...(s.landedOn ? { landedOn: s.landedOn } : {}), status: s.status, capturedAt: s.capturedAt, uncommitted };
    const previous = saveCapture(root, at, state.id, s.width, { png: s.png, html: s.html, layout: s.layout }, entry);
    const dir = `.flowmap/store/${commit}/${state.id}/${s.width}`;
    return { width: s.width, entry: { png: `${dir}.png`, html: `${dir}.html`, layout: `${dir}.layout.json`, ...entry }, changed: previous?.hash !== entry.hash, preview: s.preview };
  });
  // Every width is filed, so the version is built: the viewer swaps its building frame for the pictures at once.
  if (variant) markBuilding(root, variant, commit, state.id, false);
  return { state: state.id, commit, branch: at.branch, uncommitted, changes, widths: results };
}

/** Captures several states, or every state, in one browser: one setup at a time, and the states of each setup several at a time. */
export function captureMany(root: string, input: Omit<CaptureInput, "state" | "variant" | "live"> & { states?: string[] }): Promise<CaptureResult[]> {
  return oneAtATime(async () => {
    const all = readStates(root).states;
    const ids = input.states?.length ? input.states : all.map((s) => s.id);
    const unknown = ids.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new FlowmapError(`No valid recipe with id ${unknown.map((u) => `"${u}"`).join(", ")}. Recipes: ${all.map((s) => s.id).join(", ") || "none"}.`);
    if (!ids.length) throw new FlowmapError("There are no state recipes to capture. Write recipes first.");
    const base = baseOf(input.baseUrl);
    const browser = await launch();
    try {
      return await bySetup(root, all.filter((s) => ids.includes(s.id)), base, (state, cookies) => captureState(root, { ...input, state: state.id }, state, cookies, browser));
    } finally {
      await browser.close();
    }
  });
}
