import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { decideRuntimeApproval } from '@/lib/agent-kernel-bridge';

const DECISIONS = ['allow-once', 'allow-always', 'deny'];

// 审批决策（P2）：批准 / 永久批准 / 拒绝。
export async function OPTIONS() {
  return corsOptions();
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth;

  const requestId = params.id;
  if (!requestId) return corsResponse({ ok: false, error: 'requestId required' }, 400);

  let body: { decision?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* ignore */
  }
  const decision = body.decision || '';
  if (!DECISIONS.includes(decision)) {
    return corsResponse(
      { ok: false, error: 'decision must be allow-once | allow-always | deny' },
      400
    );
  }

  try {
    const payload = process.env.CHAT_ENGINE === 'kernel'
      ? await decideRuntimeApproval(requestId)
      : await callHotwave(auth.userId, 'approval.decide', {
          requestId,
          decision,
        });
    return corsResponse({ ok: true, payload }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse({ ok: false, error: msg }, 200);
  }
}
