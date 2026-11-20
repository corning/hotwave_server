// hotwave 内部数据端点（无鉴权，行情数据公开）：沪深主板异动检测。
// 独立路径设计：统一前缀 /api/hotwave/，路径与参数不暴露第三方数据来源。
// mode=pool: 异动票池（涨幅区间 + 市值筛选）
// mode=bigorder: 成交额突增（对比内存上一轮基准）
// 请求: { mode: 'pool'|'bigorder', riseMin?, riseMax?, marketValueMax?, bigOrderMin?, limit? }
// 响应: { ok: true, data: { pool } | { alerts, baseline } } | { ok: false, error }

import { corsOptions, corsResponse } from '@/lib/cors';
import { getAnomalyPool, getBigOrderAlerts } from '@/lib/market-snapshot';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const mode = String(body?.mode || '').trim();
  if (mode !== 'pool' && mode !== 'bigorder') {
    return corsResponse({ ok: false, error: 'mode must be pool or bigorder' }, 400);
  }
  const numOpt = (v: unknown, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const limit = Math.min(Math.floor(numOpt(body?.limit, 20)), 50);

  try {
    if (mode === 'pool') {
      const pool = await getAnomalyPool({
        riseMin: numOpt(body?.riseMin, 6),
        riseMax: numOpt(body?.riseMax, 9.9),
        marketValueMax: numOpt(body?.marketValueMax, 500),
        limit,
      });
      return corsResponse({ ok: true, data: { pool } });
    }
    const { alerts, baseline } = await getBigOrderAlerts({
      bigOrderMin: numOpt(body?.bigOrderMin, 100_000),
      limit,
    });
    return corsResponse({ ok: true, data: { alerts, baseline } });
  } catch (err) {
    console.error('[hotwave/market] failed:', mode, err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
