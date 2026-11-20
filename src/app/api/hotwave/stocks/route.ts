// hotwave 内部数据端点（无鉴权）：全市场股票+ETF 列表。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: GET /api/hotwave/stocks
// 响应: { ok: true, data: [{symbol,name,ts_code,type}, ...] } | { ok: false, error }
// 数据由 hotwave_server 维护（内存缓存 + 落盘 persistent/all_stocks.json + 每日盘前刷新）。

import { corsOptions, corsResponse } from '@/lib/cors';
import { getStockList } from '@/lib/stock-list';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  try {
    const list = await getStockList();
    return corsResponse({ ok: true, data: list });
  } catch (err) {
    console.error('[hotwave/stocks] failed:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
