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
import { compareState } from "../src/compare.js";
import type { LayoutItem } from "../src/text-map.js";
import { viewerData } from "../src/viewer-data.js";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** The same order page at live and on the branch; the branch renames the button. */
const order = (button: string) =>
  `<!doctype html><html><body style="margin:0;font:16px sans-serif"><h1 style="margin:24px">Order</h1><p style="margin:24px">Two items</p><div style="height:200px"></div><button style="margin:24px;font:16px sans-serif;padding:8px 16px">${button}</button><footer style="margin:24px">Delivery on Monday</footer></body></html>`;
const servers: Server[] = [];
const start = async (html: string) => {
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
};
let liveUrl: string;
let branchUrl: string;
beforeAll(async () => {
  liveUrl = await start(order("Pay now"));
  branchUrl = await start(order("Pay securely"));
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done())))));

/** A project whose live ref is main, with HEAD one commit ahead on a branch. */
let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "atlas-compare-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "-q", "--allow-empty", "-m", "Live");
  git(project, "checkout", "-q", "-b", "feature");
  git(project, "commit", "-q", "--allow-empty", "-m", "Branch");
  execFileSync("node", [CLI, "init"], { cwd: project });
  const configFile = join(project, ".atlas", "config.json");
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, "utf8")), liveRef: "main" }));
  writeFileSync(join(project, ".atlas", "states", "order.json"), JSON.stringify({ id: "order", name: "Order", route: "/order", widths: [400] }));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const layoutOf = (file: string) => JSON.parse(readFileSync(join(project, file), "utf8")) as LayoutItem[];

describe("compare", () => {
  it("names the elements that changed and outlines each at its exact box", async () => {
    await capture(project, { state: "order", baseUrl: liveUrl, live: true });
    const branch = await capture(project, { state: "order", baseUrl: branchUrl });
    const result = compareState(project, "order");
    expect(result.live).toMatchObject({ ref: "main", captured: true, commit: git(project, "rev-parse", "--short=8", "main") });
    const [width] = result.widths;
    expect(width).toMatchObject({ width: 400, status: "changed" });
    expect(width?.areas).toHaveLength(1);
    const [area] = width?.areas ?? [];
    const button = layoutOf(branch.widths[0]?.entry.layout ?? "").find((t) => t.text === "Pay securely");
    expect(button).toBeDefined();
    if (!area || !button) return;
    expect(area.changes).toEqual([
      { kind: "added", name: "Pay securely", tag: "button", box: { x: button.x, y: button.y, w: button.w, h: button.h } },
      expect.objectContaining({ kind: "removed", name: "Pay now", tag: "button" })
    ]);
    expect({ x: area.x, y: area.y, w: area.w, h: area.h }).toEqual({ x: button.x, y: button.y, w: button.w, h: button.h });
  });

  it("says same when live and the branch look the same", async () => {
    await capture(project, { state: "order", baseUrl: branchUrl, live: true });
    await capture(project, { state: "order", baseUrl: branchUrl });
    expect(compareState(project, "order").widths[0]).toMatchObject({ status: "same", areas: [] });
  });

  it("says new when live has no capture of the state, and missing when this commit has none", async () => {
    expect(compareState(project, "order").widths[0]?.status).toBe("missing");
    await capture(project, { state: "order", baseUrl: branchUrl });
    expect(compareState(project, "order").widths[0]?.status).toBe("new");
  });

  it("gives the viewer each screen's status, its changed areas and live's picture", async () => {
    await capture(project, { state: "order", baseUrl: liveUrl, live: true });
    await capture(project, { state: "order", baseUrl: branchUrl });
    const view = viewerData(project, 4317);
    expect(view.compared).toBe(true);
    const shot = view.shots.order?.["400"];
    expect(shot?.compare?.status).toBe("changed");
    expect(shot?.live?.png).toMatch(/^\/store\/[0-9a-f]{8}\/order\/400\.png$/);
  });
});

describe("atlas_compare", () => {
  it("tells the agent how to capture live, then returns the changes and a picture of each area at live and on the branch", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp", "--root", project] }));
    try {
      await capture(project, { state: "order", baseUrl: branchUrl });
      const before = await client.callTool({ name: "atlas_compare", arguments: { state: "order" } });
      const [first] = before.content as { type: string; text: string }[];
      expect(first?.text).toContain("Nothing is captured at live");
      await capture(project, { state: "order", baseUrl: liveUrl, live: true });
      const after = await client.callTool({ name: "atlas_compare", arguments: { state: "order" } });
      const content = after.content as { type: string; text?: string; mimeType?: string }[];
      expect(content[0]?.text).toContain('"status": "changed"');
      expect(content.filter((c) => c.type === "image" && c.mimeType === "image/png")).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
