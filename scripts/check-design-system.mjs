import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = walk('src').filter(p => /\.css$/.test(p));
const tokenFile = join('src', 'design-system', 'tokens.css');
const tokens = new Set([...readFileSync(tokenFile, 'utf8').matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const errors = [];
for (const path of files) {
  const css = readFileSync(path, 'utf8');
  for (const [index, line] of css.split('\n').entries()) {
    const at = `${path}:${index + 1}`;
    if (path !== tokenFile && /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(line)) errors.push(`${at}: color outside tokens`);
    if (path !== tokenFile && /--[\w-]+\s*:/.test(line)) errors.push(`${at}: token redefinition outside tokens`);
    if (/border-radius\s*:/.test(line) && !/border-radius\s*:\s*(var\(--radius\)|inherit)/.test(line)) errors.push(`${at}: corner radius outside tokens`);
    if (/text-transform\s*:\s*uppercase/i.test(line)) errors.push(`${at}: uppercase interface label`);
    const tracking = line.match(/letter-spacing\s*:\s*([\d.]+)(px|em|rem)/i);
    if (tracking && Number(tracking[1]) > 0 && !line.includes('ds-allow-letter-spacing')) errors.push(`${at}: positive interface tracking`);
    for (const m of line.matchAll(/var\((--[\w-]+)/g)) if (!tokens.has(m[1])) errors.push(`${at}: undefined ${m[1]}`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Design system: ${files.length} stylesheets checked; colors, corners, typography and token references are consistent.`);
