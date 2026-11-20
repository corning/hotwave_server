import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { insertChatMessage, updateMessageContent } from '@/lib/db';
import { hotwaveConnections } from '@/lib/hotwave-ws-server';
import { isRuntimeHealthy, sendKernelStream } from '@/lib/agent-kernel-bridge';
import { formatUpstreamError } from '@/lib/upstream-error';
import type { ChatSendRequest, MessageResponse } from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  // Auth
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  // Parse body
  let body: ChatSendRequest;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ message: '请求格式错误' } as MessageResponse, 400);
  }

  const { agentId, content } = body;
  if (!agentId || !content) {
    return corsResponse(
      { message: 'agentId 和 content 不能为空' } as MessageResponse,
      400
    );
  }
  try {
    // 1. Store user message
    const userMsgId = insertChatMessage(auth.userId, agentId, 'user', content);

    // 2. 选择引擎：kernel（新运行时）或 legacy（旧网关反连）
    const useKernel = process.env.CHAT_ENGINE === 'kernel';
    if (useKernel) {
      if (!(await isRuntimeHealthy())) {
        return corsResponse(
          { message: 'Agent 运行时未就绪，请检查 hotwave 服务' } as MessageResponse,
          503
        );
      }
    } else if (!hotwaveConnections.isConnected(auth.userId)) {
      return corsResponse(
        { message: 'hotwave 离线，请先在 APP 绑定 hotwave 并启动' } as MessageResponse,
        503
      );
    }

    // 3. Create SSE readablestream
    const encoder = new TextEncoder();
    // 客户端断开（Dio 取消/切后台/超时）时中止 hotwave 流式 RPC，立即释放 PendingStream + WS 等待，
    // 避免循环空等 90s 空闲超时（safeEnqueue 仅吞 enqueue 异常，不中断 for await）。
    const abortController = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        let assistantContent = '';
        // 客户端断开(Dio 超时/取消/切后台)后 controller 已 close,继续 enqueue 抛
        // ERR_INVALID_STATE。safeEnqueue 兜底并标记 clientGone,避免噪声错误日志。
        let clientGone = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (clientGone) return;
          try {
            controller.enqueue(chunk);
          } catch {
            clientGone = true;
          }
        };

        // SSE 心跳：glm-5.2 extended thinking 思考期间 hotwave 不 emit 任何 event，
        // 客户端 Dio receiveTimeout 会在 120s 误判超时。每 15s 发 SSE 注释行（: keepalive），
        // 重置客户端接收计时 + 不污染事件流（SSE 规范忽略注释行）。
        const heartbeatTimer = setInterval(() => {
          safeEnqueue(encoder.encode(`: keepalive\n\n`));
        }, 15_000);

        try {
          // kernel 引擎与旧网关产出相同形状的 { event, payload }，下游逻辑完全复用
          const streamSource = useKernel
            ? sendKernelStream(content, abortController.signal)
            : hotwaveConnections.sendReqStream(
                auth.userId,
                'chat.send',
                { message: content, sessionKey: 'main' },
                abortController.signal
              );

          for await (const { event, payload } of streamSource) {
            if (clientGone) break;

            // chat 事件：流式 delta/reasoning/final/thinking（仅 main 会话白名单）
            if (event === 'chat') {
              if (payload?.sessionKey !== 'main') continue;
              const state = payload?.state;
              const text = payload?.text || '';
              if (state === 'delta' && text) {
                assistantContent += text;
                safeEnqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ content: text })}\n\n`));
              } else if (state === 'reasoning' && text) {
                safeEnqueue(encoder.encode(`event: reasoning_delta\ndata: ${JSON.stringify({ __meta: true, type: 'reasoning_delta', text })}\n\n`));
              } else if (state === 'final') {
                if (text) {
                  // hotwave 已 linkify 的完整文本：覆盖累积内容（存库 + 前端替换显示）
                  assistantContent = text;
                  safeEnqueue(encoder.encode(`event: final\ndata: ${JSON.stringify({ content: assistantContent })}\n\n`));
                }
              } else if (state === 'thinking' || state === 'thinking_done') {
                const tool = payload?.tool || '';
                const isError = state === 'thinking_done' ? payload?.isError ?? false : false;
                safeEnqueue(encoder.encode(`event: ${state}\ndata: ${JSON.stringify({ __meta: true, type: state, tool, isError })}\n\n`));
              }
            }

          }

          if (clientGone) return; // 客户端已断开,不发 done/不存库

          // Store assistant message
          const assistantMsgId = insertChatMessage(
            auth.userId,
            agentId,
            'assistant',
            assistantContent
          );

          // Send done event
          const doneData = `event: done\ndata: ${JSON.stringify({ messageId: assistantMsgId })}\n\n`;
          safeEnqueue(encoder.encode(doneData));
        } catch (error) {
          // 客户端断开导致的 enqueue 失败已被 safeEnqueue 吞掉,不会进 catch;
          // 此处仅处理 bridge.send 自身抛出的异常。
          if (clientGone) return;
          console.error('[chat/send] Stream error:', error);
          // 用真实错误（截断）作为 errorMsg，便于前端展示 + 定位根因（maxTokens/API/reasoning 等）
          const rawErr = error instanceof Error ? error.message : String(error);
          // 额度/限流等环境问题给可读文案；其它错误保留原文便于排障
          const errorMsg = formatUpstreamError(rawErr);
          const errorMsgId = insertChatMessage(
            auth.userId, agentId, 'assistant', assistantContent, errorMsg
          );
          // Send done event with errorMessage so client can record it
          const doneData = `event: done\ndata: ${JSON.stringify({ messageId: errorMsgId, errorMessage: errorMsg })}\n\n`;
          safeEnqueue(encoder.encode(doneData));
          const errorData = `event: error\ndata: ${JSON.stringify({ message: errorMsg })}\n\n`;
          safeEnqueue(encoder.encode(errorData));
        } finally {
          clearInterval(heartbeatTimer);
          if (!clientGone) {
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        }
      },
      cancel() {
        // 客户端断开：中止 hotwave 流式 RPC，立即结束 for await 循环
        abortController.abort();
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
  } catch (error) {
    console.error('[chat/send] Error:', error);
    return corsResponse({ message: '服务器异常，请稍后重试' } as MessageResponse, 500);
  }
}
