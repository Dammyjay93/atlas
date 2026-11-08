import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffArrays } from "diff";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { AtlasError, readConfig, resolveRef } from "./project.js";
import { readStates } from "./states.js";
import { readManifest, type Entry } from "./store.js";
import type { LayoutItem } from "./text-map.js";

/** Bump when the method changes, so cached results are worked out again. */
const METHOD = 10;
/** Row signatures: brightness in blocks this many pixels wide, rounded to steps this far apart. Text and controls change them; faint texture does not. */
const BLOCK = 32;
const LEVEL = 32;
/**
 * Changed rows closer than one control height are one area: one change to a component often leaves unchanged rows between its parts,
 * and a removal leaves only a mark where the removed rows were.
 */
const NEAR = 32;
/** Areas smaller than this, in square pixels, are noise. */
const MIN_AREA = 400;
/** Most changes listed for each area. */
const MAX_CHANGES = 12;

/** same: no change. changed: at least one area changed. new: no live capture. missing: no branch capture. */
export type Status = "same" | "changed" | "new" | "missing";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One element that changed, at its exact box in CSS pixels:
 * - added: the branch has it and live does not;
 * - removed: live has it and the branch does not (it has only a live box);
 * - moved: it is at another place, beyond the shift of the content around it;
 * - changed: it is at the same place but looks different.
 */
export interface Change {
  kind: "added" | "removed" | "moved" | "changed";
  /** The element's text or accessible name, or its tag when it has neither. */
  name: string;
  tag: string;
  box?: Box;
  liveBox?: Box;
}

/**
 * One change to the page: the box around its changed elements on the branch picture, the box on the live picture, and the elements.
 * When no element accounts for the changed pixels, such as a drawn decoration, `changes` is empty and the boxes are the changed pixels.
 */
export interface Area extends Box {
  live: Box;
  changes: Change[];
}

export interface Comparison {
  status: Status;
  /** True when content moved up or down. Moved content is not a change. */
  moved: boolean;
  areas: Area[];
}

/** A capture at its own pixel density: `k` pixels for each CSS pixel. The compare works in these pixels, where content that moved by part of a CSS pixel still moved by whole pixels. */
interface Picture {
  width: number;
  height: number;
  k: number;
  data: Uint8Array;
}

function readPicture(root: string, entry: Entry, cssWidth: number): Picture {
  const png = PNG.sync.read(readFileSync(join(root, entry.png)));
  return { width: png.width, height: png.height, k: Math.max(1, Math.round(png.width / cssWidth)), data: png.data };
}

const gray = (p: Picture, x: number, y: number) => {
  const i = (y * p.width + x) * 4;
  return 0.299 * (p.data[i] ?? 0) + 0.587 * (p.data[i + 1] ?? 0) + 0.114 * (p.data[i + 2] ?? 0);
};

/** The columns where the two pictures differ, over the rows they share. Null when they are the same there. */
function changedColumns(live: Picture, branch: Picture): { x0: number; x1: number } | null {
  const width = branch.width, height = Math.min(live.height, branch.height);
  const size = width * height * 4;
  const out = new Uint8Array(size);
  const count = pixelmatch(live.data.subarray(0, size), branch.data.subarray(0, size), out, width, height, { diffMask: true });
  if (count === 0) return live.height === branch.height ? null : { x0: 0, x1: width };
  let x0 = width, x1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // diffMask draws real differences in red and anti-aliasing in yellow; only red counts.
      if ((out[i + 3] ?? 0) > 0 && (out[i + 1] ?? 0) === 0) {
        if (x < x0) x0 = x;
        if (x + 1 > x1) x1 = x + 1;
      }
    }
  }
  if (x1 <= x0) return live.height === branch.height ? null : { x0: 0, x1: width };
  return { x0, x1 };
}

function signatures(p: Picture, x0: number, x1: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < p.height; y++) {
    let sig = "";
    for (let bx = x0; bx < x1; bx += BLOCK * p.k) {
      const end = Math.min(x1, bx + BLOCK * p.k);
      let sum = 0;
      for (let x = bx; x < end; x++) sum += gray(p, x, y);
      sig += String.fromCharCode(48 + Math.floor(sum / (end - bx) / LEVEL));
    }
    rows.push(sig);
  }
  return rows;
}

