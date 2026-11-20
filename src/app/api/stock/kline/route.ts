import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getStockKline } from '@/lib/stock-data';
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
  const period = params.get('period')?.trim() || 'day';
  const limit = Math.min(Number(params.get('limit') || 320), 800);
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);

  try {
    const payload = await getStockKline(symbol, period, limit);
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[stock/kline] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
