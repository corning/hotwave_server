import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getTradeStats, getTradePositions } from '@/lib/db';
import { getStockQuote } from '@/lib/stock-data';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 交易统计：累计盈亏（已实现 + 持仓浮动）、买卖笔数、胜率、按策略分组。
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as any;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode')?.trim() || 'paper';
  if (!['paper', 'live'].includes(mode)) {
    return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
  }
  const payload = getTradeStats(auth.userId, mode);

  // 累计盈亏 = 已实现盈亏(sell pnl 之和) + 持仓浮动盈亏(现价-成本价)×持仓量
  // 浮动盈亏随实时行情变化，让累计盈亏"实时"反映当前持仓市值变动。
  const positions = getTradePositions(auth.userId, mode);
  let floatingPnl = 0;
  await Promise.all(
    positions.map(async (p) => {
      try {
        const q = await getStockQuote(p.stockCode);
        if (q.price > 0) floatingPnl += (q.price - p.costPrice) * p.amount;
      } catch {
        // 行情取数失败跳过，不影响已实现盈亏
      }
    }),
  );
  payload.totalPnl = Math.round(((payload.totalPnl || 0) + floatingPnl) * 100) / 100;

  return corsResponse({ ok: true, payload });
}
