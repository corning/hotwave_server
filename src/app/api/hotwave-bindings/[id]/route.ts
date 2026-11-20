import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getBindingById, revokeBinding } from '@/lib/db';
import type { AuthContext, MessageResponse } from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

// 吊销指定绑定（仅绑定所属用户可吊销自己的）
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = authenticateRequest(request);
  if (!('userId' in (auth as AuthContext))) {
    return auth as NextResponse;
  }
  const ctx = auth as AuthContext;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return corsResponse({ message: '参数无效' } as MessageResponse, 400);
  }

  const binding = getBindingById(id);
  if (!binding) {
    return corsResponse({ message: '绑定不存在' } as MessageResponse, 404);
  }
  // 仅 owner 可吊销
  if (binding.user_id !== ctx.userId) {
    return corsResponse({ message: '无权操作' } as MessageResponse, 403);
  }

  revokeBinding(id);
  return corsResponse({ ok: true });
}
