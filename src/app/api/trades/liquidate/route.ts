import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { isAshareTradingSession } from '@/lib/trading-session';
import {
  getTradePositions,
  getTodayBoughtAmount,
  createTrade,
  createExecutionLog,
} from '@/lib/db';
import { getStockQuote } from '@/lib/stock-data';
import { callHotwave } from '@/lib/hotwave-ws-server';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const body = await request.json();
    const mode = String(body.mode || '').trim();
    if (!['paper', 'live'].includes(mode)) {
      return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
    }

    // 交易时段闸（实盘+模拟盘统一）：非 A 股交易时段拒清仓。
    // 与 hotwave src/trader/router.ts:isAshareTradingSession 口径一致（09:25-11:30 / 13:00-15:00）。
    // 实盘清仓经 hotwave router.liquidate 也会再校验一次（无害，且更早返回省一次 RPC）；
    // 模拟盘清仓在 hotwave_server 本地成交、不经 hotwave，必须在此拦截，否则非交易时段可绕过清仓。
    if (!isAshareTradingSession()) {
      return corsResponse({ ok: false, error: '当前非 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00），禁止清仓' }, 400);
    }

    // 真实账户：委托 hotwave 走 EastMoneyTrader 真实券商委托（交易时段闸 + 实盘风控 + 落库 pending）
    // 返回 { liquidated, failed, skipped, submitted }，委托为 pending 待成交确认
    if (mode === 'live') {
      const result = await callHotwave<{
        liquidated: Array<{ stockCode: string; stockName: string; amount: number; price: number; status: string }>;
        failed: Array<{ stockCode: string; error: string }>;
        skipped: Array<{ stockCode: string; reason: string }>;
        submitted: number;
      }>(auth.userId, 'trader.liquidate');
      return corsResponse({ ok: true, payload: result });
    }

    const positions = getTradePositions(auth.userId, mode);
    if (positions.length === 0) {
      return corsResponse({ ok: true, payload: { liquidated: [], skipped: [], totalPnl: 0 } });
    }

    const liquidated: {
      stockCode: string;
      stockName: string;
      amount: number;
      price: number;
      pnl: number;
    }[] = [];

    // T+1 跳过的持仓（当日买入次日可卖），返回前端区分展示，避免笼统报"清仓完成"误导
    const skipped: {
      stockCode: string;
      stockName: string;
      amount: number;
      reason: string;
    }[] = [];

    await Promise.all(
      positions.map(async (pos) => {
        try {
          const quote = await getStockQuote(pos.stockCode);
          const price = quote?.price ?? pos.costPrice;
          const stockName = quote?.name ?? pos.stockCode;

          // T+1：当日买入不可卖。清仓只卖历史持仓（可卖部分），当日买入保留并跳过。
          // 实盘清仓走 hotwave router.liquidate 用券商 enableAmount（已判 T+1），仅模拟盘本地清仓需补此判断。
          const todayBought = getTodayBoughtAmount(auth.userId, mode, pos.stockCode);
          const sellable = pos.amount - todayBought;
          if (sellable <= 0) {
            skipped.push({
              stockCode: pos.stockCode,
              stockName,
              amount: pos.amount,
              reason: 'T+1（今日买入，次日开盘可卖）',
            });
            createExecutionLog({
              userId: auth.userId,
              mode: mode as 'paper' | 'live',
              title: '一键清仓跳过（T+1）',
              description: `${stockName}(${pos.stockCode}) 持仓 ${pos.amount} 股均为今日买入，T+1 不可卖，已跳过（次日开盘后可卖）`,
              status: 'skipped',
              logType: 'risk_control',
              strategyTag: 'liquidate',
            });
            return;
          }

          const pnl = (price - pos.costPrice) * sellable;
          const isPartial = sellable < pos.amount;
          const trade = createTrade({
            userId: auth.userId,
            mode: mode as 'paper' | 'live',
            stockCode: pos.stockCode,
            stockName,
            bsType: 'sell',
            price,
            amount: sellable,
            status: 'filled',
            pnl,
            strategyTag: 'liquidate',
            note: isPartial
              ? `一键清仓（T+1：卖出可卖 ${sellable} 股，当日买入 ${todayBought} 股保留）`
              : '一键清仓',
          });

          createExecutionLog({
            userId: auth.userId,
            mode: mode as 'paper' | 'live',
            title: '一键清仓',
            description: `${stockName}(${pos.stockCode}) 卖出 ${sellable} 股，成交价 ${price.toFixed(2)}，盈亏 ${pnl.toFixed(2)}${isPartial ? `（当日买入 ${todayBought} 股 T+1 保留）` : ''}`,
            status: 'success',
            logType: 'risk_control',
            tradeId: trade?.id,
            strategyTag: 'liquidate',
          });

          liquidated.push({
            stockCode: pos.stockCode,
            stockName,
            amount: sellable,
            price,
            pnl,
          });
        } catch (err) {
          console.error(`[trades/liquidate] failed for ${pos.stockCode}:`, err);
          createExecutionLog({
            userId: auth.userId,
            mode: mode as 'paper' | 'live',
            title: '一键清仓失败',
            description: `${pos.stockCode} 清仓失败: ${String(err)}`,
            status: 'failure',
            logType: 'risk_control',
            strategyTag: 'liquidate',
          });
        }
      }),
    );

    const totalPnl = liquidated.reduce((sum, item) => sum + item.pnl, 0);
    return corsResponse({ ok: true, payload: { liquidated, skipped, totalPnl } });
  } catch (err) {
    console.error('[trades/liquidate] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
