import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { FlowmapError, type ConfigFile } from "./project.js";

/** The ref the project's remote names as its default branch, such as `origin/main`. */
function defaultLiveRef(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "origin/main";
  } catch {
    return "origin/main";
  }
}

function projectName(root: string): string {
  try {
    const name: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    if (typeof name === "string" && name.length) return name;
  } catch {
    // A project without a readable package.json is named after its folder.
  }
  return basename(root);
}

export interface InitResult {
  root: string;
  config: ConfigFile;
  created: string[];
}

/** Sets up `.flowmap/` in a project: settings, a folder for state recipes, a folder for tasks, and a git-ignored capture store. */
export function init(at: string): InitResult {
  const root = resolve(at);
  const flowmap = join(root, ".flowmap");
  const configFile = join(flowmap, "config.json");
  if (existsSync(configFile)) throw new FlowmapError(`${configFile} already exists.`);
  const created: string[] = [];
  const config: ConfigFile = { name: projectName(root), liveRef: defaultLiveRef(root), widths: [1440, 390] };
  for (const dir of ["states", "tasks"]) {
    mkdirSync(join(flowmap, dir), { recursive: true });
    writeFileSync(join(flowmap, dir, ".gitkeep"), "");
    created.push(join(".flowmap", dir) + "/");
  }
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  created.unshift(join(".flowmap", "config.json"));
  const ignore = join(root, ".gitignore");
  const line = ".flowmap/store/";
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes(line)) {
    appendFileSync(ignore, (current && !current.endsWith("\n") ? "\n" : "") + line + "\n");
    created.push(".gitignore: " + line);
  }
  return { root, config, created };
}
