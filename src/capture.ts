import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { currentBranch, readConfig, resolveRef, AtlasError } from "./project.js";
import { snapshotPage } from "./snapshot.js";
import { readStates } from "./states.js";
import { saveCapture, type Entry } from "./store.js";

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

/** The window height for a width: a laptop screen for wide layouts, a phone screen for narrow ones. */
const heightFor = (width: number) => (width >= 768 ? 900 : 844);

/** Launches Playwright's own browser, or the Chrome already on this computer when Playwright's is not installed. */
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw new AtlasError(
        `Atlas could not start a browser. Install Google Chrome, or run "npx playwright install chromium-headless-shell". (${(bundled as Error).message.split("\n")[0]})`
      );
    }
  }
}

/** True when the project has uncommitted changes outside .atlas/, so a capture shows more than its commit. */
function hasUncommitted(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--", ".", ":(exclude).atlas"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Captures one state at each width: a picture at twice the pixel density, and a self-contained HTML snapshot.
 * The agent has already prepared the state (seeded data, started the app, made a test session).
 */
export async function capture(root: string, input: CaptureInput): Promise<CaptureResult> {
  const config = readConfig(root);
  const { states } = readStates(root);
  const state = states.find((s) => s.id === input.state);
  if (!state) throw new AtlasError(`No valid recipe with id "${input.state}". Recipes: ${states.map((s) => s.id).join(", ") || "none"}. Call atlas_states to see recipes that need repair.`);
  const commit = resolveRef(root, "HEAD");
  if (!commit) throw new AtlasError("The project has no commit yet. Commit once, then capture.");
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    throw new AtlasError(`baseUrl "${input.baseUrl}" is not a web address, such as http://localhost:3000.`);
  }
  const at = { commit, branch: currentBranch(root) };
  const uncommitted = hasUncommitted(root);
  const widths = input.widths ?? state.widths ?? config.widths;
  const browser = await launch();
  const results: WidthResult[] = [];
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: heightFor(width) }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      try {
        // Set by host and path, not by URL: Playwright marks a cookie set by URL as secure only on https, which rejects
        // secure and __Host- session cookies on http://localhost, where browsers do allow them.
        if (input.cookies?.length) {
          await context.addCookies(input.cookies.map((c) => ({ ...c, domain: base.hostname, path: c.path ?? "/", secure: c.secure ?? (base.protocol === "https:" || c.name.startsWith("__Host-") || c.name.startsWith("__Secure-")) })));
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
        const shot = { fullPage: state.fullPage ?? false, animations: "disabled" as const, caret: "hide" as const };
        const png = await page.screenshot({ ...shot, type: "png" });
        const preview = await page.screenshot({ ...shot, type: "jpeg", quality: 70, scale: "css" });
        const html = await page.evaluate(snapshotPage);
        const landed = new URL(page.url());
        const entry = {
          hash: createHash("sha256").update(png).digest("hex"),
          route: state.route,
          ...(landed.pathname + landed.search !== target.pathname + target.search ? { landedOn: landed.pathname + landed.search } : {}),
          status: response?.status() ?? 0,
          capturedAt: new Date().toISOString(),
          uncommitted
        };
        const previous = saveCapture(root, at, state.id, width, { png, html }, entry);
        const saved: Entry = { png: `.atlas/store/${commit}/${state.id}/${width}.png`, html: `.atlas/store/${commit}/${state.id}/${width}.html`, ...entry };
        results.push({ width, entry: saved, changed: previous?.hash !== entry.hash, preview });
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    if (error instanceof AtlasError) throw error;
    throw new AtlasError(`Capturing "${state.id}" failed: ${(error as Error).message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
  return { state: state.id, commit, branch: at.branch, uncommitted, widths: results };
}
