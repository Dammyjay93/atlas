import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { connectInfo } from "./connect.js";
import { overview } from "./overview.js";
import { readConfig } from "./project.js";
import type { Agent } from "./serve.js";
import { readManifest, type Manifest } from "./store.js";

/** The size of a PNG in pixels, read from its header. */
function pngSize(file: string): { width: number; height: number } | null {
  const buffer = Buffer.alloc(24);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("ascii", 12, 16) === "IHDR" ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } : null;
}

/** The captures to show: HEAD's when they exist, otherwise those of the most recent commit with captures. */
function newestManifest(root: string, head: string | null): Manifest | null {
  if (head) {
    const own = readManifest(root, head);
    if (own) return own;
  }
  const dir = join(root, ".atlas", "store");
  if (!existsSync(dir)) return null;
  let best: { manifest: Manifest; at: string } | null = null;
  for (const commit of readdirSync(dir)) {
    const manifest = readManifest(root, commit);
    if (!manifest) continue;
    const at = Object.values(manifest.states).flatMap((byWidth) => Object.values(byWidth).map((e) => e.capturedAt)).sort().at(-1) ?? "";
    if (!best || at > best.at) best = { manifest, at };
  }
  return best?.manifest ?? null;
}

/** How many commits HEAD is ahead of the shown captures, or null when they are not on HEAD's history. */
function commitsBehind(root: string, commit: string): number | null {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
    return Number(execFileSync("git", ["-C", root, "rev-list", "--count", `${commit}..HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return null;
  }
}

/** Everything the viewer draws, read fresh from the settings, recipes, git and the capture store. */
export function viewerData(root: string, port: number, agents: Agent[] = []) {
  const config = readConfig(root);
  const view = overview(root);
  const manifest = newestManifest(root, view.branch.commit);
  const shots: Record<string, Record<string, { png: string; height: number; landedOn?: string; uncommitted: boolean; capturedAt: string }>> = {};
  for (const [state, byWidth] of Object.entries(manifest?.states ?? {})) {
    for (const [width, entry] of Object.entries(byWidth)) {
      const file = join(root, entry.png);
      if (!existsSync(file)) continue;
      const size = pngSize(file);
      const scale = size ? size.width / Number(width) : 2;
      (shots[state] ??= {})[width] = {
        png: "/" + entry.png.replace(/^\.atlas\//, ""),
        height: size ? Math.round(size.height / scale) : Number(width) >= 768 ? 900 : 844,
        ...(entry.landedOn ? { landedOn: entry.landedOn } : {}),
        uncommitted: entry.uncommitted,
        capturedAt: entry.capturedAt
      };
    }
  }
  return {
    project: { name: config.name, liveUrl: config.liveUrl ?? null },
    widths: config.widths,
    live: view.live,
    branch: view.branch,
    shown: manifest ? { commit: manifest.commit, behind: commitsBehind(root, manifest.commit) } : null,
    states: view.states,
    invalid: view.invalid,
    shots,
    connect: connectInfo(`http://localhost:${port}/mcp`),
    agents
  };
}
