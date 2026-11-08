import { execFileSync } from "node:child_process";
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

/** True when the project has uncommitted changes outside .flowmap/, so a capture shows more than its commit. */
export function hasUncommitted(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--", ".", ":(exclude).flowmap"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
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
export async function inParallel<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
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
export const AT_ONCE = 4;

/**
 * Captures one state at each width and files it in the store under the current commit, or live's commit with `live`.
 * The agent has already prepared the state (seeded data, started the app, made a test session).
 */
export async function capture(root: string, input: CaptureInput, shared?: Browser): Promise<CaptureResult> {
  const config = readConfig(root);
  const { states } = readStates(root);
  const state = states.find((s) => s.id === input.state);
  if (!state) throw new FlowmapError(`No valid recipe with id "${input.state}". Recipes: ${states.map((s) => s.id).join(", ") || "none"}. Call flowmap_states to see recipes that need repair.`);
  if (input.live && input.variant) throw new FlowmapError("A capture is either of live or of a version to choose from, not both.");
  const commit = input.live ? resolveRef(root, config.liveRef) : resolveRef(root, "HEAD");
  if (!commit) {
    throw new FlowmapError(input.live ? `Live's ref "${config.liveRef}" does not resolve to a commit. Fetch it, or set "liveRef" in .flowmap/config.json.` : "The project has no commit yet. Commit once, then capture.");
  }
  const base = baseOf(input.baseUrl);
  const at = { commit, branch: input.live ? config.liveRef : currentBranch(root) };
  const uncommitted = input.live ? false : hasUncommitted(root);
  const browser = shared ?? (await launch());
  let shots: Shot[];
  try {
    // A version is captured from its own address; the rest of the recipe (steps, widths) applies as it is.
    const shown = input.variant?.route ? { ...state, route: input.variant.route } : state;
    shots = await shoot(browser, root, shown, base, input.cookies, input.widths ?? state.widths ?? config.widths);
  } finally {
    if (!shared) await browser.close();
  }
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
  return { state: state.id, commit, branch: at.branch, uncommitted, widths: results };
}

/** Captures several states, or every state, in one browser, several at a time. */
export async function captureMany(root: string, input: Omit<CaptureInput, "state" | "variant" | "live"> & { states?: string[] }): Promise<CaptureResult[]> {
  const all = readStates(root).states.map((s) => s.id);
  const ids = input.states?.length ? input.states : all;
  const unknown = ids.filter((id) => !all.includes(id));
  if (unknown.length) throw new FlowmapError(`No valid recipe with id ${unknown.map((u) => `"${u}"`).join(", ")}. Recipes: ${all.join(", ") || "none"}.`);
  if (!ids.length) throw new FlowmapError("There are no state recipes to capture. Write recipes first.");
  const browser = await launch();
  try {
    return await inParallel(ids, AT_ONCE, (state) => capture(root, { ...input, state }, browser));
  } finally {
    await browser.close();
  }
}
