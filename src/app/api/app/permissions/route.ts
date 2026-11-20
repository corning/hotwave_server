import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getUserRulesForTarget } from '@/lib/db';
import type { NextResponse } from 'next/server';

// APP 权限快照（鉴权）：客户端据此做路由守卫 / UI 隐藏 / 操作禁用（体验层）。
// 服务端强制校验在鉴权中间件（全局封禁），本接口只是把规则快照下发给客户端。

export interface PermissionsPayload {
  /** 是否被全局封禁（用户/手机/设备命中 block+all） */
  blocked: boolean;
  /** 被屏蔽的页面路径列表（如 ['/trade']） */
  blockedPages: string[];
  /** 被屏蔽的操作列表（如 ['trade_liquidate']） */
  blockedActions: string[];
  /** 功能白名单快照：放行的 feature → true；未列出 = 未放行 */
  featureFlags: Record<string, boolean>;
}

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const rules = getUserRulesForTarget(auth.userId, auth.phone, auth.deviceId ?? '');
  const blocked = rules.some((r) => r.rule_type === 'block' && r.scope_type === 'all');
  const blockedPages = rules
    .filter((r) => r.rule_type === 'block' && r.scope_type === 'page')
    .map((r) => r.scope_key);
  const blockedActions = rules
    .filter((r) => r.rule_type === 'block' && r.scope_type === 'action')
    .map((r) => r.scope_key);
  const featureFlags: Record<string, boolean> = {};
  for (const r of rules) {
    if (r.rule_type === 'allow' && r.scope_type === 'feature') {
      featureFlags[r.scope_key] = true;
    }
  }

  const payload: PermissionsPayload = { blocked, blockedPages, blockedActions, featureFlags };
  return corsResponse({ ok: true, payload }, 200);
}
