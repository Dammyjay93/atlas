import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FlowmapError } from "./project.js";

export const CLIENTS = ["claude", "codex", "cursor"] as const;
export type Client = (typeof CLIENTS)[number];

const onPath = (command: string) => {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const cursorConfig = () => join(homedir(), ".cursor", "mcp.json");

/** How to connect each client to the Flowmap endpoint, and whether the client seems to be installed. */
export function connectInfo(url: string) {
  const config = Buffer.from(JSON.stringify({ url })).toString("base64");
  return {
    url,
    clients: [
      { client: "claude" as const, name: "Claude Code", installed: onPath("claude"), command: `claude mcp add --transport http flowmap ${url}` },
      { client: "codex" as const, name: "Codex", installed: onPath("codex"), command: `codex mcp add flowmap --url ${url}` },
      {
        client: "cursor" as const,
        name: "Cursor",
        installed: existsSync(join(homedir(), ".cursor")),
        command: `cursor://anysphere.cursor-deeplink/mcp/install?name=flowmap&config=${config}`
      }
    ],
    other: { mcpServers: { flowmap: { type: "http", url } } }
  };
}

/**
 * Adds Flowmap to one client's settings. Claude Code and Codex are set through their own commands;
 * Cursor's file is merged, keeping every other server in it.
 */
export function writeClient(client: Client, url: string, cwd: string): string {
  if (client === "claude" || client === "codex") {
    if (!onPath(client)) throw new FlowmapError(`The ${client} command is not installed, so Flowmap cannot add itself to it.`);
    const args = client === "claude" ? ["mcp", "add", "--transport", "http", "flowmap", url] : ["mcp", "add", "flowmap", "--url", url];
    execFileSync(client, args, { cwd, stdio: "inherit" });
    return `Added Flowmap to ${client === "claude" ? "Claude Code" : "Codex"}.`;
  }
  const file = cursorConfig();
  let current: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new FlowmapError(`${file} is not valid JSON, so Flowmap did not change it: ${(error as Error).message}`);
    }
  }
  const next = { ...current, mcpServers: { ...current.mcpServers, flowmap: { type: "http", url } } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return `Added Flowmap to Cursor in ${file}.`;
}
