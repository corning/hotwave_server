import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { createTrade, getUserTrades } from '@/lib/db';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 用户查询自己的交易记录（按 mode 筛选 + 分页）。
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode')?.trim() || '';
  const stockCode = params.get('stockCode')?.trim() || '';
  const bsType = params.get('bsType')?.trim() || '';
  const page = Math.max(Number(params.get('page') || 1), 1);
  const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 20), 1), 100);

  if (mode && !['paper', 'live'].includes(mode)) {
    return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
  }

  const payload = getUserTrades({
    userId: auth.userId,
    mode: mode || undefined,
    stockCode: stockCode || undefined,
    bsType: bsType || undefined,
    page,
    pageSize,
  });
  return corsResponse({ ok: true, payload });
}

// 记录一笔交易（供 hotwave TradeStore 调用，用 bot 用户 token 鉴权）。
export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const body = await request.json();
    const mode = String(body.mode || '').trim();
    const stockCode = String(body.stockCode || '').trim();
    const bsType = String(body.bsType || '').trim();
    const price = Number(body.price);
    const amount = Number(body.amount);

    if (!['paper', 'live'].includes(mode)) {
      return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
    }
    if (!stockCode) {
      return corsResponse({ ok: false, error: 'stockCode required' }, 400);
    }
    if (!['buy', 'sell'].includes(bsType)) {
      return corsResponse({ ok: false, error: 'bsType must be buy or sell' }, 400);
    }
    if (!Number.isFinite(price) || price <= 0) {
      return corsResponse({ ok: false, error: 'price invalid' }, 400);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return corsResponse({ ok: false, error: 'amount invalid' }, 400);
    }

    const payload = createTrade({
      userId: auth.userId,
      mode: mode as 'paper' | 'live',
      stockCode,
      stockName: String(body.stockName || ''),
      bsType: bsType as 'buy' | 'sell',
      price,
      amount,
      cost: Number(body.cost) || 0,
      total: Number(body.total) || price * amount,
      status: (String(body.status || 'filled')) as any,
      entrustNo: String(body.entrustNo || ''),
      strategyTag: String(body.strategyTag || ''),
      pnl: Number(body.pnl) || 0,
      note: String(body.note || ''),
    });
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[trades] create error:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
