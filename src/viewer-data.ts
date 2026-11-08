import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { compareEntries, type Comparison } from "./compare.js";
import { connectInfo } from "./connect.js";
import { overview } from "./overview.js";
import { AtlasError, readConfig } from "./project.js";
import type { Agent } from "./serve.js";
import { readManifest, type Manifest } from "./store.js";
import { beforeOf, readTasks } from "./tasks.js";

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
  // Compare with live only when the shown captures are not live's own, and live has captures.
  const liveManifest = view.live.commit && manifest && manifest.commit !== view.live.commit ? readManifest(root, view.live.commit) : null;
  const picture = (png: string, width: string) => {
    const size = pngSize(join(root, png));
    const scale = size ? size.width / Number(width) : 2;
    return { png: "/" + png.replace(/^\.atlas\//, ""), height: size ? Math.round(size.height / scale) : Number(width) >= 768 ? 900 : 844 };
  };
  type Shot = ReturnType<typeof picture> & { layout?: string; landedOn?: string; uncommitted: boolean; capturedAt: string; live?: ReturnType<typeof picture>; compare?: Comparison };
  const shots: Record<string, Record<string, Shot>> = {};
  for (const [state, byWidth] of Object.entries(manifest?.states ?? {})) {
    for (const [width, entry] of Object.entries(byWidth)) {
      if (!existsSync(join(root, entry.png))) continue;
      const layout = entry.layout && existsSync(join(root, entry.layout)) ? { layout: "/" + entry.layout.replace(/^\.atlas\//, "") } : {};
      const shot: Shot = { ...picture(entry.png, width), ...layout, ...(entry.landedOn ? { landedOn: entry.landedOn } : {}), uncommitted: entry.uncommitted, capturedAt: entry.capturedAt };
      if (liveManifest) {
        const live = liveManifest.states[state]?.[width];
        const usable = live && existsSync(join(root, live.png)) ? live : undefined;
        try {
          shot.compare = compareEntries(root, Number(width), usable, entry);
          if (usable) shot.live = picture(usable.png, width);
        } catch (error) {
          // A pair that cannot be compared, such as pictures of different widths, shows without a comparison.
          if (!(error instanceof AtlasError)) throw error;
        }
      }
      (shots[state] ??= {})[width] = shot;
    }
  }
  return {
    project: { name: config.name, liveUrl: config.liveUrl ?? null },
    widths: config.widths,
    live: view.live,
    branch: view.branch,
    shown: manifest ? { commit: manifest.commit, behind: commitsBehind(root, manifest.commit) } : null,
    /** True when live has captures to compare with. */
    compared: liveManifest !== null,
    states: view.states,
    invalid: view.invalid,
    shots,
    tasks: readTasks(root).tasks.map((t) => {
      const before = beforeOf(root, t);
      return {
        ...t,
        before: before && existsSync(join(root, before.png)) ? "/" + before.png.replace(/^\.atlas\//, "") : null,
        after: t.after && existsSync(join(root, t.after.png)) ? { ...t.after, png: "/" + t.after.png.replace(/^\.atlas\//, "") } : null
      };
    }),
    connect: connectInfo(`http://localhost:${port}/mcp`),
    agents
  };
}
