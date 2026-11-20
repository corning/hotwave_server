import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { removeWatchItem } from '@/lib/db';
import { normalizeStockSymbol } from '@/lib/stock-symbol';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function DELETE(request: NextRequest, { params }: { params: { symbol: string } }) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const symbol = normalizeStockSymbol(decodeURIComponent(params.symbol || ''));
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);

  const ok = removeWatchItem(auth.userId, symbol);
  return corsResponse({ ok });
}
