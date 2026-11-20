import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

type StockEntry = {
  symbol: string;
  name: string;
  ts_code: string;
  type: number;
};

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim().toLowerCase() || '';

  if (!q || q.length < 1) {
    return corsResponse({ ok: true, payload: [] });
  }

  try {
    const stocks = await callHotwave<StockEntry[]>(auth.userId, 'monitor.search_stocks', { q });
    return corsResponse({ ok: true, payload: stocks });
  } catch (err) {
    console.error('[search-stocks] RPC error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
