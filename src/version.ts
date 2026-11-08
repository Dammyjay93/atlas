import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
export const VERSION = pkg.version;
/** The npm package's name, which npx takes. Its command is "flowmap". */
export const PACKAGE = pkg.name;
