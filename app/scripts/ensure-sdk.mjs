/**
 * The app builds on ../sdk through a pnpm link. Its compiled output is not committed,
 * so a fresh checkout (a Vercel build, for one) has to compile it first. A local
 * checkout that already has sdk/dist is left alone.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sdk');
if (!existsSync(join(sdk, 'dist', 'index.js'))) {
  console.log('sdk/dist is missing; building the SDK');
  execSync('pnpm install --frozen-lockfile', { cwd: sdk, stdio: 'inherit' });
  execSync('pnpm build', { cwd: sdk, stdio: 'inherit' });
}
