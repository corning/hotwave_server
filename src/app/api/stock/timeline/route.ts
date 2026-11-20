import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getStockTimeline } from '@/lib/stock-data';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const params = new URL(request.url).searchParams;
  const symbol = params.get('symbol')?.trim() || '';
  const range = params.get('range')?.trim() || '1d';
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);

  try {
    const payload = await getStockTimeline(symbol, range);
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[stock/timeline] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
