import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { AtlasError, resolveRef } from "./project.js";
import { readStates } from "./states.js";
import { readManifest, type Entry } from "./store.js";
import type { LayoutItem } from "./text-map.js";
import { readVariantSets } from "./variants.js";

/**
 * A task moves: open → in-progress → ready-for-review → approved, or → sent-back and round again.
 * The agent sets in-progress and ready-for-review; the person approves or sends back.
 */
export const STATUSES = ["open", "in-progress", "ready-for-review", "approved", "sent-back"] as const;
export type Status = (typeof STATUSES)[number];

const BoxSchema = z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().positive(), h: z.number().int().positive() });
export type Box = z.infer<typeof BoxSchema>;

const FrontSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  state: z.string().min(1),
  width: z.number().int().positive(),
  /** The commit of the picture the person marked. */
  commit: z.string().min(1),
  status: z.enum(STATUSES),
  /** The box the person drew, in CSS pixels on that picture. No box means the whole screen. */
  area: BoxSchema.optional(),
  /** The element under the box, from the capture's element list. */
  element: z.strictObject({ tag: z.string(), text: z.string(), box: BoxSchema }).optional(),
  /** For a choice between versions: the set, the version kept, and its branch. */
  choice: z.strictObject({ set: z.string(), name: z.string(), others: z.array(z.string()) }).optional(),
  /** For a comment on a version: the set and the version it was marked on. */
  variant: z.strictObject({ set: z.string(), name: z.string() }).optional(),
  /** The capture the agent made when it finished. */
  after: z.strictObject({ commit: z.string(), png: z.string(), capturedAt: z.string() }).optional(),
  created: z.string(),
  log: z.array(z.strictObject({ at: z.string(), by: z.enum(["person", "agent"]), status: z.enum(STATUSES), note: z.string().optional() }))
});
export type Task = z.infer<typeof FrontSchema> & { words: string };

const dir = (root: string) => join(root, ".atlas", "tasks");
const fileOf = (root: string, id: string) => join(dir(root), `${id}.md`);

function write(root: string, task: Task): void {
  const { words, ...front } = task;
  writeFileSync(fileOf(root, task.id), `---\n${stringify(front)}---\n\n${words.trim()}\n`);
}

function parseTask(text: string): Task {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("it has no front matter between --- lines");
  const front = FrontSchema.safeParse(parse(match[1] ?? ""));
  if (!front.success) throw new Error(front.error.issues.map((i) => `${i.path.join(".") || "front matter"}: ${i.message}`).join("; "));
  return { ...front.data, words: (match[2] ?? "").trim() };
}

