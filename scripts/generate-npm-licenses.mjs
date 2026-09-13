import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.argv[2] ?? "NPM_THIRD_PARTY_LICENSES.html");
const dependencyPaths = execFileSync(
  "npm",
  ["ls", "--omit=dev", "--parseable", "--all"],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter((path) => path && resolve(path) !== root);

const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const groups = new Map();
const missing = [];
for (const directory of dependencyPaths) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const files = readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|notice)([-_.].*)?$/i.test(basename(name)))
    .sort();
  if (!files.length) {
    missing.push(`${manifest.name}@${manifest.version} (${manifest.license ?? "unknown"})`);
    continue;
  }
  const text = files
    .map((name) => `${name}\n\n${readFileSync(join(directory, name), "utf8").trim()}`)
    .join("\n\n");
  const usedBy = groups.get(text) ?? [];
  usedBy.push(`${manifest.name}@${manifest.version}`);
  groups.set(text, usedBy);
}

if (missing.length) {
  throw new Error(`Dependencies without license text:\n${missing.join("\n")}`);
}

const sections = [...groups.entries()]
  .map(([text, packages]) => ({ text, packages: packages.sort() }))
  .sort((a, b) => a.packages[0].localeCompare(b.packages[0]))
  .map(
    ({ text, packages }) => `
    <section>
      <h2>${escape(packages.join(", "))}</h2>
      <pre>${escape(text)}</pre>
    </section>`,
  )
  .join("\n");

writeFileSync(
  output,
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VLauncher third-party npm licenses</title>
  <style>
    body { font: 14px/1.5 sans-serif; max-width: 960px; margin: 32px auto; padding: 0 20px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #aaa; padding: 16px; }
  </style>
</head>
<body>
  <h1>VLauncher third-party npm licenses</h1>
  <p>npm dependencies used by VLauncher.</p>
${sections}
</body>
</html>
`,
);
console.log(`Wrote ${groups.size} license groups to ${output}`);
