import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { NextRequest } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// hotwave 交易路由实盘就绪状态：mode / liveReady / inTradingSession。
// 供前端在「真实账户」tab 判断实盘是否配置（未配置则禁用真实清仓，避免点了才知道不行）。
export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as any;

  try {
    const status = await callHotwave<{
      mode: string;
      liveReady: boolean;
      inTradingSession: boolean;
    }>(auth.userId, 'trader.status');
    return corsResponse({ ok: true, payload: status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return corsResponse({ ok: false, error: `交易状态查询失败：${msg}` }, 502);
  }
}