/** Every task in .atlas/tasks, newest first, and the files that could not be read. */
export function readTasks(root: string): { tasks: Task[]; invalid: { file: string; problem: string }[] } {
  const tasks: Task[] = [];
  const invalid: { file: string; problem: string }[] = [];
  if (!existsSync(dir(root))) return { tasks, invalid };
  for (const file of readdirSync(dir(root)).filter((f) => f.endsWith(".md"))) {
    try {
      tasks.push(parseTask(readFileSync(join(dir(root), file), "utf8")));
    } catch (error) {
      invalid.push({ file: `.atlas/tasks/${file}`, problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return { tasks: tasks.sort((a, b) => b.created.localeCompare(a.created)), invalid };
}

export function readTask(root: string, id: string): Task {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !existsSync(fileOf(root, id))) throw new AtlasError(`No task with id "${id}". Call atlas_tasks to see the tasks.`);
  try {
    return parseTask(readFileSync(fileOf(root, id), "utf8"));
  } catch (error) {
    throw new AtlasError(`.atlas/tasks/${id}.md cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A version's capture of one state at one width, as an entry. */
function versionEntry(root: string, set: string, name: string, state: string, width: number): Entry | undefined {
  const option = readVariantSets(root).find((v) => v.set === set)?.options.find((o) => o.name === name);
  const files = option?.shots[state]?.[String(width)];
  return option && files ? { ...files, hash: "", route: option.route ?? "", status: 200, capturedAt: option.capturedAt, uncommitted: false } : undefined;
}

/** The capture a task was marked on: a version's, or the state's at the task's commit. */
export function beforeOf(root: string, task: Task): Entry | undefined {
  const version = task.variant ?? (task.choice ? { set: task.choice.set, name: task.choice.name } : undefined);
  if (version) return versionEntry(root, version.set, version.name, task.state, task.width);
  return readManifest(root, task.commit)?.states[task.state]?.[String(task.width)];
}

/** The element the person marked: the smallest element that holds the box's centre, or else the one the box covers most. */
function elementUnder(root: string, entry: Entry, area: Box): Task["element"] {
  if (!entry.layout || !existsSync(join(root, entry.layout))) return undefined;
  const items = (JSON.parse(readFileSync(join(root, entry.layout), "utf8")) as LayoutItem[]).filter((t) => !t.surface);
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const holding = items.filter((t) => cx >= t.x && cx <= t.x + t.w && cy >= t.y && cy <= t.y + t.h).sort((a, b) => a.w * a.h - b.w * b.h);
  const overlap = (t: LayoutItem) => Math.max(0, Math.min(t.x + t.w, area.x + area.w) - Math.max(t.x, area.x)) * Math.max(0, Math.min(t.y + t.h, area.y + area.h) - Math.max(t.y, area.y));
  const best = holding[0] ?? items.filter((t) => overlap(t) > 0).sort((a, b) => overlap(b) - overlap(a))[0];
  return best ? { tag: best.tag, text: best.text, box: { x: best.x, y: best.y, w: best.w, h: best.h } } : undefined;
}

export const CreateSchema = z.strictObject({
  state: z.string().min(1),
  width: z.number().int().positive(),
  commit: z.string().min(1),
  area: BoxSchema.optional(),
  /** When the mark is on a version: its set and name. */
  variant: z.strictObject({ set: z.string().min(1), name: z.string().min(1) }).optional(),
  words: z.string().trim().min(1, "Write what should change.").max(4000)
});

/** Makes a task from the person's mark on a capture. */
export function createTask(root: string, input: z.infer<typeof CreateSchema>): Task {
  if (!readStates(root).states.some((s) => s.id === input.state)) throw new AtlasError(`No valid recipe with id "${input.state}".`);
  const entry = input.variant
    ? versionEntry(root, input.variant.set, input.variant.name, input.state, input.width)
    : readManifest(root, input.commit)?.states[input.state]?.[String(input.width)];
  if (!entry) throw new AtlasError(input.variant ? `Version "${input.variant.name}" of "${input.variant.set}" has no capture of ${input.state} at ${input.width} pixels.` : `${input.state} has no capture at ${input.width} pixels at ${input.commit}.`);
  const now = new Date();
  const id = `${input.state}-${now.getTime().toString(36)}`;
  const element = input.area ? elementUnder(root, entry, input.area) : undefined;
  const task: Task = {
    id,
    state: input.state,
    width: input.width,
    commit: input.commit,
    status: "open",
    ...(input.area ? { area: input.area } : {}),
    ...(element ? { element } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    created: now.toISOString(),
    log: [{ at: now.toISOString(), by: "person", status: "open" }],
    words: input.variant ? `On version ${input.variant.name} of "${input.variant.set}": ${input.words}` : input.words
  };
  write(root, task);
  return task;
}

/** Makes the task that keeps one version of a set: the others and the switch between them come out of the code. */
export function chooseVariant(root: string, set: string, name: string, shown?: number): Task {
  const found = readVariantSets(root).find((v) => v.set === set);
  const option = found?.options.find((o) => o.name === name);
  if (!found || !option) throw new AtlasError(`No version "${name}" in the set "${set}".`);
  if (readTasks(root).tasks.some((t) => t.choice?.set === set && t.status !== "sent-back")) throw new AtlasError(`A version of "${set}" is already chosen.`);
  const [state, byWidth] = Object.entries(option.shots)[0] ?? [];
  // The width the person chose at, when the version has it; else its widest capture.
  const widths = Object.keys(byWidth ?? {}).map(Number);
  const width = shown && widths.includes(shown) ? shown : Math.max(0, ...widths);
  if (!state || !width) throw new AtlasError(`Version "${name}" of "${set}" has no capture.`);
  const others = found.options.filter((o) => o.name !== name).map((o) => o.name);
  const now = new Date();
  const task: Task = {
    id: `${set}-${now.getTime().toString(36)}`,
    state,
    width,
    commit: option.commit,
    status: "open",
    choice: { set, name, others },
    created: now.toISOString(),
    log: [{ at: now.toISOString(), by: "person", status: "open" }],
    words: `Keep version ${name} of "${set}" (${option.note}). Make it the screen's only version: remove ${others.length ? `version${others.length === 1 ? "" : "s"} ${others.join(", ")} and ` : ""}the switch between the versions from the code, and apply any open comments on version ${name}. Capture the screens again, call atlas_check, then mark this task ready for review.`
  };
  write(root, task);
  return task;
}

/** What each side may set, and from which statuses. */
const MOVES: Record<"person" | "agent", Partial<Record<Status, Status[]>>> = {
  agent: { "in-progress": ["open", "sent-back", "in-progress"], "ready-for-review": ["open", "sent-back", "in-progress"] },
  person: { approved: ["ready-for-review"], "sent-back": ["ready-for-review"] }
};

/**
 * Moves a task to a new status and logs who did it. When the agent marks it ready for review, Atlas attaches the state's capture
 * at the current commit as the after picture, so the agent must capture first.
 */
export function updateTask(root: string, id: string, by: "person" | "agent", status: Status, note?: string): Task {
  const task = readTask(root, id);
  const from = MOVES[by][status];
  if (!from) throw new AtlasError(by === "agent" ? `An agent sets a task to in-progress or ready-for-review. The person approves it or sends it back.` : `The person approves a task or sends it back.`);
  if (!from.includes(task.status)) throw new AtlasError(`Task ${id} is ${task.status}, so it cannot become ${status}.`);
  if (by === "person" && status === "sent-back" && !note?.trim()) throw new AtlasError("Say what is still wrong, so the agent can fix it.");
  const now = new Date().toISOString();
  let after = task.after;
  if (status === "ready-for-review") {
    const head = resolveRef(root, "HEAD");
    const entry = head ? readManifest(root, head)?.states[task.state]?.[String(task.width)] : undefined;
    if (!head || !entry || entry.capturedAt < (task.log.at(-1)?.at ?? task.created)) {
      throw new AtlasError(`Capture ${task.state} with atlas_capture after your change, then mark the task ready for review. Atlas attaches that capture for the person to check.`);
    }
    after = { commit: head, png: entry.png, capturedAt: entry.capturedAt };
  }
  const next: Task = { ...task, status, ...(after ? { after } : {}), log: [...task.log, { at: now, by, status, ...(note?.trim() ? { note: note.trim() } : {}) }] };
  write(root, next);
  return next;
}
