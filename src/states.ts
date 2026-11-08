import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** A browser action after the page opens, to reach the state: open a menu, fill a field, wait for content. */
const StepSchema = z.union([
  z.strictObject({ click: z.string().min(1) }),
  z.strictObject({ fill: z.string().min(1), value: z.string() }),
  z.strictObject({ press: z.string().min(1) }),
  z.strictObject({ waitFor: z.string().min(1) })
]);

/**
 * How to reach one state of the product. Agents write a recipe when they build a screen and repair it when it stops working.
 * The agent runs `setup` and `session`; Atlas opens `route` and runs `steps`.
 */
export const StateSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  name: z.string().min(1),
  area: z.string().min(1).optional(),
  page: z.string().min(1).optional(),
  route: z.string().startsWith("/"),
  setup: z.string().min(1).optional(),
  session: z.string().min(1).optional(),
  steps: z.array(StepSchema).optional(),
  widths: z.array(z.number().int().positive()).min(1).optional(),
  leadsTo: z.array(z.strictObject({ state: z.string().min(1), action: z.string().min(1) })).optional()
});
export type State = z.infer<typeof StateSchema>;

export interface StateList {
  states: State[];
  /** Recipes that could not be read, so an agent can repair them. */
  invalid: { file: string; problem: string }[];
}

export function readStates(root: string): StateList {
  const dir = join(root, ".atlas", "states");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { states: [], invalid: [] };
  }
  const list: StateList = { states: [], invalid: [] };
  const seen = new Map<string, string>();
  for (const file of files) {
    const path = join(".atlas", "states", file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      list.invalid.push({ file: path, problem: `not valid JSON: ${(error as Error).message}` });
      continue;
    }
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) {
      list.invalid.push({ file: path, problem: z.prettifyError(parsed.error) });
      continue;
    }
    const first = seen.get(parsed.data.id);
    if (first) {
      list.invalid.push({ file: path, problem: `id "${parsed.data.id}" is already used by ${first}` });
      continue;
    }
    seen.set(parsed.data.id, path);
    list.states.push(parsed.data);
  }
  const ids = new Set(list.states.map((s) => s.id));
  for (const state of list.states) {
    for (const edge of state.leadsTo ?? []) {
      if (!ids.has(edge.state)) list.invalid.push({ file: join(".atlas", "states", `${state.id}.json`), problem: `leadsTo names "${edge.state}", which has no recipe` });
    }
  }
  return list;
}
