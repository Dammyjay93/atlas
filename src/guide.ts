/**
 * What the MCP server teaches agents. `INSTRUCTIONS` travels with the server, so a project needs no setup text of its own;
 * `atlas_guide` gives the detail on request. Describe only tools and formats that exist.
 */
export const INSTRUCTIONS = `Atlas keeps a picture of every screen of this project, captured from the code at a commit, so the person you work with can see every screen in one place and send you changes.

Call atlas_guide once before your first Atlas task in a session.
Call atlas_states to see the project's state recipes, the live and branch commits, and any recipe that needs repair.
When you build or change a screen, write or update a recipe for each of its states in .atlas/states/<id>.json, then capture each state with atlas_capture.
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
3. Capture each of those states with atlas_capture, and look at the pictures it returns.
4. When a recipe stops working because the app changed, repair it in the same change.

Topics: workflow, recipes, capture.`,

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
Call atlas_states after you write or change recipes, and fix anything it reports.`,

  capture: `How to capture a state

1. Prepare the state. Run the recipe's setup to seed the data, and start the app if it is not running.
2. If the state needs sign-in, run the recipe's session command and pass the cookies it gives you.
3. Call atlas_capture with the recipe id and the address of the running app (baseUrl).
4. Look at the pictures it returns. If the page shows the wrong state, fix the setup, the session or the steps, and capture again.

Atlas saves a picture and an HTML snapshot for each width in .atlas/store/<commit>/<state>/. The commit comes from git, so commit your work before you capture when you can; a capture with uncommitted changes is marked as such.

For captures that stay the same between runs:
- Seed the same data every time.
- If the app shows relative dates, such as "3 days ago", set "time" in .atlas/config.json to a fixed moment, and seed dates relative to it.
- Add selectors to "hide" in .atlas/config.json for anything that is not part of the product, such as a development overlay.

If the result says landedOn, the app sent the browser somewhere other than the recipe's route, for example to a sign-in page. Check the session and the setup.`
} as const;

export type Topic = keyof typeof TOPICS;
