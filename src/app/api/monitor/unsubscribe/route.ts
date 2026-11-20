import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  let body: { symbol?: string };
  try { body = await request.json(); } catch { return corsResponse({ ok: false, error: 'invalid JSON' }, 400); }

  if (!body.symbol) {
    return corsResponse({ ok: false, error: 'symbol required' }, 400);
  }

  const symbol = body.symbol.toLowerCase();

  try {
    // Get current items to find the id for this symbol
    const status = await callHotwave<{ items: Array<{ id: string; symbol: string }> }>(auth.userId, 'monitor.status');
    const items = status.items || [];
    const toRemove = items.filter(i => i.symbol === symbol).map(i => i.id);
    const result = await callHotwave(auth.userId, 'monitor.unsubscribe', { itemIds: toRemove });
    return corsResponse({ ok: true, payload: { removed: toRemove, ...(result as object) } });
  } catch (err) {
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
