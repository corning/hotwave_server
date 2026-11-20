import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { abortRuntimeChat } from '@/lib/agent-kernel-bridge';

// 中断当前 run（P2）：手机端「停止」按钮。
// 语义：终止 agent loop，保留已生成内容（SSE 侧会收到 error/final 收尾）。
export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth;

  let body: { sessionKey?: string; runId?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* 允许空 body */
  }

  try {
    const payload = process.env.CHAT_ENGINE === 'kernel'
      ? await abortRuntimeChat()
      : await callHotwave(auth.userId, 'chat.abort', {
          sessionKey: body.sessionKey || 'main',
          runId: body.runId,
        });
    return corsResponse({ ok: true, payload }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse({ ok: false, error: msg }, 200);
  }
}
