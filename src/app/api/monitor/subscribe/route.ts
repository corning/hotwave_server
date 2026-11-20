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

  let body: { symbol?: string; type?: string };
  try { body = await request.json(); } catch { return corsResponse({ ok: false, error: 'invalid JSON' }, 400); }

  if (!body.symbol) {
    return corsResponse({ ok: false, error: 'symbol required' }, 400);
  }

  const symbol = body.symbol.toLowerCase();
  const type = body.type || 'stock';

  try {
    const result = await callHotwave(auth.userId, 'monitor.subscribe', {
      items: [{
        id: `manual-${symbol}`,
        symbol,
        type,
        interval: 3,
        thresholds: [{
          metric: 'price_change_pct',
          operator: 'gte',
          value: 3,
          level: 'warning',
          message: `[监控] ${symbol} 触发价格波动阈值 3%`,
        }],
      }],
    });
    return corsResponse({ ok: true, payload: result });
  } catch (err) {
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
