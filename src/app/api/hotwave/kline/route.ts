// hotwave 内部数据端点（无鉴权，行情数据公开）：日 K 线（前复权）。
// 独立路径设计：每类数据一个端点，统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: { symbol: '600519' | '600519.SH' | 'sh600519', days?: number }
// 响应: { ok: true, data: KlineRow[] } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getStockKline } from '@/lib/stock-data';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: { symbol?: string; days?: number };
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const symbol = String(body?.symbol || '').trim();
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);
  const days = Number(body?.days) > 0 ? Number(body.days) : undefined;
  try {
    const data = await getStockKline(symbol, 'day', days ?? 60);
    return corsResponse({ ok: true, data });
  } catch (err) {
    console.error('[hotwave/kline] failed:', symbol, err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
