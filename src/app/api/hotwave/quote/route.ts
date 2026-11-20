// hotwave 内部数据端点（无鉴权）：个股/指数实时行情报价（含五档盘口、名称）。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: { symbol: 'sh600519' | '600519' | 'sh000001' }
// 响应: { ok: true, data: Quote } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getStockQuote } from '@/lib/stock-data';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: { symbol?: string };
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const symbol = String(body?.symbol || '').trim();
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);
  try {
    const data = await getStockQuote(symbol);
    return corsResponse({ ok: true, data });
  } catch (err) {
    console.error('[hotwave/quote] failed:', symbol, err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
