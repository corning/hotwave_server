import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { createBinding, getBindingsByUser } from '@/lib/db';
import type {
  AuthContext,
  CreateBindingBody,
  CreateBindingResponse,
  BindingItem,
  MessageResponse,
} from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 当前用户查询自己的 hotwave 绑定列表（不含 secret）
export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in (auth as AuthContext))) {
    return auth as NextResponse;
  }
  const ctx = auth as AuthContext;

  const rows = getBindingsByUser(ctx.userId).map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    bindingId: r.binding_id,
    label: r.label,
    status: r.status,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  })) as BindingItem[];

  return corsResponse({ ok: true, payload: { rows } });
}

// 创建绑定：返回 binding_id + 明文 secret（仅此一次，须立即配置到 hotwave .env）
export async function POST(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in (auth as AuthContext))) {
    return auth as NextResponse;
  }
  const ctx = auth as AuthContext;

  let body: CreateBindingBody = {};
  try {
    body = await request.json();
  } catch {
    // 无 body 也允许，label 默认空
  }
  const label = (body.label || '').trim().slice(0, 50);

  try {
    const { binding, secret } = createBinding(ctx.userId, label);
    const response: CreateBindingResponse = {
      id: binding.id,
      bindingId: binding.binding_id,
      secret,
      label: binding.label,
      createdAt: binding.created_at,
    };
    return corsResponse({ ok: true, payload: response });
  } catch (error) {
    return corsResponse(
      { message: '服务器异常，请稍后重试' } as MessageResponse,
      500,
    );
  }
}
