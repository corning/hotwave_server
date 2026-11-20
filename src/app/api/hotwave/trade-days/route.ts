// hotwave 内部数据端点（无鉴权）：A 股交易日历。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: GET /api/hotwave/trade-days?year=2026（year 缺省为当前北京年）
// 响应: { ok: true, data: { year, total, list: ['YYYY-MM-DD', ...] } } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getTradeDays } from '@/lib/trade-days';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawYear = url.searchParams.get('year');
  const year = rawYear ? Number(rawYear) : new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return corsResponse({ ok: false, error: 'invalid year' }, 400);
  }
  try {
    return corsResponse({ ok: true, data: getTradeDays(year) });
  } catch (err) {
    console.error('[hotwave/trade-days] failed:', year, err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
