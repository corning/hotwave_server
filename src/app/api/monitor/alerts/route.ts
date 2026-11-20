import { corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { callHotwave, subscribeHotwaveEvents } from '@/lib/hotwave-ws-server';
import {
  insertMonitorAlert,
  getRecentMonitorAlerts,
} from '@/lib/db';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  // Auth
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const encoder = new TextEncoder();
  const userId = auth.userId;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* stream may already be closed */
        }
      };

      // Send initial connecting status
      safeEnqueue(
        `event: monitor_status\ndata: ${JSON.stringify({ running: false, items: 0, alertsToday: 0, uptimeMs: 0, tradingSession: 'connecting' })}\n\n`
      );

      // 1. 订阅上行 event（hotwave 上行 monitor.alert/monitor.status_change -> SSE）
      const unsubscribe = subscribeHotwaveEvents(userId, (event, payload) => {
        if (closed) return;
        if (event === 'monitor.alert') {
          // 落库（hotwave 上行 alert）+ 推 SSE
          try {
            insertMonitorAlert(userId, payload);
          } catch (e) {
            console.error('[monitor/alerts] alert 落库失败:', e);
          }
          safeEnqueue(
            `event: monitor_alert\ndata: ${JSON.stringify(payload || {})}\n\n`
          );
        } else if (event === 'monitor.status_change') {
          const p = (payload || {}) as Record<string, unknown>;
          const { itemsList, ...statusOnly } = p;
          // 推状态（不含 items）
          safeEnqueue(
            `event: monitor_status\ndata: ${JSON.stringify(statusOnly)}\n\n`
          );
          // items 单独推
          if (itemsList) {
            safeEnqueue(
              `event: monitor_items\ndata: ${JSON.stringify(itemsList)}\n\n`
            );
          }
        }
      });

      // 2. 拉取初始状态快照（status + items + recentAlerts）
      try {
        const statusPayload = (await callHotwave(userId, 'monitor.status')) as Record<
          string,
          unknown
        >;
        if (statusPayload) {
          const { items: initialItems, recentAlerts, ...statusOnly } = statusPayload;
          safeEnqueue(
            `event: monitor_status\ndata: ${JSON.stringify(statusOnly)}\n\n`
          );
          if (initialItems) {
            safeEnqueue(
              `event: monitor_items\ndata: ${JSON.stringify(initialItems)}\n\n`
            );
          }
          // hotwave 返回的近期 alert 直接推（已由 gateway 侧落库或会重推，不重复落库）
          if (Array.isArray(recentAlerts)) {
            for (const alert of recentAlerts) {
              safeEnqueue(
                `event: monitor_alert\ndata: ${JSON.stringify(alert)}\n\n`
              );
            }
          }
        }
      } catch (err) {
        console.error('[monitor/alerts] 拉取初始状态失败:', err);
        // 透传真实原因（如绑定认证失败详情），而非笼统「hotwave 离线」
        const detail = err instanceof Error && err.message ? err.message : '';
        const message = detail.startsWith('hotwave 离线')
          ? detail
          : `hotwave 离线${detail ? `：${detail}` : '，请先在 APP 绑定 hotwave 并启动'}`;
        safeEnqueue(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      }

      // 3. 回放本用户历史 alert（最多 20 条，DB 侧历史）
      try {
        const history = getRecentMonitorAlerts(userId, 20);
        for (const row of history) {
          safeEnqueue(
            `event: monitor_alert\ndata: ${JSON.stringify(row.payload)}\n\n`
          );
        }
      } catch (e) {
        console.error('[monitor/alerts] 回放历史 alert 失败:', e);
      }

      // 4. Keep-alive ping every 15s
      const keepAlive = setInterval(() => {
        if (closed) {
          clearInterval(keepAlive);
          return;
        }
        safeEnqueue(':keepalive\n\n');
      }, 15_000);

      // 5. 客户端断开
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
