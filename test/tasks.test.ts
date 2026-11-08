import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

let app: Server;
let appUrl: string;
beforeAll(async () => {
  app = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0;font:16px sans-serif"><h1 style="margin:24px">Order</h1><button style="margin:24px;font:16px sans-serif;padding:8px 16px">Pay now</button></body>`)
  );
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  appUrl = `http://localhost:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => app.close(() => done())));

let project: string;
let running: Running;
beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "atlas-tasks-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "-q", "--allow-empty", "-m", "First");
  execFileSync("node", [CLI, "init"], { cwd: project });
  writeFileSync(join(project, ".atlas", "states", "order.json"), JSON.stringify({ id: "order", name: "Order", route: "/order", widths: [400] }));
  await capture(project, { state: "order", baseUrl: appUrl });
  running = await serve(project, 0);
});
afterEach(async () => {
  await new Promise<void>((done) => running.server.close(() => done()));
  running.server.closeAllConnections();
  rmSync(project, { recursive: true, force: true });
});

/** A POST as the viewer's page sends it, or with another origin. */
const post = (path: string, body: unknown, origin: string | null = `http://localhost:${running.port}`) =>
  new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: running.port, path, method: "POST", headers: { host: `localhost:${running.port}`, "content-type": "application/json", ...(origin ? { origin } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      }
    );
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });

const commit = () => git(project, "rev-parse", "--short=8", "HEAD");
const mark = { state: "order", width: 400, area: { x: 20, y: 90, w: 120, h: 50 }, words: "Make Pay now the main button." };

describe("tasks from the viewer", () => {
  it("makes a task from a mark, with the element under it, and takes requests only from the viewer's page", async () => {
    expect((await post("/api/tasks", { ...mark, commit: commit() }, null)).status).toBe(403);
    expect((await post("/api/tasks", { ...mark, commit: commit() }, "http://evil.example")).status).toBe(403);
    expect((await post("/api/tasks", { ...mark, commit: commit(), words: " " })).status).toBe(400);
    const made = await post("/api/tasks", { ...mark, commit: commit() });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ state: "order", status: "open", words: "Make Pay now the main button.", element: { tag: "button", text: "Pay now" } });
    const file = join(project, ".atlas", "tasks", `${String(made.body.id)}.md`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/^---\nid: order-[0-9a-z]+\n[\s\S]*---\n\nMake Pay now the main button\.\n$/);
  });
});

describe("an agent works through a task", () => {
  it("starts it, captures, marks it ready with the after picture, and the person sends it back or approves it", async () => {
    const id = String((await post("/api/tasks", { ...mark, commit: commit() })).body.id);
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: r.isError === true, content: r.content as { type: string; text?: string; mimeType?: string }[] };
      };
      const listed = await call("atlas_tasks", {});
      expect(listed.content[0]?.text).toContain(id);
      expect(listed.content.filter((c) => c.type === "image")).toHaveLength(1);
      expect((await call("atlas_task_update", { id, status: "ready-for-review" })).content[0]?.text).toContain("Capture order");
      expect((await call("atlas_task_update", { id, status: "approved" })).error).toBe(true);
      expect((await call("atlas_task_update", { id, status: "in-progress" })).error).toBe(false);
      await capture(project, { state: "order", baseUrl: appUrl });
      const ready = await call("atlas_task_update", { id, status: "ready-for-review", note: "Pay now is filled." });
      expect(ready.content[0]?.text).toContain('"after"');
      expect((await post(`/api/tasks/${id}`, { status: "sent-back" })).status).toBe(400);
      expect((await post(`/api/tasks/${id}`, { status: "sent-back", note: "Make it full width." })).body).toMatchObject({ status: "sent-back" });
      expect((await call("atlas_tasks", {})).content[0]?.text).toContain("Make it full width.");
      await capture(project, { state: "order", baseUrl: appUrl });
      await call("atlas_task_update", { id, status: "ready-for-review", note: "Full width now." });
      expect((await post(`/api/tasks/${id}`, { status: "approved" })).body).toMatchObject({ status: "approved" });
      expect((await call("atlas_tasks", {})).content[0]?.text).not.toContain(id);
      expect((await call("atlas_tasks", { status: "approved" })).content[0]?.text).toContain(id);
    } finally {
      await client.close();
    }
  });
});
