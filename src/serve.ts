import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp.js";
import { AtlasError } from "./project.js";

export const DEFAULT_PORT = 4317;

export interface Running {
  server: Server;
  port: number;
  url: string;
}

/**
 * Serves Atlas on this computer only: the MCP endpoint at /mcp over streamable HTTP.
 * Each request gets its own MCP server and transport (stateless mode), so agents never share request state.
 * Only localhost host names and origins are accepted, which blocks DNS rebinding from web pages.
 */
export function serve(root: string, port: number = DEFAULT_PORT): Promise<Running> {
  const server = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Atlas serves its MCP endpoint at /mcp.\n");
      return;
    }
    const actual = (server.address() as AddressInfo).port;
    const hosts = ["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${actual}`);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hosts,
      allowedOrigins: hosts.map((h) => `http://${h}`)
    });
    const mcp = createServer(root);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(`Atlas could not answer an MCP request: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new AtlasError(`Port ${port} is in use. Stop the other program, or start Atlas with --port and another number.`) : error)
    );
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual, url: `http://localhost:${actual}/mcp` });
    });
  });
}
