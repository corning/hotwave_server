import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { searchStocks } from '@/lib/stock-data';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const q = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (!q) return corsResponse({ ok: true, payload: [] });

  try {
    const payload = await searchStocks(auth.userId, q);
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[stock/search] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
