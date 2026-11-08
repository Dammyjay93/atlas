import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LayoutItem } from "./text-map.js";

/**
 * A version of a screen an agent built for the person to choose from. The versions of a set live side by side in the one working
 * copy, behind a switch such as ?version=b, so each is captured from its own address.
 */
export const VariantSchema = z.strictObject({
  /** The set the versions belong to, such as "job-card". */
  set: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  /** This version's name within the set, such as "a" or "compact". */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  /** What makes this version different, in a sentence. */
  note: z.string().min(1).max(200),
  /** The address that shows this version, such as /checkout?version=b. Without it, the state's own route. */
  route: z.string().startsWith("/").optional()
});
export type Variant = z.infer<typeof VariantSchema>;

const OptionSchema = z.object({
  name: z.string(),
  note: z.string(),
  route: z.string().optional(),
  commit: z.string(),
  capturedAt: z.string(),
  /** Set while an agent builds this version of a state, so the viewer shows the frame being built. */
  building: z.object({ state: z.string(), startedAt: z.string() }).optional(),
  /** Per state and width: the files of the capture, relative to the project's root folder. */
  shots: z.record(z.string(), z.record(z.string(), z.object({ png: z.string(), html: z.string(), layout: z.string() })))
});
const SetSchema = z.object({ set: z.string(), options: z.array(OptionSchema) });
export type VariantSet = z.infer<typeof SetSchema>;

const setsDir = (root: string) => join(root, ".atlas", "store", "variants");
const setFile = (root: string, set: string) => join(setsDir(root), set, "set.json");

export function readVariantSets(root: string): VariantSet[] {
  if (!existsSync(setsDir(root))) return [];
  const sets: VariantSet[] = [];
  for (const name of readdirSync(setsDir(root))) {
    if (!existsSync(setFile(root, name))) continue;
    const parsed = SetSchema.safeParse(JSON.parse(readFileSync(setFile(root, name), "utf8")));
    if (parsed.success) sets.push(parsed.data);
  }
  return sets.sort((a, b) => a.set.localeCompare(b.set));
}

const readSet = (root: string, set: string): VariantSet =>
  existsSync(setFile(root, set)) ? SetSchema.parse(JSON.parse(readFileSync(setFile(root, set), "utf8"))) : { set, options: [] };
const writeSet = (root: string, current: VariantSet) => {
  current.options.sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(join(setsDir(root), current.set), { recursive: true });
  writeFileSync(setFile(root, current.set), JSON.stringify(current, null, 2) + "\n");
};

/** Marks a version of a state as being built, or as built. A version marked before its first capture is listed with no pictures. */
export function markBuilding(root: string, variant: Variant, commit: string, state: string, building: boolean): void {
  const current = readSet(root, variant.set);
  let option = current.options.find((o) => o.name === variant.name);
  if (!option) {
    if (!building) return;
    option = { name: variant.name, note: variant.note, commit, capturedAt: "", shots: {} };
    current.options.push(option);
  }
  if (building) Object.assign(option, { note: variant.note, building: { state, startedAt: new Date().toISOString() } }, variant.route ? { route: variant.route } : {});
  else if (option.building?.state === state) delete option.building;
  else return;
  writeSet(root, current);
}

/** Files one width of one state of one version, and records the version in its set. */
export function saveVariant(
  root: string,
  variant: Variant,
  commit: string,
  state: string,
  width: number,
  files: { png: Buffer; html: string; layout: LayoutItem[] },
  capturedAt: string
): { png: string; html: string; layout: string } {
  const dir = join(".atlas", "store", "variants", variant.set, variant.name, state);
  mkdirSync(join(root, dir), { recursive: true });
  const paths = { png: join(dir, `${width}.png`), html: join(dir, `${width}.html`), layout: join(dir, `${width}.layout.json`) };
  writeFileSync(join(root, paths.png), files.png);
  writeFileSync(join(root, paths.html), files.html);
  writeFileSync(join(root, paths.layout), JSON.stringify(files.layout));
  const current = readSet(root, variant.set);
  let option = current.options.find((o) => o.name === variant.name);
  if (!option) {
    option = { name: variant.name, note: variant.note, commit, capturedAt, shots: {} };
    current.options.push(option);
  }
  Object.assign(option, { note: variant.note, commit, capturedAt }, variant.route ? { route: variant.route } : {});
  (option.shots[state] ??= {})[String(width)] = paths;
  writeSet(root, current);
  return paths;
}
