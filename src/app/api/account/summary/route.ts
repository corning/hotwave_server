import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getStockQuote } from '@/lib/stock-data';
import { getTradePositions, getUserTrades } from '@/lib/db';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 账户资产概览：总资产 / 可用资金 / 持仓市值。
// - paper：以 PAPER_INITIAL_CASH 为初始资金，重放 trades 计算可用现金 + 持仓市值。
// - live：直接向 hotwave 网关查询真实股票账户资产（EastMoneyTrader.getBalance），
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as any;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode')?.trim() || 'paper';
  if (!['paper', 'live'].includes(mode)) {
    return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
  }

  // 真实账户：直取真实股票账号资产，硬失败。
  if (mode === 'live') {
    try {
      const balance = await callHotwave<{
        totalAssets: number;
        availableFunds: number;
        positionMarketValue: number;
      }>(auth.userId, 'trader.balance');
      const round = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
      return corsResponse({
        ok: true,
        payload: {
          mode,
          totalAssets: round(balance.totalAssets),
          availableFunds: round(balance.availableFunds),
          positionMarketValue: round(balance.positionMarketValue),
          floatingPnl: 0,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return corsResponse(
        { ok: false, error: `真实账户资产查询失败：${msg}` },
        502,
      );
    }
  }

  // 模拟账户：以初始资金重放 trades 计算。
  const initialCash = Number(process.env.PAPER_INITIAL_CASH) || 1_000_000;

  // 重放所有 filled 交易，计算当前可用现金。
  const { rows: trades } = getUserTrades({
    userId: auth.userId,
    mode,
    page: 1,
    pageSize: 100_000,
  });

  // 口径须与 hotwave PaperTrader.replay 一致：buy 扣 成交额+手续费，sell 加 成交额-手续费。
  // 历史 bug：仅用 total（纯成交额）导致可用资金比真实多出累计手续费（与 Agent 聊天总资产对不上）。
  let availableFunds = initialCash;
  for (const t of trades) {
    if (t.status !== 'filled') continue;
    const cost = Number(t.cost) || 0;
    if (t.bs_type === 'buy') {
      availableFunds -= (Number(t.total) || 0) + cost;
    } else {
      availableFunds += (Number(t.total) || 0) - cost;
    }
  }

  // 持仓市值 + 浮动盈亏。
  const positions = getTradePositions(auth.userId, mode);
  let positionMarketValue = 0;
  let floatingPnl = 0;
  await Promise.all(
    positions.map(async (p) => {
      try {
        const q = await getStockQuote(p.stockCode);
        if (q.price > 0) {
          positionMarketValue += q.price * p.amount;
          floatingPnl += (q.price - p.costPrice) * p.amount;
        }
      } catch {
        // 行情失败时跳过该票
      }
    }),
  );

  const totalAssets = availableFunds + positionMarketValue;

  return corsResponse({
    ok: true,
    payload: {
      mode,
      initialCash,
      totalAssets: Math.round(totalAssets * 100) / 100,
      availableFunds: Math.round(availableFunds * 100) / 100,
      positionMarketValue: Math.round(positionMarketValue * 100) / 100,
      floatingPnl: Math.round(floatingPnl * 100) / 100,
    },
  });
}
