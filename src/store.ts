import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LayoutItem } from "./text-map.js";

/** One capture of one state at one width. Paths are relative to the project's root folder. */
const EntrySchema = z.object({
  png: z.string(),
  html: z.string(),
  /** The page's visible elements and their boxes, for naming and outlining what changed. Captures made before Atlas recorded it have none. */
  layout: z.string().optional(),
  hash: z.string(),
  route: z.string(),
  /** Where the page ended up, when the app redirected away from the recipe's route. */
  landedOn: z.string().optional(),
  status: z.number().int(),
  capturedAt: z.string(),
  /** True when the project had uncommitted changes outside .atlas/, so the capture shows more than the commit. */
  uncommitted: z.boolean()
});
export type Entry = z.infer<typeof EntrySchema>;

const ManifestSchema = z.object({
  commit: z.string(),
  branch: z.string().nullable(),
  states: z.record(z.string(), z.record(z.string(), EntrySchema))
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const storeDir = (root: string, commit: string) => join(root, ".atlas", "store", commit);

export function readManifest(root: string, commit: string): Manifest | null {
  const file = join(storeDir(root, commit), "manifest.json");
  if (!existsSync(file)) return null;
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}

/** Saves one width of one state and records it in the commit's manifest. Returns the entry it replaced, if any. */
export function saveCapture(
  root: string,
  at: { commit: string; branch: string | null },
  state: string,
  width: number,
  files: { png: Buffer; html: string; layout: LayoutItem[] },
  entry: Omit<Entry, "png" | "html" | "layout">
): Entry | null {
  const png = join(".atlas", "store", at.commit, state, `${width}.png`);
  const html = join(".atlas", "store", at.commit, state, `${width}.html`);
  const layout = join(".atlas", "store", at.commit, state, `${width}.layout.json`);
  mkdirSync(dirname(join(root, png)), { recursive: true });
  writeFileSync(join(root, png), files.png);
  writeFileSync(join(root, html), files.html);
  writeFileSync(join(root, layout), JSON.stringify(files.layout));
  const manifest = readManifest(root, at.commit) ?? { commit: at.commit, branch: at.branch, states: {} };
  const byWidth = (manifest.states[state] ??= {});
  const previous = byWidth[String(width)] ?? null;
  byWidth[String(width)] = { png, html, layout, ...entry };
  writeFileSync(join(storeDir(root, at.commit), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return previous;
}
