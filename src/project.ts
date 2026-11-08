import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** The project's Atlas settings, kept in `.atlas/config.json`. */
export const ConfigSchema = z.object({
  name: z.string().min(1),
  /** The git ref the project deploys from. Atlas resolves it on every run and never stores a commit. */
  liveRef: z.string().min(1).default("origin/main"),
  /** The live site's address, for opening a screen on live. */
  liveUrl: z.url().optional(),
  /** Screen widths to capture, in CSS pixels. */
  widths: z.array(z.number().int().positive()).min(1).default([1440, 390]),
  /** CSS selectors removed before every capture, such as a development overlay. */
  hide: z.array(z.string().min(1)).default([]),
  /** A fixed time for the page's clock during capture, so relative dates such as "3 days ago" stay the same between runs. Seed data relative to it. */
  time: z.iso.datetime({ offset: true }).optional()
});
export type Config = z.infer<typeof ConfigSchema>;
/** The settings as written in the file, where fields with defaults may be left out. */
export type ConfigFile = z.input<typeof ConfigSchema>;

export class AtlasError extends Error {}

/** The folder that holds `.atlas/config.json`: the given folder or the nearest one above it. */
export function findRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".atlas", "config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new AtlasError(`No .atlas/config.json in ${resolve(from)} or above it. Run "atlas init" in the project's root folder.`);
    dir = up;
  }
}

export function readConfig(root: string): Config {
  const file = join(root, ".atlas", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new AtlasError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasError(`${file} is not valid: ${z.prettifyError(parsed.error)}`);
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
