import { PROGRAM_ID } from '@/lib/config';
import { readRail } from '@/lib/server/live';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get('mode') === 'live' ? 'live' : 'preview';
  if (mode === 'live' && !PROGRAM_ID) {
    return Response.json(
      { error: 'Live needs a deployed program, and none is configured. Preview reads the same mainnet accounts.' },
      { status: 409 },
    );
  }
  const snapshot = await readRail(mode);
  return Response.json(snapshot, {
    headers: { 'cache-control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=20' },
  });
}
