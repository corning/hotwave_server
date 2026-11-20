// hotwave 内部数据端点（无鉴权）：全市场股票+ETF 列表搜索（供 monitor.search_stocks）。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 请求: GET /api/hotwave/stocks/search?q=xxx（代码前缀 / 名称，最多返回 30 条）
// 响应: { ok: true, data: [{symbol,name,ts_code,type}, ...] } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getStockList } from '@/lib/stock-list';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return corsResponse({ ok: true, data: [] });
  try {
    const list = await getStockList();
    const matched = list.filter(
      (s) => s.symbol.includes(q) || s.name.replace(/\s/g, '').toLowerCase().includes(q),
    );
    return corsResponse({ ok: true, data: matched.slice(0, 30) });
  } catch (err) {
    console.error('[hotwave/stocks/search] failed:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
