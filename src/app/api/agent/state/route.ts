import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { getRuntimeState } from '@/lib/agent-kernel-bridge';
import type { NextResponse } from 'next/server';

// Agent 运行态（P2 控制面）：手机端状态卡。
// hotwave 未连接时不报 5xx，返回 offline 让 APP 显示"Agent 未运行"。
export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const url = new URL(request.url);
  const sessionKey = url.searchParams.get('sessionKey') || 'main';

  try {
    const useKernel = process.env.CHAT_ENGINE === 'kernel';
    const payload = useKernel
      ? await getRuntimeState()
      : await callHotwave(auth.userId, 'agent.state', { sessionKey });
    return corsResponse({ ok: true, payload }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse(
      { ok: false, error: msg, payload: { status: 'offline', sessionKey } },
      200
    );
  }
}
