import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const source = join(root, 'assets/brand/icon.svg');
const temporary = mkdtempSync(join(tmpdir(), 'vlauncher-icons-'));
const destination = join(root, 'src-tauri/icons');

try {
  execFileSync(process.execPath, [cli, 'icon', source, '--output', temporary], { cwd: root, stdio: 'inherit' });
  mkdirSync(destination, { recursive: true });
  // Мобильные иконки здесь не нужны.
  for (const entry of readdirSync(temporary, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) {
      copyFileSync(join(temporary, entry.name), join(destination, entry.name));
    }
  }
  const web = join(temporary, 'web');
  execFileSync(process.execPath, [cli, 'icon', source, '--output', web, '--png', '1024'], { cwd: root, stdio: 'inherit' });
  copyFileSync(join(web, '1024x1024.png'), join(root, 'public/vlauncher.png'));
  console.log('Desktop and web icons generated from assets/brand/icon.svg.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
