import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../src/capture.js";
import { check } from "../src/check.js";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** Two pages. The changed app renames the order page's button and leaves the help page alone. */
const page = (body: string) => `<!doctype html><html><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
const pages = (button: string) => ({
  "/order": page(`<h1 style="margin:24px">Order</h1><button style="margin:24px;font:16px sans-serif;padding:8px 16px">${button}</button>`),
  "/help": page(`<h1 style="margin:24px">Help</h1><p style="margin:24px">Write to us.</p>`)
});
const servers: Server[] = [];
const start = async (routes: Record<string, string>) => {
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(routes[req.url ?? "/"] ?? page("Not found")));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};
let beforeUrl: string;
let afterUrl: string;
beforeAll(async () => {
  beforeUrl = await start(pages("Pay now"));
  afterUrl = await start(pages("Pay securely"));
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done())))));

let project: string;
beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "flowmap-check-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  execFileSync("node", [CLI, "init"], { cwd: project });
  for (const [id, route] of [["order", "/order"], ["help", "/help"]]) {
    writeFileSync(join(project, ".flowmap", "states", `${id}.json`), JSON.stringify({ id, name: id, route, widths: [400] }));
  }
  writeFileSync(join(project, "app.txt"), "one");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "First");
  await capture(project, { state: "order", baseUrl: beforeUrl });
  await capture(project, { state: "help", baseUrl: beforeUrl });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const manifestText = () => readFileSync(join(project, ".flowmap", "store", git(project, "rev-parse", "--short=8", "HEAD"), "manifest.json"), "utf8");

describe("check", () => {
  it("compares an uncommitted change with this commit's captures, names what changed, and replaces none of them", async () => {
    const kept = manifestText();
    writeFileSync(join(project, "app.txt"), "two");
    const result = await check(project, { baseUrl: afterUrl });
    expect(result.base?.commit).toBe(git(project, "rev-parse", "--short=8", "HEAD"));
    expect(result.head.uncommitted).toBe(true);
    const order = result.widths.find((w) => w.state === "order"), help = result.widths.find((w) => w.state === "help");
    expect(order?.status).toBe("changed");
    expect(order?.areas.flatMap((a) => a.changes.map((c) => `${c.kind} ${c.name}`))).toEqual(["added Pay securely", "removed Pay now"]);
    expect(help?.status).toBe("same");
    expect(manifestText()).toBe(kept);
  });

  it("compares a committed change with the newest earlier commit that has captures", async () => {
    const first = git(project, "rev-parse", "--short=8", "HEAD");
    writeFileSync(join(project, "app.txt"), "two");
    git(project, "commit", "-qam", "Second");
    const result = await check(project, { baseUrl: afterUrl });
    expect(result.base?.commit).toBe(first);
    expect(result.widths.map((w) => `${w.state} ${w.status}`).sort()).toEqual(["help same", "order changed"]);
  });
});

describe("flowmap_check", () => {
  it("lists the changed screens with pictures of each change before and now", async () => {
    writeFileSync(join(project, "app.txt"), "two");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp", "--root", project] }));
    try {
      const r = await client.callTool({ name: "flowmap_check", arguments: { baseUrl: afterUrl } });
      const content = r.content as { type: string; text?: string }[];
      const summary = JSON.parse((content[0]?.text ?? "").split("\n\nPictures")[0] ?? "{}") as { changed: { state: string }[]; same: string[] };
      expect(summary.changed.map((c) => c.state)).toEqual(["order"]);
      expect(summary.same).toEqual(["help at 400"]);
      expect(content.filter((c) => c.type === "image")).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
