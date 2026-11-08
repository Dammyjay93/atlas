/*
 * Writes viewer/icons.json: the Solar Linear icons the viewer uses, from @iconify-json/solar (CC BY 4.0),
 * and the coding agents' logos, from @iconify-json/simple-icons (CC0). Run with `pnpm icons`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const SOLAR = ["monitor-linear", "smartphone-linear", "square-share-line-linear", "alt-arrow-down-linear", "check-linear", "copy-linear", "danger-triangle-linear", "plug-circle-linear"];
/** Viewer name: Simple Icons name. */
const LOGOS = { "logo-claude": "claude", "logo-codex": "openai", "logo-cursor": "cursor", "logo-other": "modelcontextprotocol" };
const require = createRequire(import.meta.url);
const read = (pkg) => JSON.parse(readFileSync(require.resolve(`${pkg}/icons.json`), "utf8"));
const out = {};
const add = (set, from, to = from) => {
  const icon = set.icons[from];
  if (!icon) throw new Error(`${set.prefix} has no icon named ${from}`);
  out[to] = icon.body;
};
const solar = read("@iconify-json/solar");
for (const name of SOLAR) add(solar, name);
const simple = read("@iconify-json/simple-icons");
for (const [to, from] of Object.entries(LOGOS)) add(simple, from, to);
writeFileSync(new URL("../viewer/icons.json", import.meta.url), JSON.stringify(out) + "\n");
process.stdout.write(`Wrote ${Object.keys(out).length} icons to viewer/icons.json\n`);
