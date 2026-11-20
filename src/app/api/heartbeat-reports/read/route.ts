import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { markHeartbeatRead } from '@/lib/db';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

/**
 * 标记当前用户的 heartbeat（定时简报）已读——更新 last_read_at = now。
 * APP 进入简报中心时调用，清零未读红点。
 */
export async function POST(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const lastReadAt = markHeartbeatRead(auth.userId);
    return corsResponse({ ok: true, lastReadAt }, 200);
  } catch (err) {
    console.error('[heartbeat-reports/read] 标记失败:', err);
    return corsResponse({ ok: false, error: '标记失败' }, 500);
  }
}
