import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { capture } from "./capture.js";
import { INSTRUCTIONS, TOPICS, type Topic } from "./guide.js";
import { overview } from "./overview.js";
import { AtlasError } from "./project.js";
import { VERSION } from "./version.js";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** The Atlas MCP server for one project. The stdio and HTTP transports both use it. */
export function createServer(root: string): McpServer {
  const server = new McpServer({ name: "atlas", version: VERSION }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "atlas_guide",
    {
      title: "How to use Atlas",
      description: "Explains how Atlas works and how to write state recipes. Call it once before your first Atlas task in a session.",
      inputSchema: { topic: z.enum(Object.keys(TOPICS) as [Topic, ...Topic[]]).optional().describe("workflow (default) or recipes") },
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
        widths: z.array(z.number().int().positive()).optional().describe("Screen widths, if they differ from the recipe and the settings")
      }
    },
    async (input) => {
      try {
        const result = await capture(root, input);
        const summary = {
          state: result.state,
          commit: result.commit,
          branch: result.branch,
          ...(result.uncommitted ? { note: "The project has uncommitted changes, so these captures show more than the commit." } : {}),
          widths: result.widths.map((w) => ({ width: w.width, changed: w.changed, status: w.entry.status, ...(w.entry.landedOn ? { landedOn: w.entry.landedOn } : {}), png: w.entry.png, html: w.entry.html }))
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
            ...result.widths.map((w) => ({ type: "image" as const, data: w.preview.toString("base64"), mimeType: "image/jpeg" }))
          ]
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
