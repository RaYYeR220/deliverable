/**
 * The app builds on ../sdk through a pnpm link. Its compiled output is not committed,
 * so a fresh checkout (a Vercel build, for one) has to compile it first.
 *
 * It also rebuilds when the SDK's sources are newer than its output. Without that
 * check a local build type-checks against whatever `dist` happened to be lying
 * around, passes, and then fails on a clean checkout with errors nobody saw — which
 * is exactly what happened when the program gained two refusal codes.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sdk');
const built = join(sdk, 'dist', 'index.js');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function stale() {
  if (!existsSync(built)) return 'sdk/dist is missing';
  const sources = Math.max(newestMtime(join(sdk, 'src')), statSync(join(sdk, 'package.json')).mtimeMs);
  return sources > statSync(built).mtimeMs ? 'sdk/src is newer than sdk/dist' : null;
}

const reason = stale();
if (reason) {
  console.log(`${reason}; building the SDK`);
  execSync('pnpm install --frozen-lockfile', { cwd: sdk, stdio: 'inherit' });
  execSync('pnpm build', { cwd: sdk, stdio: 'inherit' });
}
