import { readdirSync, readFileSync } from 'node:fs';

import { repoPath } from '@/lib/server/repo';

// The pinned measurements in docs/evidence, served byte for byte so the landing can link
// its proof. Generated at build time; nothing here reads the network.
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return readdirSync(/*turbopackIgnore: true*/ repoPath('docs', 'evidence'))
    .filter((name) => name.endsWith('.json'))
    .map((file) => ({ file }));
}

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const body = readFileSync(/*turbopackIgnore: true*/ repoPath('docs', 'evidence', file), 'utf8');
  return new Response(body, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
