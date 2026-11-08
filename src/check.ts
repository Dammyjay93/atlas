import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseOf, bySetup, launch, oneAtATime, shoot, uncommittedFiles, type CookieInput } from "./capture.js";
import { compareEntries, type Area } from "./compare.js";
import { currentBranch, FlowmapError, readConfig, resolveRef } from "./project.js";
import { readStates } from "./states.js";
import { readManifest, saveCapture, type Entry, type Manifest } from "./store.js";

export interface CheckInput {
  /** Where the agent started the app with its change, such as http://localhost:3000. */
  baseUrl: string;
  cookies?: CookieInput[];
  /** The commit to compare with. By default: this commit's captures when the change is not committed yet, else the newest earlier commit with captures. */
  base?: string;
}

export interface CheckedWidth {
  state: string;
  name: string;
  width: number;
  /** same, changed, new (no capture at the base), failed (it could not be captured now). */
  status: "same" | "changed" | "new" | "failed";
  areas: Area[];
  problem?: string;
  /** The capture at the base, and the one made for this check. */
  before?: Entry;
  now?: Entry;
}

export interface CheckResult {
  base: { commit: string } | null;
  /** `changes` lists the files with uncommitted changes. */
  head: { commit: string; uncommitted: boolean; changes: string[] };
  widths: CheckedWidth[];
}

/** Where a check keeps the captures of uncommitted code, so they never replace a commit's captures. */
const checkDir = (root: string) => join(root, ".flowmap", "store", "check");

function clean(manifest: Manifest | null): boolean {
  return !!manifest && Object.values(manifest.states).every((byWidth) => Object.values(byWidth).every((e) => !e.uncommitted));
}

/**
 * The captures to compare with, newest first: this commit's when the change is still uncommitted and they show the commit alone,
 * then earlier commits'. Each screen is compared with the first of them that has it, so a commit that captured only some screens
 * does not make the others look new.
 */
function baseline(root: string, head: string, uncommitted: boolean, wanted?: string): Manifest[] {
  if (wanted) {
    const commit = resolveRef(root, wanted);
    if (!commit) throw new FlowmapError(`"${wanted}" does not resolve to a commit.`);
    const m = readManifest(root, commit);
    if (!m) throw new FlowmapError(`Nothing is captured at ${commit}. Capture the states there first, or leave out base.`);
    return [m];
  }
  const own = readManifest(root, head);
  let earlier: string[] = [];
  try {
    earlier = execFileSync("git", ["-C", root, "rev-list", "--max-count=500", "--abbrev=8", "--abbrev-commit", "HEAD~1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
  } catch {
    // A first commit has no parent: there is nothing earlier to compare with.
    earlier = [];
  }
  const found = earlier.map((commit) => readManifest(root, commit)).filter((m): m is Manifest => m !== null);
  return uncommitted && clean(own) && own ? [own, ...found] : found;
}

/**
 * Captures every state at the agent's current code and compares each width with its capture at the base, so the agent sees every
 * screen its change touched, including screens it did not mean to change, before it says it is done. On committed code, the
 * captures are filed under the commit, so the map shows every screen at it; on uncommitted code they are kept apart and replace nothing.
 */
export function check(root: string, input: CheckInput): Promise<CheckResult> {
  return oneAtATime(() => checkNow(root, input));
}

async function checkNow(root: string, input: CheckInput): Promise<CheckResult> {
  const config = readConfig(root);
  const { states } = readStates(root);
  if (!states.length) throw new FlowmapError("There are no state recipes to check. Write recipes first.");
  const head = resolveRef(root, "HEAD");
  if (!head) throw new FlowmapError("The project has no commit yet. Commit once, then check.");
  const base = baseOf(input.baseUrl);
  const changes = uncommittedFiles(root);
  const uncommitted = changes.length > 0;
  const before = baseline(root, head, uncommitted, input.base);
  rmSync(checkDir(root), { recursive: true, force: true });
  const browser = await launch();
  let widths: CheckedWidth[];
  try {
    // One setup at a time, and the states of each setup several at a time, each with all its widths; the results keep the recipes' order.
    const perState = await bySetup(root, states, base, async (state, session) => {
      const widths: CheckedWidth[] = [];
      const sizes = state.widths ?? config.widths;
      let shots;
      try {
        shots = await shoot(browser, root, state, base, [...(input.cookies ?? []), ...session], sizes);
      } catch (error) {
        for (const width of sizes) widths.push({ state: state.id, name: state.name, width, status: "failed", areas: [], problem: error instanceof Error ? error.message : String(error) });
        return widths;
      }
      for (const s of shots) {
        const problem = s.landedOn ? `The app opened ${s.landedOn} instead of ${s.route}. Check the session and the setup.` : s.status >= 400 ? `The page answered HTTP ${s.status}.` : undefined;
        const facts = { hash: createHash("sha256").update(s.png).digest("hex"), route: s.route, ...(s.landedOn ? { landedOn: s.landedOn } : {}), status: s.status, capturedAt: s.capturedAt, uncommitted };
        const files = { png: s.png, html: s.html, layout: s.layout };
        let now: Entry;
        if (!uncommitted && !problem) {
          // Committed code shows exactly the commit, so its pictures are the commit's captures: the map stays complete.
          saveCapture(root, { commit: head, branch: currentBranch(root) }, state.id, s.width, files, facts);
          const dir = join(".flowmap", "store", head, state.id);
          now = { png: join(dir, `${s.width}.png`), html: join(dir, `${s.width}.html`), layout: join(dir, `${s.width}.layout.json`), ...facts };
        } else {
          const dir = join(".flowmap", "store", "check", state.id);
          mkdirSync(join(root, dir), { recursive: true });
          now = { png: join(dir, `${s.width}.png`), html: join(dir, `${s.width}.html`), layout: join(dir, `${s.width}.layout.json`), ...facts };
          writeFileSync(join(root, now.png), s.png);
          writeFileSync(join(root, now.html), s.html);
          writeFileSync(join(root, now.layout ?? ""), JSON.stringify(s.layout));
        }
        const was = before.map((m) => m.states[state.id]?.[String(s.width)]).find(Boolean);
        if (problem) { widths.push({ state: state.id, name: state.name, width: s.width, status: "failed", areas: [], problem, now }); continue; }
        const result = compareEntries(root, s.width, was, now);
        widths.push({ state: state.id, name: state.name, width: s.width, status: result.status === "missing" ? "failed" : result.status, areas: result.areas, ...(was ? { before: was } : {}), now });
      }
      return widths;
    });
    widths = perState.flat();
  } finally {
    await browser.close();
  }
  return { base: before[0] ? { commit: before[0].commit } : null, head: { commit: head, uncommitted, changes }, widths };
}