/** Branch rows b0 to b1 took the place of live rows l0 to l1. A removal adds no branch rows, so its branch rows only mark where live's rows were. */
interface Span {
  b0: number;
  b1: number;
  l0: number;
  l1: number;
  removal: boolean;
}

/** Spans close enough to be one change. */
interface Group {
  b0: number;
  b1: number;
  l0: number;
  l1: number;
  parts: Span[];
}

/**
 * Matches the rows of the two pictures as a text diff matches lines, so content that only moved up or down is not a change.
 * Returns the branch rows that were replaced or added, each with the live rows it took the place of.
 */
function changedRows(live: Picture, branch: Picture, x0: number, x1: number): { groups: Group[]; moved: boolean } {
  const changes = diffArrays(signatures(live, x0, x1), signatures(branch, x0, x1));
  const spans: Span[] = [];
  let i = 0, j = 0, moved = false;
  for (let k = 0; k < changes.length; k++) {
    const change = changes[k];
    if (!change) continue;
    if (!change.added && !change.removed) {
      if (i !== j) moved = true;
      i += change.count;
      j += change.count;
      continue;
    }
    let removed = 0, added = 0;
    for (; k < changes.length; k++) {
      const c = changes[k];
      if (!c || (!c.added && !c.removed)) break;
      if (c.added) added += c.count;
      else removed += c.count;
    }
    k--;
    if (added) spans.push({ b0: j, b1: j + added, l0: i, l1: i + removed, removal: false });
    else spans.push({ b0: Math.max(0, j - 1), b1: Math.min(branch.height, j + 1), l0: i, l1: i + removed, removal: true });
    i += removed;
    j += added;
  }
  // When content moved up, rows that scrolled into view at the bottom edge are not a change.
  const last = spans.at(-1);
  if (moved && last && last.b1 >= branch.height - 1) spans.pop();
  const groups: Group[] = [];
  for (const s of spans) {
    const prev = groups.at(-1);
    if (prev && s.b0 - prev.b1 <= NEAR * branch.k) {
      prev.parts.push(s);
      prev.b1 = Math.max(prev.b1, s.b1);
      prev.l0 = Math.min(prev.l0, s.l0);
      prev.l1 = Math.max(prev.l1, s.l1);
    } else groups.push({ b0: s.b0, b1: s.b1, l0: s.l0, l1: s.l1, parts: [s] });
  }
  return { groups, moved };
}

/**
 * True when the branch rows of a span show the same pixels as live at the same place. The row matcher can pair nearly blank rows
 * across a change and so shift its alignment; a span it reports there changed nothing.
 */
function sameInPlace(live: Picture, branch: Picture, s: Group, x0: number, x1: number): boolean {
  if (s.b1 > live.height) return false;
  for (let y = s.b0; y < s.b1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * branch.width + x) * 4;
      for (let c = 0; c < 3; c++) if (Math.abs((branch.data[i + c] ?? 0) - (live.data[i + c] ?? 0)) > 24) return false;
    }
  }
  return true;
}

const differs = (a: Picture, ai: number, b: Picture, bi: number) =>
  Math.abs((a.data[ai] ?? 0) - (b.data[bi] ?? 0)) > 24 || Math.abs((a.data[ai + 1] ?? 0) - (b.data[bi + 1] ?? 0)) > 24 || Math.abs((a.data[ai + 2] ?? 0) - (b.data[bi + 2] ?? 0)) > 24;

/**
 * The box of the pixels that changed in a group, inside the band of changed columns. Each branch row is compared with the live row
 * it took the place of; branch rows beyond those are compared with the branch row just above the change. A removal only joins a
 * change and does not grow its box; a group of removals alone is marked by live's removed content, drawn where it was.
 */
