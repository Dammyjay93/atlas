import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const flowmap = (dir: string, ...args: string[]) => execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });

let project: string;

/** A throwaway git project with one commit and a `live` branch standing in for the deployed ref. */
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "flowmap-test-"));
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.email", "test@example.com");
  git(project, "config", "user.name", "Test");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "shop" }));
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "First");
  git(project, "branch", "live");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const recipe = (id: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(project, ".flowmap", "states", `${id}.json`), JSON.stringify({ id, name: id.replace("-", " "), route: `/${id}`, ...extra }));

describe("flowmap init", () => {
  it("writes settings, recipe and task folders, and ignores the capture store", () => {
    flowmap(project, "init");
    const config = JSON.parse(readFileSync(join(project, ".flowmap", "config.json"), "utf8"));
    expect(config).toEqual({ name: "shop", liveRef: "origin/main", widths: [1440, 390] });
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".flowmap/store/");
  });

  it("refuses to overwrite existing settings", () => {
    flowmap(project, "init");
    expect(() => flowmap(project, "init")).toThrow(/already exists/);
  });
});

describe("flowmap states", () => {
  beforeEach(() => {
    flowmap(project, "init");
    const file = join(project, ".flowmap", "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), liveRef: "live" }));
  });

  it("lists valid recipes and resolves live and the branch from git", () => {
    recipe("cart", { leadsTo: [{ state: "checkout", action: "Check out" }] });
    recipe("checkout");
    const view = JSON.parse(flowmap(project, "states", "--json"));
    const head = git(project, "rev-parse", "--short=8", "HEAD");
    expect(view.states.map((s: { id: string }) => s.id)).toEqual(["cart", "checkout"]);
    expect(view.invalid).toEqual([]);
    expect(view.live).toEqual({ ref: "live", commit: head });
    expect(view.branch).toEqual({ name: "main", commit: head });
  });

  it("reports recipes an agent must repair, and exits with an error", () => {
    recipe("cart", { route: "cart" });
    recipe("checkout", { leadsTo: [{ state: "payment", action: "Pay" }] });
    writeFileSync(join(project, ".flowmap", "states", "broken.json"), "{");
    let output = "";
    try {
      flowmap(project, "states");
    } catch (error) {
      output = (error as { stdout: string }).stdout;
    }
    expect(output).toContain("3 invalid recipes");
    expect(output).toContain("broken.json: not valid JSON");
    expect(output).toContain("cart.json");
    expect(output).toContain('leadsTo names "payment"');
  });

  it("finds the project from a folder inside it", () => {
    recipe("cart");
    mkdirSync(join(project, "src", "pages"), { recursive: true });
    expect(flowmap(join(project, "src", "pages"), "states")).toContain("1 state");
  });
});

/** Starts `flowmap serve` on a free port and returns its endpoint and a way to stop it. */
async function startServe(dir: string) {
  const child = spawn("node", [CLI, "serve", "--port", "0"], { cwd: dir });
  const url = await new Promise<string>((ok, fail) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const match = seen.match(/MCP endpoint: (\S+)/);
      if (match?.[1]) ok(match[1]);
    });
    child.on("exit", (code) => fail(new Error(`flowmap serve exited with ${code}`)));
  });
  return { url, stop: () => child.kill() };
}

describe("flowmap serve", () => {
  it("serves the MCP tools at /mcp on this computer", async () => {
    flowmap(project, "init");
    recipe("cart");
    const { url, stop } = await startServe(project);
    const client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect(client.getInstructions()).toContain("flowmap_guide");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["flowmap_capture", "flowmap_check", "flowmap_compare", "flowmap_guide", "flowmap_states", "flowmap_task_update", "flowmap_tasks", "flowmap_version_start"]);
      const result = await client.callTool({ name: "flowmap_states", arguments: {} });
      const [first] = result.content as { type: string; text: string }[];
      expect(JSON.parse(first?.text ?? "{}").states[0].id).toBe("cart");
    } finally {
      await client.close();
      stop();
    }
  });

  it("refuses requests whose host is not this computer", async () => {
    flowmap(project, "init");
    const { url, stop } = await startServe(project);
    try {
      const { port } = new URL(url);
      const status = await new Promise<number>((ok, fail) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => ok(res.statusCode ?? 0));
        req.on("error", fail);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      });
      expect(status).toBe(403);
    } finally {
      stop();
    }
  });
});

describe("flowmap connect", () => {
  it("shows the setup for each client", () => {
    const text = flowmap(project, "connect", "--port", "5000");
    expect(text).toContain("claude mcp add --transport http flowmap http://localhost:5000/mcp");
    expect(text).toContain("codex mcp add flowmap --url http://localhost:5000/mcp");
    const link = text.match(/cursor:\/\/\S+config=(\S+)/)?.[1] ?? "";
    expect(JSON.parse(Buffer.from(link, "base64").toString())).toEqual({ url: "http://localhost:5000/mcp" });
  });

  it("adds Flowmap to Cursor and keeps the other servers", () => {
    const home = mkdtempSync(join(tmpdir(), "flowmap-home-"));
    try {
      mkdirSync(join(home, ".cursor"));
      writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://example.com/mcp" } } }));
      execFileSync("node", [CLI, "connect", "--write", "cursor"], { cwd: project, env: { ...process.env, HOME: home } });
      const saved = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
      expect(saved.mcpServers).toEqual({ other: { url: "https://example.com/mcp" }, flowmap: { type: "http", url: "http://localhost:4317/mcp" } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("flowmap mcp", () => {
  it("teaches agents through its instructions and flowmap_guide", async () => {
    flowmap(project, "init");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp"], cwd: project }));
    try {
      expect(client.getInstructions()).toContain("flowmap_states");
      const result = await client.callTool({ name: "flowmap_guide", arguments: { topic: "recipes" } });
      const [first] = result.content as { type: string; text: string }[];
      expect(first?.text).toContain("How to write a state recipe");
    } finally {
      await client.close();
    }
  });

  it("gives agents the flowmap_states tool", async () => {
    flowmap(project, "init");
    recipe("cart");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp"], cwd: project }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("flowmap_states");
      const result = await client.callTool({ name: "flowmap_states", arguments: {} });
      const [first] = result.content as { type: string; text: string }[];
      expect(JSON.parse(first?.text ?? "{}").states[0].id).toBe("cart");
    } finally {
      await client.close();
    }
  });
});
