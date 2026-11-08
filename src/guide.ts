/**
 * What the MCP server teaches agents. `INSTRUCTIONS` travels with the server, so a project needs no setup text of its own;
 * `atlas_guide` gives the detail on request. Describe only tools and formats that exist.
 */
export const INSTRUCTIONS = `Atlas keeps a picture of every screen of this project, captured from the code at a commit, so the person you work with can see every screen in one place and send you changes.

Call atlas_guide once before your first Atlas task in a session.
Call atlas_states to see the project's state recipes, the live and branch commits, and any recipe that needs repair.
When you build or change a screen, write or update a recipe for each of its states in .atlas/states/<id>.json.
Repair every recipe that atlas_states reports as invalid.`;

export const TOPICS = {
  workflow: `How Atlas works

The person you work with builds this product by prompting coding agents like you. Atlas is how they see what you built and how they send you changes.

- A state is one way a screen can look: a page, a filled form, an empty list, an error, a menu open.
- Each state has a recipe in .atlas/states/<id>.json. The recipe says how to reach the state.
- You prepare each state: seed data, start the app at the right commit, make a test session. You have the code, so you can do this for any state.
- Atlas resolves live and the branch from git refs on every call. Never write a commit into a recipe or the settings.

Your part:
1. Before you start, call atlas_states to see which states exist.
2. When you build or change a screen, write or update the recipe of each state it has.
3. When a recipe stops working because the app changed, repair it in the same change.

Topics: workflow, recipes.`,

  recipes: `How to write a state recipe

One file for each state: .atlas/states/<id>.json. The id uses lowercase letters, digits and hyphens, and matches the file name.

{
  "id": "cart-with-items",
  "name": "Cart with two items",
  "area": "Shop",
  "page": "Cart",
  "route": "/cart",
  "setup": "pnpm seed cart-two-items",
  "session": "pnpm tsx scripts/test-session.ts",
  "steps": [{ "click": "button[aria-label='Apply code']" }, { "fill": "#code", "value": "SAVE10" }],
  "widths": [1440, 390],
  "leadsTo": [{ "state": "checkout", "action": "Check out" }]
}

- name: what a person calls the state, in plain words.
- area and page: where it sits in the product. Screens with the same page are grouped together.
- route: the path to open, starting with /.
- setup: a command you run to prepare the data, if the state needs any. Make it repeatable: running it twice gives the same state.
- session: a command that prints a test session, if the state needs sign-in. Use test accounts only, never a real person's account.
- steps: browser actions after the page opens, in order. Each step is one of { "click": selector }, { "fill": selector, "value": text }, { "press": key } or { "waitFor": selector }.
- widths: screen widths in pixels, if they differ from the project's settings.
- leadsTo: the states a person reaches from this one, and the action that takes them there. Atlas draws these as the flow between screens.

Write one recipe for each state a person can see, including empty, error and loading states where you can hold them still.
Call atlas_states after you write or change recipes, and fix anything it reports.`
} as const;

export type Topic = keyof typeof TOPICS;
