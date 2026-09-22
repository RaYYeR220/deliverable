import { readSeries } from '@/lib/server/series';
import { describeFailure } from '@/lib/server/rpc';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await readSeries(), {
      headers: { 'cache-control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=30' },
    });
  } catch (error) {
    return Response.json({ error: describeFailure(error) }, { status: 502 });
  }
}
