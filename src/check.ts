import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseOf, hasUncommitted, launch, shoot, type CookieInput } from "./capture.js";
import { compareEntries, type Area } from "./compare.js";
import { AtlasError, readConfig, resolveRef } from "./project.js";
import { readStates } from "./states.js";
import { readManifest, type Entry, type Manifest } from "./store.js";

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
  head: { commit: string; uncommitted: boolean };
  widths: CheckedWidth[];
}

/** Where a check keeps its own captures, so they never replace a commit's captures. */
const checkDir = (root: string) => join(root, ".atlas", "store", "check");

function clean(manifest: Manifest | null): boolean {
  return !!manifest && Object.values(manifest.states).every((byWidth) => Object.values(byWidth).every((e) => !e.uncommitted));
}

/** The captures to compare with: this commit's when the change is still uncommitted and they show the commit alone, else the newest earlier commit with captures. */
function baseline(root: string, head: string, uncommitted: boolean, wanted?: string): Manifest | null {
  if (wanted) {
    const commit = resolveRef(root, wanted);
    if (!commit) throw new AtlasError(`"${wanted}" does not resolve to a commit.`);
    const m = readManifest(root, commit);
    if (!m) throw new AtlasError(`Nothing is captured at ${commit}. Capture the states there first, or leave out base.`);
    return m;
  }
  const own = readManifest(root, head);
  if (uncommitted && clean(own)) return own;
  let earlier: string[] = [];
  try {
    earlier = execFileSync("git", ["-C", root, "rev-list", "--max-count=500", "--abbrev=8", "--abbrev-commit", "HEAD~1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
  } catch {
    // A first commit has no parent: there is nothing earlier to compare with.
    earlier = [];
  }
  for (const commit of earlier) {
    const m = readManifest(root, commit);
    if (m) return m;
  }
  return null;
}

/**
 * Captures every state at the agent's current code and compares each width with its capture at the base, so the agent sees every
 * screen its change touched, including screens it did not mean to change, before it says it is done. The check's captures are kept
 * apart from the store and replace nothing.
 */
export async function check(root: string, input: CheckInput): Promise<CheckResult> {
  const config = readConfig(root);
  const { states } = readStates(root);
  if (!states.length) throw new AtlasError("There are no state recipes to check. Write recipes first.");
  const head = resolveRef(root, "HEAD");
  if (!head) throw new AtlasError("The project has no commit yet. Commit once, then check.");
  const base = baseOf(input.baseUrl);
  const uncommitted = hasUncommitted(root);
  const before = baseline(root, head, uncommitted, input.base);
  rmSync(checkDir(root), { recursive: true, force: true });
  const widths: CheckedWidth[] = [];
  const browser = await launch();
  try {
    for (const state of states) {
      const sizes = state.widths ?? config.widths;
      let shots;
      try {
        shots = await shoot(browser, root, state, base, input.cookies, sizes);
      } catch (error) {
        for (const width of sizes) widths.push({ state: state.id, name: state.name, width, status: "failed", areas: [], problem: error instanceof Error ? error.message : String(error) });
        continue;
      }
      for (const s of shots) {
        const dir = join(".atlas", "store", "check", state.id);
        mkdirSync(join(root, dir), { recursive: true });
        const layout = join(dir, `${s.width}.layout.json`);
        const now: Entry = {
          png: join(dir, `${s.width}.png`), html: join(dir, `${s.width}.html`), layout,
          hash: createHash("sha256").update(s.png).digest("hex"), route: s.route, ...(s.landedOn ? { landedOn: s.landedOn } : {}),
          status: s.status, capturedAt: s.capturedAt, uncommitted
        };
        writeFileSync(join(root, now.png), s.png);
        writeFileSync(join(root, now.html), s.html);
        writeFileSync(join(root, layout), JSON.stringify(s.layout));
        const was = before?.states[state.id]?.[String(s.width)];
        const problem = s.landedOn ? `The app opened ${s.landedOn} instead of ${s.route}. Check the session and the setup.` : s.status >= 400 ? `The page answered HTTP ${s.status}.` : undefined;
        if (problem) { widths.push({ state: state.id, name: state.name, width: s.width, status: "failed", areas: [], problem, now }); continue; }
        const result = compareEntries(root, s.width, was, now);
        widths.push({ state: state.id, name: state.name, width: s.width, status: result.status === "missing" ? "failed" : result.status, areas: result.areas, ...(was ? { before: was } : {}), now });
      }
    }
  } finally {
    await browser.close();
  }
  return { base: before ? { commit: before.commit } : null, head: { commit: head, uncommitted }, widths };
}

