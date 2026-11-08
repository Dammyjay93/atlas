import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  return server;
}

/** Serves Atlas to one agent over stdio, for clients that start the server themselves. */
export async function serveStdio(root: string): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}
