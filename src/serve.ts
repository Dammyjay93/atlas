import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer as createHttpServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Activity } from "./mcp.js";
import { AtlasError } from "./project.js";
import { viewerData } from "./viewer-data.js";

export const DEFAULT_PORT = 4317;
const VIEWER = fileURLToPath(new URL("../viewer/index.html", import.meta.url));
const ICONS = fileURLToPath(new URL("../viewer/icons.json", import.meta.url));
const TYPES: Record<string, string> = { ".png": "image/png", ".html": "text/html; charset=utf-8", ".json": "application/json" };

export interface Agent {
  name: string;
  version: string;
  connectedAt: string;
}

export interface Running {
  server: Server;
  port: number;
  url: string;
  viewer: string;
}

/**
 * Serves Atlas on this computer only:
 * - `/`: the viewer;
 * - `/api/atlas`: what the viewer draws, read fresh on each request;
 * - `/api/events`: a live stream that says when recipes or captures change, and what agents are doing;
 * - `/store/…`: the captured pictures and snapshots;
 * - `/mcp`: the MCP endpoint over streamable HTTP. Each request gets its own MCP server and transport (stateless mode).
 * Only localhost host names and origins are accepted, which blocks DNS rebinding from web pages.
 */
export function serve(root: string, port: number = DEFAULT_PORT): Promise<Running> {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let pending: NodeJS.Timeout | undefined;
  const atlasDir = join(root, ".atlas");
  const watcher = existsSync(atlasDir)
    ? watch(atlasDir, { recursive: true }, () => {
        clearTimeout(pending);
        pending = setTimeout(() => events.emit("update"), 250);
      })
    : null;
  const storeDir = resolve(atlasDir, "store");
  /** Agents that connected since Atlas started, from the name and version they send when they connect. */
  const agents = new Map<string, Agent>();

  const server = createHttpServer(async (req, res) => {
    const actual = (server.address() as AddressInfo).port;
    const hosts = ["localhost", "127.0.0.1", "[::1]"].map((h) => `${h}:${actual}`);
    if (!hosts.includes(req.headers.host ?? "")) return send(res, 403, "text/plain; charset=utf-8", "Atlas answers only on this computer.\n");
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);

    if (path === "/mcp") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: hosts,
        allowedOrigins: hosts.map((h) => `http://${h}`)
      });
      const mcp = createServer(root, (activity: Activity) => events.emit("activity", activity));
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        // In stateless mode each request has its own server, so only the server that answered "initialize" knows the client.
        const client = mcp.server.getClientVersion();
        if (client) {
          agents.set(client.name, { name: client.name, version: client.version, connectedAt: new Date().toISOString() });
          events.emit("update");
        }
      } catch (error) {
        process.stderr.write(`Atlas could not answer an MCP request: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!res.headersSent) send(res, 500, "application/json", JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
      return;
    }
    if (req.method !== "GET") return send(res, 405, "text/plain; charset=utf-8", "Use GET.\n");
    if (path === "/") return send(res, 200, "text/html; charset=utf-8", readFileSync(VIEWER, "utf8"));
    if (path === "/icons.json") return send(res, 200, "application/json", readFileSync(ICONS, "utf8"));
    if (path === "/api/atlas") {
      try {
        return send(res, 200, "application/json", JSON.stringify(viewerData(root, actual, [...agents.values()])));
      } catch (error) {
        return send(res, 500, "application/json", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const onUpdate = () => res.write("event: update\ndata: {}\n\n");
      const onActivity = (a: Activity) => res.write(`event: activity\ndata: ${JSON.stringify(a)}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      events.on("update", onUpdate);
      events.on("activity", onActivity);
      req.on("close", () => {
        clearInterval(ping);
        events.off("update", onUpdate);
        events.off("activity", onActivity);
      });
      return;
    }
    if (path.startsWith("/store/")) {
      const file = resolve(storeDir, "." + path.slice("/store".length));
      if (!file.startsWith(storeDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "text/plain; charset=utf-8", "Not found.\n");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(readFileSync(file));
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "Not found.\n");
  });
  server.on("close", () => watcher?.close());

  return new Promise((done, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      fail(error.code === "EADDRINUSE" ? new AtlasError(`Port ${port} is in use. Stop the other program, or start Atlas with --port and another number.`) : error)
    );
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as AddressInfo).port;
      done({ server, port: actual, url: `http://localhost:${actual}/mcp`, viewer: `http://localhost:${actual}/` });
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type }).end(body);
}
