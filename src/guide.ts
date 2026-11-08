/**
 * What the MCP server teaches agents. `INSTRUCTIONS` travels with the server, so a project needs no setup text of its own;
 * `flowmap_guide` gives the detail on request. Describe only tools and formats that exist.
 */
export const INSTRUCTIONS = `Flowmap keeps a picture of every screen of this project, captured from the code at a commit, so the person you work with can see every screen in one place and send you changes.

Call flowmap_guide once before your first Flowmap task in a session.
Call flowmap_states to see the project's state recipes, the live and branch commits, and any recipe that needs repair.
Call flowmap_tasks to see the changes the person asked for, and work through them with flowmap_task_update. When a request is unclear, ask the person in your session before you change anything; do not guess.
When you build or change a screen, write or update a recipe for each of its states in .flowmap/states/<id>.json, then capture each state with flowmap_capture.
To see what differs from live, capture the same states at live with flowmap_capture and live: true, then call flowmap_compare.
Before you say a change is done, call flowmap_check and look at every screen it reports as changed. Fix any change you did not mean to make, or tell the person why it is expected.
When the person asks for several versions of a screen, build them side by side behind a switch and capture each with flowmap_capture and variant. See flowmap_guide topic variations.
Repair every recipe that flowmap_states reports as invalid.`;

