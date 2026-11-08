import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../src/capture.js";
import { serve, type Running } from "../src/serve.js";
import { readTasks } from "../src/tasks.js";
import { markBuilding, readVariantSets } from "../src/variants.js";
import { viewerData } from "../src/viewer-data.js";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** One app with three versions of one page behind a switch: /checkout?version=a, b or c. */
const BUTTONS: Record<string, string> = { a: "Pay", b: "Pay now", c: "Continue to payment" };
let app: Server;
let appUrl: string;
beforeAll(async () => {
  app = createServer((req, res) => {
    const version = new URL(req.url ?? "/", "http://x").searchParams.get("version") ?? "a";
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body style="margin:0;font:16px sans-serif"><button style="margin:24px">${BUTTONS[version] ?? "Pay"}</button></body>`);
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  appUrl = `http://localhost:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => app.close(() => done())));

let project: string;
let running: Running;
beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "flowmap-variants-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  git(project, "commit", "-q", "--allow-empty", "-m", "First");
  execFileSync("node", [CLI, "init"], { cwd: project });
  writeFileSync(join(project, ".flowmap", "states", "checkout.json"), JSON.stringify({ id: "checkout", name: "Checkout", route: "/checkout", widths: [400] }));
  running = await serve(project, 0);
});
afterEach(async () => {
  await new Promise<void>((done) => running.server.close(() => done()));
  running.server.closeAllConnections();
  rmSync(project, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: running.port, path, method: "POST", headers: { host: `localhost:${running.port}`, origin: `http://localhost:${running.port}`, "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      }
    );
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });

const captureVersions = async () => {
  for (const name of ["a", "b", "c"]) {
    await capture(project, { state: "checkout", baseUrl: appUrl, variant: { set: "pay-button", name, note: `Version ${name}`, route: `/checkout?version=${name}` } });
  }
};

describe("versions", () => {
  it("captures each version from its own address in the one app, files it under its set, and the viewer shows them", async () => {
    await captureVersions();
    const [set] = readVariantSets(project);
    expect(set?.set).toBe("pay-button");
    expect(set?.options.map((o) => [o.name, o.route, o.commit])).toEqual(["a", "b", "c"].map((n) => [n, `/checkout?version=${n}`, git(project, "rev-parse", "--short=8", "HEAD")]));
    const layout = (n: string) => JSON.parse(readFileSync(join(project, set?.options.find((o) => o.name === n)?.shots.checkout?.["400"]?.layout ?? ""), "utf8")) as { text: string }[];
    expect(layout("c").some((t) => t.text === "Continue to payment")).toBe(true);
    expect(existsSync(join(project, set?.options[0]?.shots.checkout?.["400"]?.png ?? ""))).toBe(true);
    const view = viewerData(project, running.port);
    expect(view.variants[0]?.options.map((o) => o.shots.checkout?.["400"]?.png)).toEqual(["a", "b", "c"].map((n) => `/store/variants/pay-button/${n}/checkout/400.png`));
  });

  it("lists a version as being built from when the agent starts it until its capture", async () => {
    const variant = { set: "pay-button", name: "b", note: "Version b", route: "/checkout?version=b" };
    markBuilding(project, variant, git(project, "rev-parse", "--short=8", "HEAD"), "checkout", true);
    expect(viewerData(project, running.port).variants[0]?.options[0]).toMatchObject({ name: "b", building: { state: "checkout" }, shots: {} });
    await capture(project, { state: "checkout", baseUrl: appUrl, variant });
    const option = viewerData(project, running.port).variants[0]?.options[0];
    expect(option && "building" in option).toBe(false);
    expect(option?.shots.checkout?.["400"]?.png).toBe("/store/variants/pay-button/b/checkout/400.png");
  });

  it("takes a comment on one version, marked on that version's own picture", async () => {
    await captureVersions();
    const made = await post("/api/tasks", { state: "checkout", width: 400, commit: git(project, "rev-parse", "--short=8", "HEAD"), area: { x: 20, y: 20, w: 200, h: 40 }, variant: { set: "pay-button", name: "c" }, words: "Shorter label." });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ variant: { set: "pay-button", name: "c" }, element: { text: "Continue to payment" }, words: 'On version c of "pay-button": Shorter label.' });
  });

  it("turns the person's choice into one task that keeps a version and names the others to remove", async () => {
    await captureVersions();
    const chosen = await post("/api/tasks", { choice: { set: "pay-button", name: "b", width: 400 } });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ state: "checkout", width: 400, status: "open", choice: { set: "pay-button", name: "b", others: ["a", "c"] } });
    expect(String(chosen.body.words)).toContain("remove versions a, c and the switch");
    expect((await post("/api/tasks", { choice: { set: "pay-button", name: "c" } })).body).toMatchObject({ error: 'A version of "pay-button" is already chosen.' });
    expect(readTasks(project).tasks).toHaveLength(1);
  });
});
