import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** The project's Flowmap settings, kept in `.flowmap/config.json`. */
export const ConfigSchema = z.object({
  name: z.string().min(1),
  /** The git ref the project deploys from. Flowmap resolves it on every run and never stores a commit. */
  liveRef: z.string().min(1).default("origin/main"),
  /** The live site's address, for opening a screen on live. */
  liveUrl: z.url().optional(),
  /** Screen widths to capture, in CSS pixels. */
  widths: z.array(z.number().int().positive()).min(1).default([1440, 390]),
  /** CSS selectors removed before every capture, such as a development overlay. */
  hide: z.array(z.string().min(1)).default([]),
  /** Files a tool rewrites when the app starts, such as AGENTS.md under next dev. Their uncommitted changes do not mark captures as uncommitted. */
  ignoreChanges: z.array(z.string().min(1)).default([]),
  /** A fixed time for the browser's clock during capture. Dates the server works out follow the server's clock instead, so seed those relative to the current time. */
  time: z.iso.datetime({ offset: true }).optional()
});
export type Config = z.infer<typeof ConfigSchema>;
/** The settings as written in the file, where fields with defaults may be left out. */
export type ConfigFile = z.input<typeof ConfigSchema>;

export class FlowmapError extends Error {}

/** The folder that holds `.flowmap/config.json`: the given folder or the nearest one above it. */
export function findRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".flowmap", "config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new FlowmapError(`No .flowmap/config.json in ${resolve(from)} or above it. Run "flowmap init" in the project's root folder.`);
    dir = up;
  }
}

export function readConfig(root: string): Config {
  const file = join(root, ".flowmap", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new FlowmapError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new FlowmapError(`${file} is not valid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Resolves a git ref to its short commit in the project, or null when the ref does not exist there. */
export function resolveRef(root: string, ref: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short=8", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function currentBranch(root: string): string | null {
  try {
    const name = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}