export const TOPICS = {
  workflow: `How Flowmap works

The person you work with builds this product by prompting coding agents like you. Flowmap is how they see what you built and how they send you changes.

- A state is one way a screen can look: a page, a filled form, an empty list, an error, a menu open.
- Each state has a recipe in .flowmap/states/<id>.json. The recipe says how to reach the state.
- You write each recipe's setup command, which puts the data in the state, and its session command, which signs in a test account. Flowmap runs them before it captures the state. You have the code, so you can do this for any state.
- You start the app.
- Flowmap resolves live and the branch from git refs on every call. Never write a commit into a recipe or the settings.

Your part:
1. Before you start, call flowmap_states to see which states exist.
2. When you build or change a screen, write or update the recipe of each state it has.
3. Capture each of those states with flowmap_capture, and look at the pictures it returns.
4. When a recipe stops working because the app changed, repair it in the same change.
5. To show what differs from live, capture the same states at live and call flowmap_compare. See the compare topic.
6. Before you say a change is done, call flowmap_check. It captures every state and shows every screen your change touched, including ones you did not mean to change. After you commit, call it again: on committed code it files every capture under the commit, so the person sees every screen at it.
7. The person marks what should change on a screen. Each mark is a task: call flowmap_tasks and work through them. See the tasks topic.

8. When the person asks for several versions of a screen, build them so they can choose in Flowmap. See the variations topic.

Topics: workflow, recipes, capture, compare, tasks, variations.`,

  recipes: `How to write a state recipe

One file for each state: .flowmap/states/<id>.json. The id uses lowercase letters, digits and hyphens, and matches the file name.

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
- route: the path to open, starting with /. For a page with an id in its path, such as /orders/[id], make setup create the record with a fixed id, or find one that always exists, and put that id in the route.
- setup: a shell command that puts the app's data in the state the screen needs. Flowmap runs it in the project's folder just before it captures the state. Make it reset everything the screen depends on, not only add to it: opening a page can change data, such as a page that saves progress or a notice that is dismissed once seen, and the next capture must start from the same data. Running it twice gives the same state.
- session: a shell command that signs in a test account and prints its session cookies, one name=value on each line, such as sid=abc123. If the app keeps its sign-in in the browser's localStorage instead, print each item as localStorage:name=value, with the value on one line, such as localStorage:auth-token={"access_token":"..."}. Flowmap runs it after setup and opens the page with those cookies and items. Leave it out for screens a signed-out person sees.
- steps: browser actions after the page opens, in order. Each step is one of { "click": selector }, { "fill": selector, "value": text }, { "press": key } or { "waitFor": selector }. Use steps to open a tab, menu, dialog or drawer.
- widths: screen widths in pixels, if they differ from the project's settings.
- fullPage: true captures the whole length of a page that scrolls.
- leadsTo: the states a person reaches from this one, and the action that takes them there. Flowmap draws these as the flow between screens.

Write a recipe for every state a person can see, not only the main screens:
- every route, including pages that need sign-in, a role or a plan;
- on each page, each tab, menu, dialog, drawer and expanded panel;
- each step of a flow, such as each step of sign-up or checkout;
- each empty, error and loading state you can hold still, and each plan, role or setting that changes the page.
Do not leave out a screen because it needs sign-in or data: write a setup and a session command for it.

How Flowmap runs setup and session:
- States with the same setup command form a group. Flowmap runs the group's setup once, then each of its session commands once, then captures its states several at a time. Then it goes on to the next group.
- Flowmap never runs two different setups at the same time. So states that need data in states that conflict, such as "still in set-up" and "set-up finished", each get their own setup command, and Flowmap captures them one after the other.
- If capturing one state changes data that another state in its group needs, give that state its own setup command, such as the same script with another argument.
- If a group's setup or a session command fails, Flowmap reports the states it left unprepared with the command's output, and still captures the other groups.
- Both commands get FLOWMAP_BASE_URL, the app's address, and run in the project's folder.
- Use only test data and test accounts on a local or test database. Never use a real person's account or production data.

How to write a session command:
An app with sign-in already has code that makes a session: the function its sign-in route calls once the password or the email link checks out. Write a small script, such as .flowmap/session.ts, that:
1. Finds or creates a test account, such as test@example.com, in the local test database.
2. Calls the app's own session code for that account, the same function the sign-in route calls, so the session is real.
3. Prints the session cookie as name=value, with the cookie name the app sets. If the app's sign-in code writes to localStorage instead, print what it writes as localStorage:name=value.
Run the script with the app's own tools and environment, such as "pnpm tsx .flowmap/session.ts", and make it refuse any database but the test one. If the app's session code cannot run outside the server, sign in through the running app instead: post to its sign-in or test sign-in route at FLOWMAP_BASE_URL and print the cookie from the response. Never write a real password into a recipe.

Call flowmap_states after you write or change recipes, and fix anything it reports.`,

  capture: `How to capture a state

1. Start the app if it is not running.
2. Call flowmap_capture with the recipe id and the address of the running app (baseUrl). Flowmap runs the recipe's setup, then its session command, and opens the page with the session's cookies. To capture every state in one run, use the command line: flowmap capture --base-url <address>.
3. Look at the pictures it returns. If the page shows the wrong state, fix the setup, the session or the steps, and capture again.

Flowmap saves a picture and an HTML snapshot for each width in .flowmap/store/<commit>/<state>/. The commit comes from git, so commit your work before you capture when you can; a capture with uncommitted changes is marked as such and names the changed files. If a tool rewrites a tracked file when the app starts, such as AGENTS.md under next dev, list that file in "ignoreChanges" in .flowmap/config.json, so its change does not count.

For captures that stay the same between runs:
- Seed the same data every time.
- If the app shows relative dates, such as "3 days ago", make the recipe's setup seed those dates relative to the current time, so they read the same on every run. Setting "time" in .flowmap/config.json only freezes the browser's clock; dates the server works out still follow the server's clock.
- Add selectors to "hide" in .flowmap/config.json for anything that is not part of the product, such as a development overlay.

If the result says landedOn, the app sent the browser somewhere other than the recipe's route, for example to a sign-in page, or to a guided tour or an onboarding step that the account has not finished. Check the session and the setup. The app's own end-to-end tests often show how to put an account past such a step.
If the result's status is not 200, the page answered with an error, for example 401 when the session cookie is wrong.`,

  compare: `How to compare with live

Live is the code at the ref in .flowmap/config.json (liveRef), such as origin/main. Flowmap compares code with code, on the same data, so a difference is a change in the code.

1. Call flowmap_states to get live's commit.
2. Check out that commit in a second copy of the project, outside this folder: git worktree add <folder> <commit>. Install its dependencies.
3. Start the app from that copy on another port, with the same data as this one.
4. For each state, call flowmap_capture with live: true and that address. Flowmap uses this project's recipes and files the capture under live's commit.
5. Capture the same states at this commit as usual.
6. Call flowmap_compare for a state. It returns each width's status, each element that was added, removed, moved or looks different, with its exact box, and pictures of each area at live and at this commit.

Statuses: same, changed, new (no live capture) and missing (not captured at this commit).
Content that only moved up or down is not a change. Flowmap records every visible element at capture, so each change names a real element at its real place. When no element accounts for changed pixels, such as a drawn decoration, the area has no elements and outlines the pixels.
When live moves to a new commit, capture live again.`,

  tasks: `How to work through tasks

The person marks a part of a screen in the Flowmap viewer and writes what should change. Each mark is a task in .flowmap/tasks/<id>.md, committed with the project.

1. Call flowmap_tasks. Each task has the person's words, the state and width, the box they marked, the element under it, and a picture with their box drawn on it.
2. If a request could mean more than one thing (one row or every row, this screen or all screens), ask the person in your session before you change anything. Do not guess.
3. Call flowmap_task_update with status in-progress when you start a task, so the person sees it.
4. Change the code. Then capture the task's state with flowmap_capture, and look at the picture.
5. Call flowmap_task_update with status ready-for-review and a note on what you changed. Flowmap attaches your capture as the after picture.
6. The person approves the task or sends it back with a note. A sent-back task appears again in flowmap_tasks: read the last note in its history and fix what it says.

Approved tasks are decisions: call flowmap_tasks with status approved before you build from a screen the person chose.`,

  variations: `How to build versions of a screen for the person to choose from

1. Agree with the person how many versions, and what should differ between them.
2. Build every version side by side in this working copy, behind a switch the address can set, such as ?version=b. Keep the current screen as the default, so nothing else changes.
3. Before you change code for a version, call flowmap_version_start with its state and variant. The person sees its frame being built.
4. Capture each version with flowmap_capture and variant: { set, name, note, route }. The set names the screen (such as job-card), name names the version (such as a, b, c), note says in one sentence what makes it different, and route is the address that shows it (such as /board?tab=fit&version=b). Every version of a set should capture the same states.
5. Tell the person the versions are ready in Flowmap. They appear side by side, and the person can comment on any version before choosing.
6. A comment on a version arrives as a task with a version: change that version only, capture it again with the same variant, and mark the task ready.
7. The person's choice arrives as a task with a choice: the version to keep and the others. Make the kept version the screen's only version: remove the other versions and the switch from the code, capture the screens again, call flowmap_check, and mark the task ready for review.`
} as const;

export type Topic = keyof typeof TOPICS;
