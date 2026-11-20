/**
 * hotwave 长连接 WS server（反向调用模式）
 *
 * hotwave 用 TRADE_BINDING_ID/SECRET 主动连入本 server（默认 :18791），建立长连接。
 * hotwave_server 通过该连接下发 RPC（chat.send、monitor.*、trader.balance），
 * hotwave 通过该连接上行 event（chat delta/monitor.alert/monitor.status_change）。
 *
 * 历史实现中本服务曾主动连接 hotwave gateway；现在方向反转：
 * hotwave=client 主动连接 hotwave_server，hotwave_server 复用该连接反向调用 hotwave，
 * 不再依赖 hotwave gateway 在线。
 *
 * 协议复用 hotwave/src/gateway/protocol.ts 的 req/res/event 帧（方向反转）。
 * 认证：hotwave_server 发 connect.challenge -> hotwave 回 connect req（bindingId/Secret/nonce）
 *       -> verifyBinding -> res ok（绑定 user_id）。
 */

import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { verifyBinding, getBindingByBindingId } from './db';

/** 认证失败信息保留窗口：hotwave client 30s 退避重连，失败会持续刷新；超窗视为已停止尝试 */
const AUTH_FAILURE_FRESH_MS = 60_000;

const HOTWAVE_WS_PORT = parseInt(process.env.HOTWAVE_WS_PORT || '18791', 10);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000; // 流式 RPC 空闲超时（无 event）。glm-5.2 extended thinking 思考久（偶发 retry），90s 易误杀 -> 300s

// ============== 帧类型（对齐 gateway protocol.ts） ==============

type RequestFrame = {
  type: 'req';
  id: string;
  method: string;
  params?: any;
};
type ResponseFrame = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: any;
  error?: { code: string; message: string };
};
type EventFrame = {
  type: 'event';
  event: string;
  payload?: any;
  seq: number;
};

function isRequestFrame(f: any): f is RequestFrame {
  return f && f.type === 'req' && typeof f.id === 'string' && typeof f.method === 'string';
}
function isResponseFrame(f: any): f is ResponseFrame {
  return f && f.type === 'res' && typeof f.id === 'string' && typeof f.ok === 'boolean';
}
function isEventFrame(f: any): f is EventFrame {
  return f && f.type === 'event' && typeof f.event === 'string';
}

