/**
 * What the MCP server teaches agents. `INSTRUCTIONS` travels with the server, so a project needs no setup text of its own;
 * `atlas_guide` gives the detail on request. Describe only tools and formats that exist.
 */
export const INSTRUCTIONS = `Atlas keeps a picture of every screen of this project, captured from the code at a commit, so the person you work with can see every screen in one place and send you changes.

Call atlas_guide once before your first Atlas task in a session.
Call atlas_states to see the project's state recipes, the live and branch commits, and any recipe that needs repair.
Call atlas_tasks to see the changes the person asked for, and work through them with atlas_task_update. When a request is unclear, ask the person in your session before you change anything; do not guess.
When you build or change a screen, write or update a recipe for each of its states in .atlas/states/<id>.json, then capture each state with atlas_capture.
To see what differs from live, capture the same states at live with atlas_capture and live: true, then call atlas_compare.
Before you say a change is done, call atlas_check and look at every screen it reports as changed. Fix any change you did not mean to make, or tell the person why it is expected.
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
5. To show what differs from live, capture the same states at live and call atlas_compare. See the compare topic.
6. Before you say a change is done, call atlas_check. It captures every state and shows every screen your change touched, including ones you did not mean to change.
7. The person marks what should change on a screen. Each mark is a task: call atlas_tasks and work through them. See the tasks topic.

Topics: workflow, recipes, capture, compare, tasks.`,

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
- If the app shows relative dates, such as "3 days ago", make the recipe's setup seed those dates relative to the current time, so they read the same on every run. Setting "time" in .atlas/config.json only freezes the browser's clock; dates the server works out still follow the server's clock.
- Add selectors to "hide" in .atlas/config.json for anything that is not part of the product, such as a development overlay.

If the result says landedOn, the app sent the browser somewhere other than the recipe's route, for example to a sign-in page. Check the session and the setup.
If the result's status is not 200, the page answered with an error, for example 401 when the session cookie is wrong.`,

  compare: `How to compare with live

Live is the code at the ref in .atlas/config.json (liveRef), such as origin/main. Atlas compares code with code, on the same data, so a difference is a change in the code.

1. Call atlas_states to get live's commit.
2. Check out that commit in a second copy of the project, outside this folder: git worktree add <folder> <commit>. Install its dependencies.
3. Start the app from that copy on another port, with the same data as this one.
4. For each state, call atlas_capture with live: true and that address. Atlas uses this project's recipes and files the capture under live's commit.
5. Capture the same states at this commit as usual.
6. Call atlas_compare for a state. It returns each width's status, each element that was added, removed, moved or looks different, with its exact box, and pictures of each area at live and at this commit.

Statuses: same, changed, new (no live capture) and missing (not captured at this commit).
Content that only moved up or down is not a change. Atlas records every visible element at capture, so each change names a real element at its real place. When no element accounts for changed pixels, such as a drawn decoration, the area has no elements and outlines the pixels.
When live moves to a new commit, capture live again.`,

  tasks: `How to work through tasks

The person marks a part of a screen in the Atlas viewer and writes what should change. Each mark is a task in .atlas/tasks/<id>.md, committed with the project.

1. Call atlas_tasks. Each task has the person's words, the state and width, the box they marked, the element under it, and a picture with their box drawn on it.
2. If a request could mean more than one thing (one row or every row, this screen or all screens), ask the person in your session before you change anything. Do not guess.
3. Call atlas_task_update with status in-progress when you start a task, so the person sees it.
4. Change the code. Then capture the task's state with atlas_capture, and look at the picture.
5. Call atlas_task_update with status ready-for-review and a note on what you changed. Atlas attaches your capture as the after picture.
6. The person approves the task or sends it back with a note. A sent-back task appears again in atlas_tasks: read the last note in its history and fix what it says.

Approved tasks are decisions: call atlas_tasks with status approved before you build from a screen the person chose.`
} as const;

export type Topic = keyof typeof TOPICS;
