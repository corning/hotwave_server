import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { listRuntimeApprovals } from '@/lib/agent-kernel-bridge';
import type { NextResponse } from 'next/server';

// 待审批列表（P2）：审批的真相源是 hotwave 内存桥（5 分钟 TTL），不落库。
export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const payload = process.env.CHAT_ENGINE === 'kernel'
      ? { approvals: await listRuntimeApprovals() }
      : await callHotwave(auth.userId, 'approval.list');
    return corsResponse({ ok: true, payload }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse({ ok: false, error: msg, payload: { approvals: [] } }, 200);
  }
}
