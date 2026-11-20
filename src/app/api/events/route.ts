import { corsResponse, corsOptions } from '@/lib/cors';
import { resolveDeviceInfo } from '@/lib/middleware';
import { getAuthContext } from '@/lib/auth';
import { recordAppEvents, type AppEventIn } from '@/lib/db';
import type { NextResponse } from 'next/server';

// APP 埋点上报（公开）：客户端（flutter Tracker）批量上报事件。
// 无鉴权 —— 未登录也要埋点（页面浏览 / 设备维度统计）。
// 带有效 JWT 时宽松解析 user_id（无效则按匿名处理，不影响上报）。

const MAX_EVENTS = 50; // 单次上报上限，防止滥用

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  const device = resolveDeviceInfo(request);

  // 宽松解析用户：token 无效 / 缺失都不拒绝上报
  let userId: number | null = null;
  const authHeader = request.headers.get('Authorization');
  const jwtCtx = getAuthContext(authHeader);
  if (jwtCtx) {
    userId = jwtCtx.userId;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json body' }, 400);
  }

  // 兼容两种形态：直接数组 / { events: [...] }
  const raw = Array.isArray(body) ? body : (body as { events?: unknown })?.events;
  if (!Array.isArray(raw)) {
    return corsResponse({ ok: false, error: 'events array required' }, 400);
  }

  const events: AppEventIn[] = raw.slice(0, MAX_EVENTS).map((e) => {
    const ev = (e ?? {}) as Record<string, unknown>;
    return {
      event_type: typeof ev.event_type === 'string' ? ev.event_type : undefined,
      event_name: typeof ev.event_name === 'string' ? ev.event_name : undefined,
      page_path: typeof ev.page_path === 'string' ? ev.page_path : undefined,
      session_id: typeof ev.session_id === 'string' ? ev.session_id : undefined,
      extra: typeof ev.extra === 'string' ? ev.extra : undefined,
    };
  });

  try {
    recordAppEvents(userId, device, events);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[events] record error:', message);
    return corsResponse({ ok: false, error: '记录失败' }, 500);
  }

  return corsResponse({ ok: true, received: events.length }, 200);
}
