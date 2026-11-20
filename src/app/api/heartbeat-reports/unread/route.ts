import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { countHeartbeatUnreadV2 } from '@/lib/db';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

/**
 * 返回当前用户的 heartbeat（定时简报）未读数。
 * 简报跨用户共享，未读按「该用户最后查看时间」之后的新报告数计算；从未查看计全部。
 */
export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const unread = countHeartbeatUnreadV2(auth.userId);
    return corsResponse({ ok: true, unread }, 200);
  } catch (err) {
    console.error('[heartbeat-reports/unread] 查询失败:', err);
    return corsResponse({ ok: false, error: '查询失败' }, 500);
  }
}
