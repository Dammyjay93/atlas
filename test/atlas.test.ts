import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const atlas = (dir: string, ...args: string[]) => execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });

let project: string;

/** A throwaway git project with one commit and a `live` branch standing in for the deployed ref. */
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "atlas-test-"));
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
  writeFileSync(join(project, ".atlas", "states", `${id}.json`), JSON.stringify({ id, name: id.replace("-", " "), route: `/${id}`, ...extra }));

describe("atlas init", () => {
  it("writes settings, recipe and task folders, and ignores the capture store", () => {
    atlas(project, "init");
    const config = JSON.parse(readFileSync(join(project, ".atlas", "config.json"), "utf8"));
    expect(config).toEqual({ name: "shop", liveRef: "origin/main", widths: [1440, 390] });
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".atlas/store/");
  });

  it("refuses to overwrite existing settings", () => {
    atlas(project, "init");
    expect(() => atlas(project, "init")).toThrow(/already exists/);
  });
});

describe("atlas states", () => {
  beforeEach(() => {
    atlas(project, "init");
    const file = join(project, ".atlas", "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), liveRef: "live" }));
  });

  it("lists valid recipes and resolves live and the branch from git", () => {
    recipe("cart", { leadsTo: [{ state: "checkout", action: "Check out" }] });
    recipe("checkout");
    const view = JSON.parse(atlas(project, "states", "--json"));
    const head = git(project, "rev-parse", "--short=8", "HEAD");
    expect(view.states.map((s: { id: string }) => s.id)).toEqual(["cart", "checkout"]);
    expect(view.invalid).toEqual([]);
    expect(view.live).toEqual({ ref: "live", commit: head });
    expect(view.branch).toEqual({ name: "main", commit: head });
  });

  it("reports recipes an agent must repair, and exits with an error", () => {
    recipe("cart", { route: "cart" });
    recipe("checkout", { leadsTo: [{ state: "payment", action: "Pay" }] });
    writeFileSync(join(project, ".atlas", "states", "broken.json"), "{");
    let output = "";
    try {
      atlas(project, "states");
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
    expect(atlas(join(project, "src", "pages"), "states")).toContain("1 state");
  });
});

describe("atlas mcp", () => {
  it("gives agents the atlas_states tool", async () => {
    atlas(project, "init");
    recipe("cart");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp"], cwd: project }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("atlas_states");
      const result = await client.callTool({ name: "atlas_states", arguments: {} });
      const [first] = result.content as { type: string; text: string }[];
      expect(JSON.parse(first?.text ?? "{}").states[0].id).toBe("cart");
    } finally {
      await client.close();
    }
  });
});
