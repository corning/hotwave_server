// hotwave 内部数据端点（无鉴权）：热门股票榜单。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// 业务参数（不含任何供应商标识）：
//   type: 'hot'(A股热榜) | 'rise'(涨幅榜) | 'etf'(ETF热榜) | 'hk'(港股) | 'us'(美股) —— 默认 'hot'
//   period: 'hour'|'day' 榜单时间维度；list_type: 'normal'|'skyrocket'|'tech'|'value'|'trend' 榜单风格
//   stock_type: 'a'|'etf'；limit: 返回条数
// 提供 period/list_type/stock_type 任一 → 风格榜单；否则 → 基础榜单。
// 响应: { ok: true, data: [...] } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { get10jqkaRankList, getEastmoneyRankList } from '@/lib/finance-data';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: { type?: string; period?: string; list_type?: string; stock_type?: string; limit?: number };
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const limit = Number(body?.limit) > 0 ? Number(body.limit) : undefined;
  const period = body?.period ? String(body.period) : undefined;
  const listType = body?.list_type ? String(body.list_type) : undefined;
  const stockType = body?.stock_type ? String(body.stock_type) : undefined;

  try {
    // 风格榜单（period/list_type/stock_type 维度）→ 按榜单业务参数请求
    if (period || listType || stockType) {
      const data = await get10jqkaRankList(
        { stock_type: stockType ?? 'a', type: period ?? 'hour', list_type: listType ?? 'normal' },
        limit ?? 20,
      );
      return corsResponse({ ok: true, data });
    }
    // 基础榜单（type 维度）
    const data = await getEastmoneyRankList(String(body?.type ?? 'hot'), limit ?? 20);
    return corsResponse({ ok: true, data });
  } catch (err) {
    console.error('[hotwave/hot] failed:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
