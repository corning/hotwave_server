import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getStockQuote } from '@/lib/stock-data';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const raw = new URL(request.url).searchParams.get('symbols')?.trim() || '';
  const symbols = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols.length === 0) {
    return corsResponse({ ok: false, error: 'symbols required' }, 400);
  }

  try {
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const quote = await getStockQuote(symbol);
        return quote;
      }),
    );

    const payload = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter(Boolean);

    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[stock/quote-batch] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 502);
  }
}
