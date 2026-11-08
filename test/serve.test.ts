import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../src/capture.js";
import { serve, type Running } from "../src/serve.js";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** Raw GET with a chosen Host header and an unnormalised path, which fetch would rewrite. */
const get = (port: number, path: string, host = `localhost:${port}`) =>
  new Promise<{ status: number; type: string; body: string }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
    });
    req.on("error", fail);
    req.end();
  });

let app: Server;
let appUrl: string;
beforeAll(async () => {
  app = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><h1>${req.url}</h1>`));
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  appUrl = `http://localhost:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => app.close(() => done())));

let project: string;
let running: Running;
beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "atlas-serve-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "-q", "--allow-empty", "-m", "First");
  execFileSync("node", [CLI, "init"], { cwd: project });
  const recipe = (r: Record<string, unknown>) => writeFileSync(join(project, ".atlas", "states", `${r.id}.json`), JSON.stringify({ widths: [400], ...r }));
  recipe({ id: "cart", name: "Cart", page: "Shop", route: "/cart", leadsTo: [{ state: "checkout", action: "Check out" }] });
  recipe({ id: "checkout", name: "Checkout", page: "Shop", route: "/checkout" });
  running = await serve(project, 0);
});
afterEach(async () => {
  await new Promise<void>((done) => running.server.close(() => done()));
  running.server.closeAllConnections();
  rmSync(project, { recursive: true, force: true });
});

describe("the viewer's data", () => {
  it("lists recipes and the newest captures, with how far they are behind HEAD", async () => {
    await capture(project, { state: "cart", baseUrl: appUrl });
    const res = await get(running.port, "/api/atlas");
    const view = JSON.parse(res.body);
    expect(view.states.map((s: { id: string }) => s.id)).toEqual(["cart", "checkout"]);
    expect(view.shown).toEqual({ commit: git(project, "rev-parse", "--short=8", "HEAD"), behind: 0 });
    expect(view.shots.cart["400"].height).toBe(844);
    expect(view.shots.checkout).toBeUndefined();
    const png = await get(running.port, view.shots.cart["400"].png);
    expect(png).toMatchObject({ status: 200, type: "image/png" });
    git(project, "commit", "-q", "--allow-empty", "-m", "Second");
    expect(JSON.parse((await get(running.port, "/api/atlas")).body).shown.behind).toBe(1);
  });

  it("serves only files inside the capture store", async () => {
    expect((await get(running.port, "/store/%2e%2e/config.json")).status).toBe(404);
  });

  it("answers only when the host is this computer", async () => {
    expect((await get(running.port, "/api/atlas", "evil.example")).status).toBe(403);
  });

  it("lists each agent that connects over MCP", async () => {
    expect(JSON.parse((await get(running.port, "/api/atlas")).body).agents).toEqual([]);
    const client = new Client({ name: "test-agent", version: "1.2.3" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    await client.close();
    const { agents } = JSON.parse((await get(running.port, "/api/atlas")).body);
    expect(agents).toMatchObject([{ name: "test-agent", version: "1.2.3" }]);
  });

  it("serves the viewer and its icons", async () => {
    expect((await get(running.port, "/")).body).toContain("<title>Atlas</title>");
    expect(JSON.parse((await get(running.port, "/icons.json")).body)["monitor-linear"]).toContain("<path");
  });
});

describe("the live stream", () => {
  it("tells the viewer when a recipe or a capture changes", async () => {
    const seen = await new Promise<string>((done, fail) => {
      const req = request({ host: "127.0.0.1", port: running.port, path: "/api/events", headers: { host: `localhost:${running.port}` } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          text += c.toString();
          if (text.includes(": connected")) writeFileSync(join(project, ".atlas", "states", "cart.json"), JSON.stringify({ id: "cart", name: "Basket", route: "/cart" }));
          if (text.includes("event: update")) {
            req.destroy();
            done(text);
          }
        });
      });
      req.on("error", (error) => (error.message.includes("aborted") ? undefined : fail(error)));
      req.end();
    });
    expect(seen).toContain("event: update");
  });
});

describe("atlas with no command", () => {
  it("sets up a new project and starts Atlas", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "atlas-start-"));
    try {
      git(fresh, "init", "-q", "-b", "main");
      const child = spawn("node", [CLI, "--port", "0", "--no-open"], { cwd: fresh });
      const text = await new Promise<string>((done, fail) => {
        let seen = "";
        child.stdout.on("data", (c: Buffer) => {
          seen += c.toString();
          if (seen.includes("Press Ctrl+C")) done(seen);
        });
        child.on("exit", (code) => fail(new Error(`atlas exited with ${code}: ${seen}`)));
      });
      child.kill();
      expect(text).toContain("Set up Atlas in");
      expect(text).toMatch(/is running at http:\/\/localhost:\d+\//);
      expect(text).toContain("claude mcp add --transport http atlas");
      expect(existsSync(join(fresh, ".atlas", "config.json"))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
