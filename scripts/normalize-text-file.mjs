import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.length !== 3) {
  throw new Error("Usage: node scripts/normalize-text-file.mjs FILE");
}

const path = resolve(process.cwd(), process.argv[2]);
const normalized = readFileSync(path, "utf8")
  .replaceAll("\r\n", "\n")
  .replaceAll("\r", "\n")
  .split("\n")
  .map((line) => line.trimEnd())
  .join("\n");
writeFileSync(path, normalized);
