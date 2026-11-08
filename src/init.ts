import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AtlasError, type Config } from "./project.js";

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
  config: Config;
  created: string[];
}

/** Sets up `.atlas/` in a project: settings, a folder for state recipes, a folder for tasks, and a git-ignored capture store. */
export function init(at: string): InitResult {
  const root = resolve(at);
  const atlas = join(root, ".atlas");
  const configFile = join(atlas, "config.json");
  if (existsSync(configFile)) throw new AtlasError(`${configFile} already exists.`);
  const created: string[] = [];
  const config: Config = { name: projectName(root), liveRef: defaultLiveRef(root), widths: [1440, 390] };
  for (const dir of ["states", "tasks"]) {
    mkdirSync(join(atlas, dir), { recursive: true });
    writeFileSync(join(atlas, dir, ".gitkeep"), "");
    created.push(join(".atlas", dir) + "/");
  }
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  created.unshift(join(".atlas", "config.json"));
  const ignore = join(root, ".gitignore");
  const line = ".atlas/store/";
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes(line)) {
    appendFileSync(ignore, (current && !current.endsWith("\n") ? "\n" : "") + line + "\n");
    created.push(".gitignore: " + line);
  }
  return { root, config, created };
}
