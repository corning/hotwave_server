/**
 * Agent 运行时桥接（kernel 引擎）
 *
 * 与旧网关的 chat.send 分支保持**完全相同的 { event, payload } 形状**：
 *   { event: 'chat', payload: { sessionKey: 'main', state, text, tool, isError } }
 * state ∈ delta | reasoning | final | thinking | thinking_done
 *
 * 这样 chat/send 路由的落库、心跳、错误、取消逻辑全部无需改动。
 */

const RUNTIME_URL = process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:8791';
const RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN || '';

export type ChatStreamItem = { event: string; payload: any };

/** 健康检查（短超时，避免拖慢请求） */
export async function isRuntimeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(RUNTIME_URL + '/health', {
      signal: AbortSignal.timeout(1500),
      headers: RUNTIME_TOKEN ? { Authorization: 'Bearer ' + RUNTIME_TOKEN } : {},
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

/** 把运行时的 SSE 解析成与网关一致的事件形状 */
export async function* sendKernelStream(
  content: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamItem> {
  const res = await fetch(RUNTIME_URL + '/chat/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(RUNTIME_TOKEN ? { Authorization: 'Bearer ' + RUNTIME_TOKEN } : {}),
    },
    body: JSON.stringify({ content }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error('Agent 运行时返回 ' + res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';

  const toItem = (name: string, data: any): ChatStreamItem | null => {
    switch (name) {
      case 'delta':
        return { event: 'chat', payload: { sessionKey: 'main', state: 'delta', text: data?.content ?? '' } };
      case 'reasoning_delta':
        return { event: 'chat', payload: { sessionKey: 'main', state: 'reasoning', text: data?.text ?? '' } };
      case 'thinking':
        return { event: 'chat', payload: { sessionKey: 'main', state: 'thinking', tool: data?.tool ?? '' } };
      case 'thinking_done':
        return { event: 'chat', payload: { sessionKey: 'main', state: 'thinking_done', tool: data?.tool ?? '', isError: data?.isError === true } };
      case 'final':
        return { event: 'chat', payload: { sessionKey: 'main', state: 'final', text: data?.content ?? '' } };
      case 'error':
        throw new Error(data?.message || 'Agent 运行时错误');
      default:
        return null;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔帧
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const payloadText = line.slice(5).trim();
            if (!payloadText) continue;
            let data: any = {};
            try { data = JSON.parse(payloadText); } catch { continue; }
            const item = toItem(eventName, data);
            if (item) yield item;
          }
        }
        eventName = '';
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ============== 控制面（kernel 引擎） ==============

function authHeaders(): Record<string, string> {
  return RUNTIME_TOKEN ? { Authorization: 'Bearer ' + RUNTIME_TOKEN } : {};
}

async function runtimeJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(RUNTIME_URL + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('runtime HTTP ' + res.status);
  return res.json();
}

/** Agent 运行态 */
export async function getRuntimeState(): Promise<any> {
  return runtimeJson('/state');
}

/** 中断当前 run */
export async function abortRuntimeChat(): Promise<any> {
  return runtimeJson('/chat/abort', { method: 'POST', body: '{}' });
}

/** 待审批列表（always-auto 下通常为空） */
export async function listRuntimeApprovals(): Promise<any[]> {
  const data = await runtimeJson('/approvals');
  return Array.isArray(data?.items) ? data.items : [];
}

/** 审批决策 */
export async function decideRuntimeApproval(id: string): Promise<any> {
  return runtimeJson('/approvals/' + encodeURIComponent(id), { method: 'POST', body: '{}' });
}
