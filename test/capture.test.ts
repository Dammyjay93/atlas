import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { capture } from "../src/capture.js";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** A tiny app with the cases capture must handle: a stylesheet, a click, sign-in, a redirect and the clock. */
const page = (body: string, head = "") => `<!doctype html><html><head><link rel="stylesheet" href="/style.css">${head}</head><body>${body}</body></html>`;
let app: Server;
let baseUrl: string;
beforeAll(async () => {
  app = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (url.pathname === "/style.css") return res.writeHead(200, { "content-type": "text/css" }).end("h1 { color: rgb(10, 20, 30); font: 600 32px sans-serif; }");
    if (url.pathname === "/cart") return html(page(`<h1>Cart</h1><button onclick="document.querySelector('p').textContent='Code applied'">Apply</button><p>No code</p>`));
    if (url.pathname === "/account") {
      if ((req.headers.cookie ?? "").includes("sid=good")) return html(page("<h1>Welcome back</h1>"));
      return res.writeHead(302, { location: "/sign-in" }).end();
    }
    if (url.pathname === "/sign-in") return html(page("<h1>Sign in</h1>"));
    if (url.pathname === "/time") return html(page(`<h1 id="t"></h1><script>document.getElementById("t").textContent = new Date().toISOString()</script>`));
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  baseUrl = `http://localhost:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => app.close(() => done())));

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "flowmap-capture-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "-q", "--allow-empty", "-m", "First");
  execFileSync("node", [CLI, "init"], { cwd: project });
  const recipe = (r: Record<string, unknown>) => writeFileSync(join(project, ".flowmap", "states", `${r.id}.json`), JSON.stringify({ widths: [400], ...r }));
  recipe({ id: "cart", name: "Cart", route: "/cart" });
  recipe({ id: "cart-code", name: "Cart with a code", route: "/cart", steps: [{ click: "button" }, { waitFor: "text=Code applied" }] });
  recipe({ id: "account", name: "Account", route: "/account" });
  recipe({ id: "clock", name: "Clock", route: "/time" });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const commit = () => git(project, "rev-parse", "--short=8", "HEAD");
/** The one width these recipes capture. */
const only = (result: { widths: { entry: { png: string; html: string; hash: string; landedOn?: string }; changed: boolean }[] }) => {
  const [first] = result.widths;
  if (!first) throw new Error("capture returned no widths");
  return first;
};
const snapshot = (result: Parameters<typeof only>[0]) => readFileSync(join(project, only(result).entry.html), "utf8");

describe("capture", () => {
  it("saves a picture and a self-contained snapshot, and gives the same picture on the next run", async () => {
    const first = await capture(project, { state: "cart", baseUrl });
    const again = await capture(project, { state: "cart", baseUrl });
    expect(first.commit).toBe(commit());
    expect(only(first).changed).toBe(true);
    expect(only(again).changed).toBe(false);
    expect(only(again).entry.hash).toBe(only(first).entry.hash);
    expect(existsSync(join(project, only(first).entry.png))).toBe(true);
    const html = snapshot(first);
    expect(html).toContain("rgb(10, 20, 30)");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('rel="stylesheet"');
    const manifest = JSON.parse(readFileSync(join(project, ".flowmap", "store", commit(), "manifest.json"), "utf8"));
    expect(Object.keys(manifest.states.cart)).toEqual(["400"]);
  });

  it("runs the recipe's steps before capturing", async () => {
    const result = await capture(project, { state: "cart-code", baseUrl });
    expect(snapshot(result)).toContain("Code applied");
  });

  it("uses the session cookies, and reports where the app redirected without them", async () => {
    const outside = await capture(project, { state: "account", baseUrl });
    expect(only(outside).entry.landedOn).toBe("/sign-in");
    const inside = await capture(project, { state: "account", baseUrl, cookies: [{ name: "sid", value: "good" }] });
    expect(only(inside).entry.landedOn).toBeUndefined();
    expect(snapshot(inside)).toContain("Welcome back");
  });

  it("sets secure __Host- session cookies on a plain http localhost app", async () => {
    const inside = await capture(project, { state: "account", baseUrl, cookies: [{ name: "__Host-sid", value: "good" }] });
    expect(only(inside).entry.landedOn).toBeUndefined();
    expect(snapshot(inside)).toContain("Welcome back");
  });

  it("freezes the page's clock at the time in the settings", async () => {
    const file = join(project, ".flowmap", "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), time: "2026-01-02T03:04:05.000Z" }));
    const result = await capture(project, { state: "clock", baseUrl });
    expect(snapshot(result)).toContain("2026-01-02T03:04:05.000Z");
  });

  it("marks captures made with uncommitted changes", async () => {
    writeFileSync(join(project, "app.js"), "change");
    expect((await capture(project, { state: "cart", baseUrl })).uncommitted).toBe(true);
  });

  it("names the recipes when the state does not exist", async () => {
    await expect(capture(project, { state: "basket", baseUrl })).rejects.toThrow(/No valid recipe with id "basket"\. Recipes: account, cart, cart-code, clock/);
  });
});

describe("flowmap_capture", () => {
  it("returns the summary and a picture the agent can look at", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp"], cwd: project }));
    try {
      const result = await client.callTool({ name: "flowmap_capture", arguments: { state: "cart", baseUrl } });
      const content = result.content as { type: string; text?: string; mimeType?: string }[];
      expect(JSON.parse(content[0]?.text ?? "{}").widths[0].width).toBe(400);
      expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    } finally {
      await client.close();
    }
  });
});