function changedBox(live: Picture, branch: Picture, g: Group, x0: number, x1: number): { x0: number; x1: number; y0: number; y1: number } | null {
  const box = { x0: x1, x1: x0, y0: branch.height, y1: 0 };
  const mark = (x: number, y: number) => {
    if (x < box.x0) box.x0 = x;
    if (x + 1 > box.x1) box.x1 = x + 1;
    if (y < box.y0) box.y0 = y;
    if (y + 1 > box.y1) box.y1 = y + 1;
  };
  const rows = g.parts.filter((p) => !p.removal);
  for (const p of rows) {
    for (let y = p.b0; y < p.b1; y++) {
      const t = y - p.b0;
      const [ref, refY] = t < p.l1 - p.l0 ? [live, p.l0 + t] : [branch, Math.max(0, p.b0 - 1)];
      for (let x = x0; x < x1; x++) if (differs(branch, (y * branch.width + x) * 4, ref, (refY * ref.width + x) * 4)) mark(x, y);
    }
  }
  if (!rows.length) {
    for (const p of g.parts) {
      const above = Math.max(0, p.l0 - 1);
      for (let y = p.l0; y < p.l1; y++) for (let x = x0; x < x1; x++) if (differs(live, (y * live.width + x) * 4, live, (above * live.width + x) * 4)) mark(x, p.b0);
    }
    if (box.x1 > box.x0) box.y1 = Math.max(box.y1, box.y0 + 1);
  }
  return box.x1 > box.x0 ? box : null;
}

function readLayout(root: string, entry: Entry): LayoutItem[] {
  if (!entry.layout || !existsSync(join(root, entry.layout))) return [];
  return JSON.parse(readFileSync(join(root, entry.layout), "utf8")) as LayoutItem[];
}

const contains = (a: Box, b: Box) => a !== b && a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
const overlaps = (a: Box, x0: number, x1: number, y0: number, y1: number) => a.x < x1 && a.x + a.w > x0 && a.y < y1 && a.y + a.h > y0;
const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};
/** What to call an element: its text or accessible name; a background box by the start of what it holds; an icon or image by its kind. */
const nameOf = (t: LayoutItem) => {
  if (t.surface) return t.text ? `box around “${t.text.length > 24 ? `${t.text.slice(0, 24).trimEnd()}…` : t.text}”` : `${t.tag} box`;
  return t.text || (t.tag === "svg" ? "icon" : t.tag === "img" ? "image" : t.tag);
};
const boxOf = (t: LayoutItem): Box => ({ x: t.x, y: t.y, w: t.w, h: t.h });

/**
 * True when an element looks different at the same place: its pixels on the branch differ from live's at its live box. Pixels of
 * the elements inside it are left out, so a container counts as changed only for its own drawing, such as its background.
 */
function looksDifferent(live: Picture, branch: Picture, b: LayoutItem, l: LayoutItem, inside: LayoutItem[]): boolean {
  const k = branch.k;
  for (let y = 0; y < b.h * k; y++) {
    const by = b.y * k + y, ly = l.y * k + y;
    if (by >= branch.height || ly >= live.height) break;
    for (let x = 0; x < b.w * k; x++) {
      const bx = b.x * k + x, lx = l.x * k + x;
      if (bx >= branch.width || lx >= live.width) break;
      if (inside.some((c) => bx >= c.x * k && bx < (c.x + c.w) * k && by >= c.y * k && by < (c.y + c.h) * k)) continue;
      if (differs(branch, (by * branch.width + bx) * 4, live, (ly * live.width + lx) * 4)) return true;
    }
  }
  return false;
}

/** Pairs the elements of live and the branch in page order, as a text diff pairs lines. Unpaired elements were added or removed. */
function pairElements(live: LayoutItem[], branch: LayoutItem[]): Map<number, number> {
  const key = (t: LayoutItem) => `${t.surface ? "surface:" : ""}${t.tag}|${t.text}`;
  const pairs = new Map<number, number>();
  let i = 0, j = 0;
  for (const c of diffArrays(live.map(key), branch.map(key))) {
    if (c.added) j += c.count;
    else if (c.removed) i += c.count;
    else for (let n = 0; n < c.count; n++) pairs.set(j++, i++);
  }
  return pairs;
}

/**
 * The elements that changed in a group of changed rows. Elements carried along by a container that moved, and containers whose only
 * change is inside them, are left out, so each change is named once, at the element that changed.
 */
