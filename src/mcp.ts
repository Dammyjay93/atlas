import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { overview } from "./overview.js";
import { AtlasError } from "./project.js";
import { VERSION } from "./version.js";

/** The MCP server agents call. It runs over stdio in the project's root folder. */
export async function serveMcp(root: string): Promise<void> {
  const server = new McpServer({ name: "atlas", version: VERSION });
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
        return { content: [{ type: "text", text: JSON.stringify(overview(root), null, 2) }] };
      } catch (error) {
        if (error instanceof AtlasError) return { isError: true, content: [{ type: "text", text: error.message }] };
        throw error;
      }
    }
  );
  await server.connect(new StdioServerTransport());
}
