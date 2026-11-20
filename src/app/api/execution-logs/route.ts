import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { createExecutionLog, getUserExecutionLogs } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 查询执行日志（用户查自己，mode 筛选 + 分页）。
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as any;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode')?.trim() || '';
  const page = Math.max(Number(params.get('page') || 1), 1);
  const pageSize = Math.min(Math.max(Number(params.get('pageSize') || 10), 1), 100);

  if (mode && !['paper', 'live'].includes(mode)) {
    return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
  }

  const payload = getUserExecutionLogs({
    userId: auth.userId,
    mode: mode || undefined,
    page,
    pageSize,
  });
  return corsResponse({ ok: true, payload });
}

// 写入执行日志（供 hotwave TradeRouter 调用，也支持 JWT）。
export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as any;

  try {
    const body = await request.json();
    const mode = String(body.mode || '').trim();
    const title = String(body.title || '').trim();

    if (!['paper', 'live'].includes(mode)) {
      return corsResponse({ ok: false, error: 'mode must be paper or live' }, 400);
    }
    if (!title) {
      return corsResponse({ ok: false, error: 'title required' }, 400);
    }

    const payload = createExecutionLog({
      userId: auth.userId,
      mode: mode as 'paper' | 'live',
      title,
      description: String(body.description || ''),
      status: (String(body.status || 'pending') as any) || 'pending',
      logType: (String(body.logType || 'system') as any) || 'system',
      tradeId: Number(body.tradeId) || undefined,
      strategyTag: String(body.strategyTag || ''),
    });
    return corsResponse({ ok: true, payload });
  } catch (err) {
    console.error('[execution-logs] create error:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
