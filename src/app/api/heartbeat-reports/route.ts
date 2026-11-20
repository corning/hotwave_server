import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { upsertHeartbeatReportV2, getHeartbeatReportsV2 } from '@/lib/db';
import { NextRequest, type NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

/**
 * LLM 决策记录端点（heartbeat / alert / schedule 三类决策统一落 heartbeat_reports）。
 *
 * - POST: hotwave 在 LLM 决策完成时直写本端点（X-Binding-Id/Secret 凭证），
 *   按 run_id 去重，body 携带 source/symbol/token 用量/触发原因。best-effort，失败不阻塞主流程。
 * - GET: APP 简报中心按日期拉取（JWT），date 参数（YYYY-MM-DD 北京时区，默认今天），倒序全量返回 { rows }。
 */
export async function POST(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ ok: false, error: 'invalid json body' }, 400);
  }

  const runId = (body?.runId ?? '').toString().trim();
  const text = (body?.text ?? '').toString();
  if (!runId) {
    return corsResponse({ ok: false, error: 'runId required' }, 400);
  }
  if (!text.trim()) {
    return corsResponse({ ok: false, error: 'text required' }, 400);
  }

  try {
    const id = upsertHeartbeatReportV2(runId, text, {
      source: body?.source,
      symbol: body?.symbol,
      inputTokens: body?.inputTokens,
      outputTokens: body?.outputTokens,
      totalTokens: body?.totalTokens,
      cost: body?.cost,
      triggerReason: body?.triggerReason,
    });
    const inserted = id !== undefined;
    return corsResponse({
      ok: true,
      payload: { inserted, id: id ?? null, runId },
    });
  } catch (err) {
    console.error('[heartbeat-reports] 落库失败:', err);
    return corsResponse({ ok: false, error: '落库失败' }, 500);
  }
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const params = new URL(request.url).searchParams;
  const date = params.get('date') ?? undefined;

  try {
    const rows = getHeartbeatReportsV2(date);
    return corsResponse({
      ok: true,
      payload: { rows },
    });
  } catch (err) {
    console.error('[heartbeat-reports] 查询失败:', err);
    return corsResponse({ ok: false, error: '查询失败' }, 500);
  }
}