function send(ws: WebSocket, frame: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

function respond(
  ws: WebSocket,
  id: string,
  ok: boolean,
  payload?: any,
  error?: { code: string; message: string }
) {
  send(ws, { type: 'res', id, ok, payload, error });
}

// ============== 上行 event 订阅（monitor.alert 等 -> SSE 推送） ==============

type EventSubscriber = (event: string, payload: any) => void;
// 与 hotwaveConnections 同理：必须挂到 globalThis。
// Next.js 生产构建下 instrumentation（await import）与 API route（静态 import）
// 可能各自实例化本模块；若订阅表只在模块作用域，事件会写进"另一个实例"的表里而静默丢失。
const g0 = globalThis as any;
const eventSubscribers: Map<number, Set<EventSubscriber>> =
  g0.__hotwaveEventSubscribers ?? (g0.__hotwaveEventSubscribers = new Map());

/**
 * 订阅指定 user 的上行 event（如 monitor.alert），返回取消订阅函数。
 * 供 monitor/alerts SSE 端点使用：hotwave 上行 event -> 落库 + 推 SSE。
 */
export function subscribeHotwaveEvents(userId: number, fn: EventSubscriber): () => void {
  if (!eventSubscribers.has(userId)) eventSubscribers.set(userId, new Set());
  eventSubscribers.get(userId)!.add(fn);
  return () => {
    eventSubscribers.get(userId)?.delete(fn);
  };
}

function emitUpstreamEvent(userId: number, event: string, payload: any) {
  const subs = eventSubscribers.get(userId);
  if (subs) for (const fn of subs) {
    try {
      fn(event, payload);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

// ============== 流式 RPC 通道 ==============

interface PendingRpc {
  resolve: (payload: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 流式 RPC 通道：hotwave_server 发 chat.send req，hotwave 回流式 event + 最终 res。
 * 迁移自 HotwaveAgentBridge.send() 的流式可靠性（buffer + notify + 空闲超时）。
 */
class PendingStream {
  buffer: { event: string; payload: any }[] = [];
  resolveWait: (() => void) | null = null;
  done = false;
  error: Error | null = null;
  lastEventMs = Date.now();
  timer: ReturnType<typeof setInterval> | null = null;

  constructor(public reqId: string, public userId: number) {}

  push(event: string, payload: any) {
    if (this.done) return;
    this.lastEventMs = Date.now();
    this.buffer.push({ event, payload });
    this.notify();
  }

  finish(err?: Error) {
    if (this.done) return;
    this.done = true;
    if (err) this.error = err;
    if (this.timer) clearInterval(this.timer);
    this.notify();
  }

  private notify() {
    const r = this.resolveWait;
    this.resolveWait = null;
    r?.();
  }
}

// ============== 连接管理器 ==============

class HotwaveConnectionManager {
  /** userId -> WebSocket（一 user 一 hotwave 连接） */
  private connections = new Map<number, WebSocket>();
  /** reqId -> 普通 RPC pending */
  private pending = new Map<string, PendingRpc>();
  /** reqId -> 流式 RPC pending */
  private pendingStreams = new Map<string, PendingStream>();
  /** userId -> 活跃流式 RPC reqId（一 user 一活跃 chat 流，sessionKey='main' 不并发） */
  private activeStreamByUser = new Map<number, string>();
  /** 最近一次绑定认证失败（hotwave client 连入被拒），离线时给出可诊断原因而非笼统「hotwave 离线」 */
  lastAuthFailure: { bindingId: string; reason: string; at: number } | null = null;

  recordAuthFailure(bindingId: string, reason: string) {
    this.lastAuthFailure = { bindingId, reason, at: Date.now() };
  }

  /** 认证成功后清除，避免把历史失败误报为新问题 */
  clearAuthFailure() {
    this.lastAuthFailure = null;
  }

  /** 离线原因描述：认证失败仍新鲜时优先给出诊断详情（引导用户重新绑定），否则通用文案 */
  offlineMessage(): string {
    const f = this.lastAuthFailure;
    if (f && Date.now() - f.at < AUTH_FAILURE_FRESH_MS) {
      return `hotwave 离线：绑定认证失败（binding_id=${f.bindingId || '空'}，${f.reason}）。请解绑后重新绑定，并同步 hotwave/.env 的 TRADE_BINDING_ID/SECRET`;
    }
    return 'hotwave 离线';
  }

  register(userId: number, ws: WebSocket) {
    const old = this.connections.get(userId);
    if (old && old.readyState === WebSocket.OPEN && old !== ws) {
      try {
        old.close(4002, 'replaced by new connection');
      } catch {
        /* ignore */
      }
    }
    this.connections.set(userId, ws);
    console.log(`[HotwaveWS] user=${userId} hotwave 已连接`);
  }

  unregister(userId: number, ws: WebSocket) {
    if (this.connections.get(userId) !== ws) return;
    this.connections.delete(userId);
    // 清理该 user 的活跃流式 RPC
    const reqId = this.activeStreamByUser.get(userId);
    if (reqId) {
      const s = this.pendingStreams.get(reqId);
      s?.finish(new Error('hotwave 连接已断开'));
      this.pendingStreams.delete(reqId);
      this.activeStreamByUser.delete(userId);
    }
    console.log(`[HotwaveWS] user=${userId} hotwave 已断开`);
  }

  isConnected(userId: number): boolean {
    const ws = this.connections.get(userId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /** 是否有任意 hotwave 连接接入（agent 列表状态用） */
  anyConnected(): boolean {
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /** 反向 RPC：hotwave_server -> hotwave 发 req，等 res（带超时） */
  sendReq(userId: number, method: string, params?: any): Promise<any> {
    const ws = this.connections.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(this.offlineMessage()));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`RPC 超时: ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      send(ws, { type: 'req', id, method, params });
    });
  }

  /**
   * 流式反向 RPC：chat.send 等。hotwave 回流式 event（chat delta/reasoning/thinking 等）
   * + 最终 res。迁移自 HotwaveAgentBridge.send() 的流式可靠性（buffer + notify + 90s 空闲超时）。
   *
   * 注意：gateway 协议 event 帧不带 reqId，用 sessionKey/runId 关联。这里按"一 user 一活跃
   * chat 流（sessionKey='main'）"路由--chat 不并发（用户一次一对话）。
   */
  async *sendReqStream(
    userId: number,
    method: string,
    params?: any,
    abortSignal?: AbortSignal
  ): AsyncIterable<{ event: string; payload: any }> {
    const ws = this.connections.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(this.offlineMessage());
    }
    const reqId = crypto.randomUUID();
    const stream = new PendingStream(reqId, userId);
    stream.timer = setInterval(() => {
      if (stream.done) return;
      if (Date.now() - stream.lastEventMs > STREAM_IDLE_TIMEOUT_MS) {
        stream.finish(new Error('Agent 响应超时，请稍后重试'));
      }
    }, 10_000);

    // 客户端取消（SSE 断开）时立即 finish，唤醒 for await 等待并退出，避免空等 90s 空闲超时
    const onAbort = () => stream.finish();
    if (abortSignal) {
      if (abortSignal.aborted) stream.finish();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    this.pendingStreams.set(reqId, stream);
    this.activeStreamByUser.set(userId, reqId);
    send(ws, { type: 'req', id: reqId, method, params });

    try {
      while (!stream.done || stream.buffer.length > 0) {
        if (stream.buffer.length > 0) {
          yield stream.buffer.shift()!;
        } else if (stream.error) {
          throw stream.error;
        } else {
          await new Promise<void>((r) => {
            stream.resolveWait = r;
          });
        }
      }
      if (stream.error) throw stream.error;
    } finally {
      if (stream.timer) clearInterval(stream.timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      this.pendingStreams.delete(reqId);
      if (this.activeStreamByUser.get(userId) === reqId) {
        this.activeStreamByUser.delete(userId);
      }
    }
  }

  handleResponse(frame: ResponseFrame) {
    // 普通 RPC res
    const p = this.pending.get(frame.id);
    if (p) {
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new Error(frame.error?.message || 'RPC 失败'));
      return;
    }
    // 流式 RPC res：是 ACK（{sessionKey, runId}），不是流结束。
    // 流结束由 chat event state='final'/'error' 触发（见 handleEvent）。
    // 仅 res error 时 finish（method 不存在/参数错等立即失败）。
    const s = this.pendingStreams.get(frame.id);
    if (s) {
      s.lastEventMs = Date.now();
      if (!frame.ok) s.finish(new Error(frame.error?.message || 'RPC 失败'));
    }
  }

  handleEvent(userId: number, frame: EventFrame) {
    // 流式 RPC event（chat delta 等）-> 路由到该 user 的活跃 stream
    const reqId = this.activeStreamByUser.get(userId);
    if (reqId) {
      const s = this.pendingStreams.get(reqId);
      if (s && !s.done) {
        s.push(frame.event, frame.payload);
        // chat event 流结束信号：final（agent_end 正常结束）/ error（运行错误）
        if (frame.event === 'chat') {
          const state = frame.payload?.state;
          if (state === 'final') s.finish();
          else if (state === 'error')
            s.finish(new Error(frame.payload?.error || 'Agent 错误'));
        }
      }
    }
    // 上行 event（monitor.alert/monitor.status_change 等）-> 广播订阅者
    emitUpstreamEvent(userId, frame.event, frame.payload);
  }
}

// globalThis 缓存：防 Next.js dev 下 instrumentation（await import）与 API route（webpack 静态 import）
// 分属不同模块系统、各自实例化 hotwaveConnections，导致 wss 注册的连接与端点查询的实例分裂（agent/status 永远 false）。
const g = globalThis as any;
export const hotwaveConnections: HotwaveConnectionManager =
  g.__hotwaveConnections ?? (g.__hotwaveConnections = new HotwaveConnectionManager());

/** 便捷函数：调 hotwave RPC（替代 gatewayRpc，按 user 路由） */
export function callHotwave<T = unknown>(
  userId: number,
  method: string,
  params?: any
): Promise<T> {
  return hotwaveConnections.sendReq(userId, method, params);
}

// ============== WS server 启动 ==============

export async function startHotwaveWsServer(): Promise<void> {
  // 同样用 globalThis 守卫，防止 instrumentation 重入或 HMR 重载时重复创建 wss（EADDRINUSE）
  if (g.__hotwaveWssStarted) return;
  g.__hotwaveWssStarted = true;

  // 默认只绑回环：hotwave 同机运行即可；若 hotwave 在另一台机器，
  // 需显式设 HOTWAVE_WS_HOST=0.0.0.0（并配合防火墙/内网访问控制）。
  const wss = new WebSocketServer({
    port: HOTWAVE_WS_PORT,
    host: process.env.HOTWAVE_WS_HOST || '127.0.0.1',
  });

  wss.on('connection', (socket) => {
    let userId: number | null = null;
    let authed = false;
    let tickTimer: NodeJS.Timeout | undefined;
    const nonce = crypto.randomUUID();

    // 1. 发送 challenge（对齐 gateway server.ts connect.challenge）
    send(socket, {
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce, ts: Date.now() },
      seq: 0,
    });

    // 2. 握手超时
    const handshakeTimer = setTimeout(() => {
      if (!authed) {
        try {
          socket.close(4000, 'handshake timeout');
        } catch {
          /* ignore */
        }
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }

      // 认证：connect req（hotwave 带 bindingId/Secret/nonce）
      if (isRequestFrame(parsed) && parsed.method === 'connect') {
        const p = parsed.params || {};
        const binding = verifyBinding(p.bindingId || '', p.bindingSecret || '');
        if (!binding || p.nonce !== nonce) {
          // 区分失败原因，供离线诊断（而非笼统「hotwave 离线」）
          let reason = '绑定凭证无效';
          const row = getBindingByBindingId(p.bindingId || '');
          if (!row) {
            reason = 'binding_id 不存在，请解绑后重新绑定';
          } else if (row.status !== 'active') {
            reason = '绑定已停用';
          } else if (p.nonce !== nonce) {
            reason = 'nonce 校验失败';
          } else {
            reason = 'secret 与库中记录不匹配';
          }
          hotwaveConnections.recordAuthFailure(p.bindingId || '', reason);
          respond(
            socket,
            parsed.id,
            false,
            undefined,
            { code: 'UNAUTHORIZED', message: reason }
          );
          try {
            socket.close(4001, 'auth failed');
          } catch {
            /* ignore */
          }
          return;
        }
        hotwaveConnections.clearAuthFailure();
        userId = binding.user_id;
        authed = true;
        clearTimeout(handshakeTimer);
        hotwaveConnections.register(userId, socket);
        respond(socket, parsed.id, true, { userId });
        // 周期 tick（60s < hotwave 侧 90s 无消息判定）：平时无 RPC/告警流量时维持活性，
        // 防止 hotwave-server-client 因 90s 无下行消息误判僵死而反复断开重连。
        tickTimer = setInterval(() => {
          send(socket, { type: 'event', event: 'tick', payload: { ts: Date.now() }, seq: 0 });
        }, 60_000);
        return;
      }

      // 未认证只允许 connect
      if (!authed) {
        if (isRequestFrame(parsed)) {
          respond(
            socket,
            parsed.id,
            false,
            undefined,
            { code: 'UNAUTHORIZED', message: 'not authenticated' }
          );
        }
        return;
      }

      // 已认证：res（响应 hotwave_server 的 req）/ event（上行）
      if (isResponseFrame(parsed)) {
        hotwaveConnections.handleResponse(parsed);
      } else if (isEventFrame(parsed)) {
        hotwaveConnections.handleEvent(userId!, parsed);
      }
      // hotwave 一般不向 hotwave_server 发 req（除 connect）；忽略其他 req
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      if (tickTimer) clearInterval(tickTimer);
      if (userId !== null) hotwaveConnections.unregister(userId, socket);
    });

    socket.on('error', () => {
      clearTimeout(handshakeTimer);
      if (tickTimer) clearInterval(tickTimer);
      if (userId !== null) hotwaveConnections.unregister(userId, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    wss.on('listening', () => resolve());
    wss.on('error', reject);
  });

  console.log(
    `[HotwaveWS] 长连接 WS server 已启动，监听 :${HOTWAVE_WS_PORT}（等待 hotwave 主动连入）`
  );
}
