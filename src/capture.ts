import { exec, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { currentBranch, readConfig, resolveRef, FlowmapError } from "./project.js";
import { snapshotPage } from "./snapshot.js";
import { readStates, type State, type Step } from "./states.js";
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

/** What a session command printed: the cookies, and the items the app keeps in the browser's localStorage, such as a token. */
export interface Session {
  cookies: CookieInput[];
  localStorage: { name: string; value: string }[];
}

const NO_SESSION: Session = { cookies: [], localStorage: [] };

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
export async function shoot(browser: Browser, root: string, state: State, base: URL, session: Session, widths: number[]): Promise<Shot[]> {
  const config = readConfig(root);
  const { cookies } = session;
  // The app's own address gets the localStorage items before the page opens, as if the person had signed in there.
  const storageState = session.localStorage.length ? { storageState: { cookies: [], origins: [{ origin: base.origin, localStorage: session.localStorage }] } } : {};
  // Each width has its own window, so the widths are captured at the same time.
  const one = async (width: number): Promise<Shot> => {
      const context = await browser.newContext({ viewport: { width, height: heightFor(width) }, deviceScaleFactor: 2, reducedMotion: "reduce", ...storageState });
      try {
        // Set by host and path, not by URL: Playwright marks a cookie set by URL as secure only on https, which rejects
        // secure and __Host- session cookies on http://localhost, where browsers do allow them.
        if (cookies.length) {
          await context.addCookies(cookies.map((c) => ({ ...c, domain: base.hostname, path: c.path ?? "/", secure: c.secure ?? (base.protocol === "https:" || c.name.startsWith("__Host-") || c.name.startsWith("__Secure-")) })));
        }
        const page = await context.newPage();
        if (config.time) await page.clock.setFixedTime(new Date(config.time));
        const target = new URL(state.route, base);
        let response;
        try {
          response = await page.goto(target.href, { waitUntil: "networkidle", timeout: 60_000 });
        } catch (error) {
          throw new FlowmapError(`opening ${target.href} failed: ${(error as Error).message.split("\n")[0]}`);
        }
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        // Hidden before the steps run, including elements added later, so a development overlay never covers a control that a
        // step clicks. One rule for each selector, so a selector the browser cannot read leaves out only its own rule.
        const hiding = config.hide.length ? await page.addStyleTag({ content: config.hide.map((selector) => `${selector} { display: none !important; }`).join("\n") }) : null;
        // Where the app sent the browser when the page opened, such as a sign-in page. A recipe's steps may change the address
        // on purpose, such as a filter that writes its query, so only the path on opening counts.
        const opened = new URL(page.url());
        const steps = state.steps ?? [];
        for (const [at, step] of steps.entries()) {
          try {
            if ("click" in step) await page.click(step.click);
            else if ("fill" in step) await page.fill(step.fill, step.value);
            else if ("press" in step) await page.keyboard.press(step.press);
            else await page.waitForSelector(step.waitFor);
          } catch (error) {
            throw new FlowmapError(`step ${at + 1} of ${steps.length}, ${JSON.stringify(step)}, failed: ${await whyStepFailed(page, step, error as Error)}`);
          }
        }
        if (state.steps?.length) await page.waitForLoadState("networkidle");
        for (const selector of config.hide) await page.locator(selector).evaluateAll((els) => els.forEach((el) => el.remove()));
        // The elements are gone, so the stylesheet that hid them is not part of the page either.
        await hiding?.evaluate((style) => (style as Element).remove());
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
        return {
          width, png, preview, html, layout,
          route: state.route,
          ...(opened.pathname !== target.pathname ? { landedOn: opened.pathname + opened.search } : {}),
          status: response?.status() ?? 0,
          capturedAt: new Date().toISOString()
        };
      } finally {
        await context.close();
      }
  };
  // Every width runs to the end, so the problem names each width that failed, not only the first.
  const settled = await Promise.allSettled(widths.map(one));
  const problems = new Map<string, number[]>();
  settled.forEach((result, at) => {
    if (result.status === "fulfilled") return;
    const error = result.reason as Error;
    const problem = error instanceof FlowmapError ? error.message : error.message.split("\n")[0] ?? String(error);
    problems.set(problem, [...(problems.get(problem) ?? []), widths[at] as number]);
  });
  if (!problems.size) return settled.map((result) => (result as PromiseFulfilledResult<Shot>).value);
  const list = [...problems].map(([problem, at]) => `At ${at.join(" and ")} px, ${problem}`);
  throw new FlowmapError(`Capturing "${state.id}" failed. ${list.join(" ")}`);
}

/** Why a step failed, in words an agent can act on: no element matches, none is visible, or another element covers it. */
async function whyStepFailed(page: Page, step: Step, error: Error): Promise<string> {
  const first = error.message.split("\n")[0] ?? "";
  if ("press" in step) return first;
  const selector = "click" in step ? step.click : "fill" in step ? step.fill : step.waitFor;
  let found: { all: number; visible: number };
  try {
    found = await page.locator(selector).evaluateAll((els) => ({
      all: els.length,
      visible: els.filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden").length
    }));
  } catch (invalid) {
    return `"${selector}" is not a selector Flowmap can read: ${(invalid as Error).message.split("\n")[0]}`;
  }
  if (!found.all) return `no element matches "${selector}".`;
  if (!found.visible) return `${found.all} ${found.all === 1 ? "element matches" : "elements match"} "${selector}", but none is visible.`;
  const cover = /(<[^\n]*?>)[^\n]*intercepts pointer events/.exec(error.message)?.[1];
  if (cover) return `another element covers "${selector}": ${cover.slice(0, 160)}. If that element is not part of the product, such as a development overlay, add a selector for it to "hide" in .flowmap/config.json.`;
  return first;
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
 * What a session command printed, one item on each line:
 * - name=value is a cookie, such as sid=abc123. Cookie attributes after a semicolon, as in a Set-Cookie header, are ignored.
 * - localStorage:name=value is an item the app keeps in the browser's localStorage, such as a sign-in token. The value runs to
 *   the end of the line, so it can be JSON on one line.
 * Blank lines are skipped.
 */
export function parseSession(output: string, command: string): Session {
  const session: Session = { cookies: [], localStorage: [] };
  const format = "one cookie on each line as name=value, or a localStorage item as localStorage:name=value";
  for (const line of output.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const stored = line.startsWith("localStorage:");
    const pair = stored ? line.slice("localStorage:".length) : (line.split(";")[0] ?? "").trim(), at = pair.indexOf("=");
    if (at < 1) throw new FlowmapError(`The session command must print ${format}, but printed "${line.slice(0, 80)}": ${command}`);
    const item = { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
    if (stored) session.localStorage.push(item);
    else session.cookies.push(item);
  }
  if (!session.cookies.length && !session.localStorage.length) throw new FlowmapError(`The session command printed nothing. It must print ${format}: ${command}`);
  return session;
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
 * what their session printed. When a group's setup or a session command fails, `failed` gives the result for each state it
 * left unprepared, and the other groups go on. Results keep the states' order.
 */
export async function bySetup<R>(root: string, states: State[], base: URL, run: (state: State, session: Session) => Promise<R>, failed: (state: State, problem: string) => R): Promise<R[]> {
  const groups = new Map<string, State[]>();
  for (const state of states) groups.set(state.setup ?? "", [...(groups.get(state.setup ?? "") ?? []), state]);
  const results = new Map<string, R>();
  const names = (group: State[]) => group.map((s) => `"${s.id}"`).join(", ");
  /** The command's output, or its failure as a FlowmapError, which leaves the group's states unprepared. */
  const attempt = async (command: string, what: string): Promise<string | FlowmapError> => {
    try {
      return await runCommand(root, command, what, base);
    } catch (error) {
      if (error instanceof FlowmapError) return error;
      throw error;
    }
  };
  for (const [setup, group] of groups) {
    const setupFailed = setup ? await attempt(setup, `setup of ${names(group)}`) : "";
    const sessions = new Map<string, Session | FlowmapError>();
    if (!(setupFailed instanceof FlowmapError)) {
      for (const command of new Set(group.flatMap((s) => (s.session ? [s.session] : [])))) {
        const output = await attempt(command, `session command of ${names(group.filter((s) => s.session === command))}`);
        try {
          sessions.set(command, output instanceof FlowmapError ? output : parseSession(output, command));
        } catch (error) {
          if (!(error instanceof FlowmapError)) throw error;
          sessions.set(command, error);
        }
      }
    }
    const done = await inParallel(group, AT_ONCE, async (state) => {
      const session = setupFailed instanceof FlowmapError ? setupFailed : state.session ? sessions.get(state.session) ?? NO_SESSION : NO_SESSION;
      return session instanceof FlowmapError ? failed(state, session.message) : run(state, session);
    });
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
      const [result] = await bySetup(root, [state], base, (s, session) => captureState(root, input, s, session, browser), (_, problem) => {
        throw new FlowmapError(problem);
      });
      return result as CaptureResult;
    } finally {
      await browser.close();
    }
  });
}

/** Captures a state that is already prepared, in an open browser, with what its session printed, and files it. */
async function captureState(root: string, input: CaptureInput, state: State, session: Session, browser: Browser): Promise<CaptureResult> {
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
  const shots = await shoot(browser, root, shown, base, { ...session, cookies: [...(input.cookies ?? []), ...session.cookies] }, input.widths ?? state.widths ?? config.widths);
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

/** A state that could not be captured in a run of several, and why. */
export interface FailedCapture {
  state: string;
  problem: string;
}

/**
 * Captures several states, or every state, in one browser: one setup at a time, and the states of each setup several at a time.
 * A state that fails, or whose setup or session fails, is reported with its problem, and the others are still captured.
 */
export function captureMany(root: string, input: Omit<CaptureInput, "state" | "variant" | "live"> & { states?: string[] }): Promise<(CaptureResult | FailedCapture)[]> {
  return oneAtATime(async () => {
    const all = readStates(root).states;
    const ids = input.states?.length ? input.states : all.map((s) => s.id);
    const unknown = ids.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new FlowmapError(`No valid recipe with id ${unknown.map((u) => `"${u}"`).join(", ")}. Recipes: ${all.map((s) => s.id).join(", ") || "none"}.`);
    if (!ids.length) throw new FlowmapError("There are no state recipes to capture. Write recipes first.");
    const base = baseOf(input.baseUrl);
    const browser = await launch();
    try {
      return await bySetup<CaptureResult | FailedCapture>(
        root,
        all.filter((s) => ids.includes(s.id)),
        base,
        async (state, session) => {
          try {
            return await captureState(root, { ...input, state: state.id }, state, session, browser);
          } catch (error) {
            if (error instanceof FlowmapError) return { state: state.id, problem: error.message };
            throw error;
          }
        },
        (state, problem) => ({ state: state.id, problem })
      );
    } finally {
      await browser.close();
    }
  });
}
