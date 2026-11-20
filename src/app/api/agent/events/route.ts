import { corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave, subscribeHotwaveEvents } from '@/lib/hotwave-ws-server';
import { getRuntimeState, listRuntimeApprovals } from '@/lib/agent-kernel-bridge';

// Agent 控制面事件流（P2，SSE）：
// 推送 approval.request / approval.resolved / agent_state，供手机端审批中心与状态卡实时刷新。
export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth;

  const encoder = new TextEncoder();
  const userId = auth.userId;
  const sessionKey = new URL(request.url).searchParams.get('sessionKey') || 'main';

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              'event: ' + event + '\ndata: ' + JSON.stringify(data ?? {}) + '\n\n'
            )
          );
        } catch {
          /* stream may be closed */
        }
      };

      // 数据源须与 chat 执行体一致：kernel 引擎下 chat 跑在 runtime(:8791)，
      // 若这里仍读网关 RPC，会出现"正在流式输出但状态卡显示 idle"。
      const useKernel = process.env.CHAT_ENGINE === 'kernel';
      const pushState = async () => {
        try {
          const s = useKernel
            ? await getRuntimeState()
            : await callHotwave(userId, 'agent.state', { sessionKey });
          send('agent_state', s);
        } catch {
          send('agent_state', { status: 'offline', sessionKey });
        }
        try {
          const a = useKernel
            ? { approvals: await listRuntimeApprovals() }
            : await callHotwave(userId, 'approval.list');
          send('approval_list', a);
        } catch {
          send('approval_list', { approvals: [] });
        }
      };

      send('ready', { sessionKey, at: Date.now() });
      await pushState();

      const unsubscribe = subscribeHotwaveEvents(userId, (event, payload) => {
        if (event === 'approval.request') {
          send('approval_request', payload);
          void pushState();
        } else if (event === 'approval.resolved') {
          send('approval_resolved', payload);
          void pushState();
        }
      });

      // 心跳注释帧：防反向代理/移动网络空闲断链
      const timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* ignore */
        }
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      try {
        request.signal.addEventListener('abort', cleanup);
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
