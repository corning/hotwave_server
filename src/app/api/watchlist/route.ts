import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { addWatchItem, getWatchlist } from '@/lib/db';
import { normalizeStockSymbol, stockMarket } from '@/lib/stock-symbol';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;
  return corsResponse({ ok: true, payload: getWatchlist(auth.userId) });
}

export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const body = await request.json();
    const symbol = normalizeStockSymbol(String(body.symbol || '').trim());
    if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);

    const payload = addWatchItem(auth.userId, {
      symbol,
      name: String(body.name || ''),
      market: String(body.market || stockMarket(symbol)),
      type: String(body.type || 'stock'),
      note: String(body.note || ''),
    });
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[watchlist] add error:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
