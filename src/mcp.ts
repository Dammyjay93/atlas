import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { capture } from "./capture.js";
import { compareState, cropPicture, type StateComparison } from "./compare.js";
import { INSTRUCTIONS, TOPICS, type Topic } from "./guide.js";
import { overview } from "./overview.js";
import { AtlasError } from "./project.js";
import { VERSION } from "./version.js";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** Most changed areas returned as pictures for each width, so a result stays small enough to read. */
const MAX_AREA_PICTURES = 3;
/** Space around each changed area in its pictures, and the tallest picture, in CSS pixels. */
const CROP_MARGIN = 24;
const CROP_MAX_HEIGHT = 480;

/** How an agent captures live, when nothing is captured there yet. */
const captureLiveFirst = (c: StateComparison) =>
  `Nothing is captured at live (${c.live.ref}, ${c.live.commit}) yet. To compare: check out ${c.live.commit} in a second copy of the project outside this folder (git worktree add <folder> ${c.live.commit}), start the app there on another port with the same data, then call atlas_capture with live: true and that address for each state.`;

/** The state's comparison with live, or null when live's ref does not resolve. */
function versusLive(root: string, state: string): StateComparison | null {
  try {
    return compareState(root, state);
  } catch (error) {
    if (error instanceof AtlasError) return null;
    throw error;
  }
}

/** What an agent is doing, for the viewer's activity line. */
export interface Activity {
  tool: string;
  state?: string;
  phase: "start" | "done" | "failed";
}

/** The Atlas MCP server for one project. The stdio and HTTP transports both use it; `onActivity` reports tool calls to the viewer. */
export function createServer(root: string, onActivity: (activity: Activity) => void = () => {}): McpServer {
  const server = new McpServer({ name: "atlas", version: VERSION }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "atlas_guide",
    {
      title: "How to use Atlas",
      description: "Explains how Atlas works and how to write state recipes. Call it once before your first Atlas task in a session.",
      inputSchema: { topic: z.enum(Object.keys(TOPICS) as [Topic, ...Topic[]]).optional().describe("workflow (default), recipes, capture or compare") },
      annotations: { readOnlyHint: true }
    },
    async ({ topic }) => text(TOPICS[topic ?? "workflow"])
  );
  server.registerTool(
    "atlas_states",
    {
      title: "List states",
      description:
        "List every state recipe in .atlas/states, the recipes that could not be read and why, and the live and branch commits resolved from git. Use it before capturing, and repair any invalid recipe it reports.",
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return text(JSON.stringify(overview(root), null, 2));
      } catch (error) {
        if (error instanceof AtlasError) return { isError: true, ...text(error.message) };
        throw error;
      }
    }
  );
  server.registerTool(
    "atlas_capture",
    {
      title: "Capture a state",
      description:
        "Capture one state at the current commit: a picture and an HTML snapshot for each screen width, saved in .atlas/store. Prepare the state first: run the recipe's setup, start the app, and make a test session if the state needs sign-in. Returns a picture of each width so you can check the result.",
      inputSchema: {
        state: z.string().describe("The recipe id, from atlas_states"),
        baseUrl: z.string().describe("Where you started the app, such as http://localhost:3000"),
        cookies: z
          .array(z.object({ name: z.string(), value: z.string(), path: z.string().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(), sameSite: z.enum(["Strict", "Lax", "None"]).optional() }))
          .optional()
          .describe("The test session cookies, for states that need sign-in"),
        widths: z.array(z.number().int().positive()).optional().describe("Screen widths, if they differ from the recipe and the settings"),
        live: z.boolean().optional().describe("True when baseUrl serves the live ref's code, from a second copy of the project checked out at live. The capture is filed under live's commit")
      }
    },
    async (input) => {
      onActivity({ tool: "atlas_capture", state: input.state, phase: "start" });
      try {
        const result = await capture(root, input);
        onActivity({ tool: "atlas_capture", state: input.state, phase: "done" });
        const versus = input.live ? null : versusLive(root, input.state);
        const summary = {
          state: result.state,
          commit: result.commit,
          branch: result.branch,
          ...(result.uncommitted ? { note: "The project has uncommitted changes, so these captures show more than the commit." } : {}),
          widths: result.widths.map((w) => {
            const cmp = versus?.live.captured ? versus.widths.find((v) => v.width === w.width) : undefined;
            return { width: w.width, changed: w.changed, status: w.entry.status, ...(w.entry.landedOn ? { landedOn: w.entry.landedOn } : {}), ...(cmp ? { againstLive: cmp.status } : {}), png: w.entry.png, html: w.entry.html };
          }),
          ...(versus?.widths.some((w) => w.status === "changed") ? { next: "This state differs from live. Call atlas_compare to see what changed." } : {})
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
            ...result.widths.map((w) => ({ type: "image" as const, data: w.preview.toString("base64"), mimeType: "image/jpeg" }))
          ]
        };
      } catch (error) {
        onActivity({ tool: "atlas_capture", state: input.state, phase: "failed" });
        if (error instanceof AtlasError) return { isError: true, ...text(error.message) };
        throw error;
      }
    }
  );
  server.registerTool(
    "atlas_compare",
    {
      title: "Compare a state with live",
      description:
        "Compare a state's captures at the current commit with its captures at live. Returns each width's status (same, changed, new: no live capture, missing: not captured at this commit), each element that was added, removed, moved or looks different, with its exact box, and pictures of each changed area at live and at this commit. Content that only moved up or down is not a change.",
      inputSchema: { state: z.string().describe("The recipe id, from atlas_states") },
      annotations: { readOnlyHint: true }
    },
    async ({ state }) => {
      try {
        const result = compareState(root, state);
        const summary = {
          state: result.state,
          live: result.live,
          branch: result.branch,
          ...(result.live.captured ? {} : { next: captureLiveFirst(result) }),
          widths: result.widths.map(({ live, branch, ...w }) => w)
        };
        const pictures: { type: "image"; data: string; mimeType: string }[] = [];
        const order: string[] = [];
        for (const w of result.widths) {
          if (w.status !== "changed" || !w.live || !w.branch) continue;
          for (const [n, a] of w.areas.slice(0, MAX_AREA_PICTURES).entries()) {
            // One frame for both pictures, so the agent sees live and this commit side by side at the same place.
            const x = Math.min(a.x, a.live.x) - CROP_MARGIN, width = Math.max(a.x + a.w, a.live.x + a.live.w) - x + CROP_MARGIN;
            const height = Math.min(CROP_MAX_HEIGHT, Math.max(a.h, a.live.h) + 2 * CROP_MARGIN);
            const top = Math.min(a.y, a.live.y) - CROP_MARGIN;
            pictures.push({ type: "image", data: cropPicture(root, w.live, w.width, { x, y: top, w: width, h: height + Math.abs(a.y - a.live.y) }).toString("base64"), mimeType: "image/png" });
            pictures.push({ type: "image", data: cropPicture(root, w.branch, w.width, { x, y: top, w: width, h: height + Math.abs(a.y - a.live.y) }).toString("base64"), mimeType: "image/png" });
            order.push(`${w.width}px area ${n + 1}: live, then this commit`);
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) + (order.length ? `\n\nPictures, in order:\n${order.join("\n")}` : "") }, ...pictures]
        };
      } catch (error) {
        if (error instanceof AtlasError) return { isError: true, ...text(error.message) };
        throw error;
      }
    }
  );
  return server;
}

/** Serves Atlas to one agent over stdio, for clients that start the server themselves. */
export async function serveStdio(root: string): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}
