import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getHotStocks } from '@/lib/stock-data';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const type = new URL(request.url).searchParams.get('type')?.trim() || 'a';
  const source = new URL(request.url).searchParams.get('source')?.trim() || undefined;
  try {
    const payload = await getHotStocks(auth.userId, type, source);
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[stock/hot] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
