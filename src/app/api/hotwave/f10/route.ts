// hotwave 内部数据端点（无鉴权）：个股 F10 基本面数据。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: { symbol: '600519.SH', type?: 'base'|'risk'|'hold'|'indicator'|'pepre'|'index'|'board'|'margin' }
//   type 存在 → 原始 F10 数据（8 种数据类型）；type 无 → 摘要版 {profile, finance}
// 响应: { ok: true, data } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getEastmoneyF10 } from '@/lib/eastmoney-data';
import { getEastmoneyF10Raw } from '@/lib/finance-data';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: { symbol?: string; type?: string };
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const symbol = String(body?.symbol || '').trim();
  if (!symbol) return corsResponse({ ok: false, error: 'symbol required' }, 400);
  const type = body?.type ? String(body.type) : undefined;
  try {
    const data = type ? await getEastmoneyF10Raw(type, symbol) : await getEastmoneyF10(symbol);
    return corsResponse({ ok: true, data });
  } catch (err) {
    console.error('[hotwave/f10] failed:', type, symbol, err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