function changesIn(live: Picture, branch: Picture, g: Group, band: { x0: number; x1: number }, liveItems: LayoutItem[], branchItems: LayoutItem[], pairs: Map<number, number>): Change[] {
  const k = branch.k, x0 = band.x0 / k, x1 = band.x1 / k;
  const rows = g.parts.filter((p) => !p.removal);
  const shift = (g.l0 - g.b0) / k;
  const found: (Change & { dx: number; dy: number; at: Box; surface: boolean })[] = [];
  const paired = new Set(pairs.values());
  branchItems.forEach((b, index) => {
    if (!rows.some((p) => overlaps(b, x0, x1, p.b0 / k, p.b1 / k))) return;
    const name = nameOf(b), at = boxOf(b);
    const li = pairs.get(index);
    const l = li === undefined ? undefined : liveItems[li];
    const surface = !!b.surface;
    if (!l) return void found.push({ kind: "added", name, tag: b.tag, box: at, dx: 0, dy: 0, at, surface });
    const dx = b.x - l.x, dy = b.y - l.y + shift;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return void found.push({ kind: "moved", name, tag: b.tag, box: at, liveBox: boxOf(l), dx, dy, at, surface });
    const inside = branchItems.filter((c) => contains(b, c));
    if (looksDifferent(live, branch, b, l, inside)) found.push({ kind: "changed", name, tag: b.tag, box: at, liveBox: boxOf(l), dx: 0, dy: 0, at, surface });
  });
  liveItems.forEach((l, index) => {
    if (paired.has(index) || !overlaps(l, x0, x1, g.l0 / k, g.l1 / k)) return;
    found.push({ kind: "removed", name: nameOf(l), tag: l.tag, liveBox: boxOf(l), dx: 0, dy: 0, at: boxOf(l), surface: !!l.surface });
  });
  const shape = found.filter((c) => c.kind !== "changed");
  const seen = new Set<string>();
  return found
    .filter((c) => {
      // Content carried by an element that was added, or that moved by exactly the same amount, goes with it: the outer element names it.
      if (c.kind !== "removed" && c.kind !== "added" && found.some((o) => o !== c && contains(o.at, c.at) && (o.kind === "added" || (o.kind === "moved" && c.kind === "moved" && o.dx === c.dx && o.dy === c.dy)))) return false;
      // A background box is named only when nothing inside it explains the change.
      if (c.surface && found.some((o) => o !== c && !o.surface && contains(c.at, o.at))) return false;
      // A container that looks different only because of a change inside it is named by that change.
      if (c.kind === "changed" && shape.some((o) => contains(c.at, o.at))) return false;
      // Of nested containers that look different, the outermost names the change.
      if (c.kind === "changed" && found.some((o) => o.kind === "changed" && contains(o.at, c.at))) return false;
      // The same element named twice, such as two nested boxes with the same text, is listed once.
      const key = `${c.kind} ${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CHANGES)
    .map(({ dx, dy, at, surface, ...change }) => change);
}

function work(root: string, cssWidth: number, liveEntry: Entry, branchEntry: Entry): Comparison {
  const live = readPicture(root, liveEntry, cssWidth), branch = readPicture(root, branchEntry, cssWidth);
  if (live.width !== branch.width) throw new AtlasError(`The live and branch pictures have different widths (${live.width} and ${branch.width} pixels). Capture both again.`);
  const k = branch.k;
  const band = changedColumns(live, branch);
  if (!band) return { status: "same", moved: false, areas: [] };
  const { groups, moved } = changedRows(live, branch, band.x0, band.x1);
  const liveItems = readLayout(root, liveEntry), branchItems = readLayout(root, branchEntry);
  const pairs = pairElements(liveItems, branchItems);
  const areas: Area[] = [];
  for (const g of groups) {
    if (sameInPlace(live, branch, g, band.x0, band.x1)) continue;
    const changes = changesIn(live, branch, g, band, liveItems, branchItems, pairs);
    const onBranch = changes.flatMap((c) => (c.box ? [c.box] : [])), onLive = changes.flatMap((c) => (c.liveBox ? [c.liveBox] : []));
    if (onBranch.length || onLive.length) {
      const box = onBranch.length ? union(onBranch) : { ...union(onLive), y: Math.floor(g.b0 / k), h: 1 };
      areas.push({ ...box, live: onLive.length ? union(onLive) : box, changes });
      continue;
    }
    // No element accounts for these pixels, such as a drawn decoration: outline the changed pixels themselves.
    const px = changedBox(live, branch, g, band.x0, band.x1);
    if (!px) continue;
    const box = { x: Math.floor(px.x0 / k), y: Math.floor(px.y0 / k), w: Math.ceil(px.x1 / k) - Math.floor(px.x0 / k), h: Math.ceil(px.y1 / k) - Math.floor(px.y0 / k) };
    if (box.w * box.h < MIN_AREA) continue;
    areas.push({ ...box, live: { x: box.x, y: Math.floor(g.l0 / k), w: box.w, h: Math.max(1, Math.ceil((g.l1 - g.l0) / k)) }, changes: [] });
  }
  return { status: areas.length ? "changed" : "same", moved, areas };
}

/** Compares one state at one width. Results are kept next to the branch capture and reused while both pictures stay the same. */
export function compareEntries(root: string, cssWidth: number, live: Entry | undefined, branch: Entry | undefined): Comparison {
  if (!branch) return { status: "missing", moved: false, areas: [] };
  if (!live) return { status: "new", moved: false, areas: [] };
  if (live.hash === branch.hash) return { status: "same", moved: false, areas: [] };
  const cache = join(root, branch.png.replace(/\.png$/, ".compare.json"));
  if (existsSync(cache)) {
    const kept = JSON.parse(readFileSync(cache, "utf8")) as { method: number; live: string; branch: string; result: Comparison };
    if (kept.method === METHOD && kept.live === live.hash && kept.branch === branch.hash) return kept.result;
  }
  const result = work(root, cssWidth, live, branch);
  writeFileSync(cache, JSON.stringify({ method: METHOD, live: live.hash, branch: branch.hash, result }));
  return result;
}

export interface WidthComparison extends Comparison {
  width: number;
  live?: Entry;
  branch?: Entry;
}

export interface StateComparison {
  state: string;
  live: { ref: string; commit: string; captured: boolean };
  branch: { commit: string };
  widths: WidthComparison[];
}

/** Compares a state's captures at the branch commit (HEAD by default) with its captures at live. */
export function compareState(root: string, id: string, branchCommit?: string): StateComparison {
  const config = readConfig(root);
  const state = readStates(root).states.find((s) => s.id === id);
  if (!state) throw new AtlasError(`No valid recipe with id "${id}". Call atlas_states to see the recipes.`);
  const liveCommit = resolveRef(root, config.liveRef);
  if (!liveCommit) throw new AtlasError(`Live's ref "${config.liveRef}" does not resolve to a commit. Fetch it, or set "liveRef" in .atlas/config.json.`);
  const commit = branchCommit ?? resolveRef(root, "HEAD");
  if (!commit) throw new AtlasError("The project has no commit yet. Commit once, then capture.");
  const liveManifest = readManifest(root, liveCommit), branchManifest = readManifest(root, commit);
  const widths = state.widths ?? config.widths;
  return {
    state: id,
    live: { ref: config.liveRef, commit: liveCommit, captured: liveManifest !== null },
    branch: { commit },
    widths: widths.map((width) => {
      const live = liveManifest?.states[id]?.[String(width)], branch = branchManifest?.states[id]?.[String(width)];
      return { width, ...compareEntries(root, width, live, branch), ...(live ? { live } : {}), ...(branch ? { branch } : {}) };
    })
  };
}

/**
 * A part of a capture as a PNG at the capture's own pixel density, for an agent to look at. `box` is in CSS pixels.
 * `mark`, also in CSS pixels on the whole picture, is drawn as a 2-pixel indigo outline, such as the box a person marked.
 */
export function cropPicture(root: string, entry: Entry, cssWidth: number, box: Box, mark?: Box): Buffer {
  const png = PNG.sync.read(readFileSync(join(root, entry.png)));
  const k = Math.max(1, Math.round(png.width / cssWidth));
  const x = Math.max(0, Math.floor(box.x * k)), y = Math.max(0, Math.floor(box.y * k));
  const w = Math.max(1, Math.min(png.width - x, Math.ceil(box.w * k))), h = Math.max(1, Math.min(png.height - y, Math.ceil(box.h * k)));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  if (mark) {
    const x0 = mark.x * k - x, y0 = mark.y * k - y, x1 = (mark.x + mark.w) * k - x, y1 = (mark.y + mark.h) * k - y;
    const paint = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= w || py >= h) return;
      const i = (py * w + px) * 4;
      out.data[i] = 79; out.data[i + 1] = 70; out.data[i + 2] = 229; out.data[i + 3] = 255;
    };
    for (let t = 0; t < 2 * k; t++) {
      for (let px = x0 - t; px <= x1 + t; px++) { paint(px, y0 - t); paint(px, y1 + t); }
      for (let py = y0 - t; py <= y1 + t; py++) { paint(x0 - t, py); paint(x1 + t, py); }
    }
  }
  return PNG.sync.write(out);
}
