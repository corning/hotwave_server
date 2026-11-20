import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getUserById } from '@/lib/db';
import type { UserInfoResponse, MessageResponse, AuthContext } from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  // Authenticate
  const auth = authenticateRequest(request);
  if (!('userId' in (auth as AuthContext))) {
    return auth as NextResponse; // Error response
  }

  const ctx = auth as AuthContext;

  try {
    const user = getUserById(ctx.userId);
    if (!user) {
      return corsResponse({ message: '用户不存在' } as MessageResponse, 404);
    }

    const response: UserInfoResponse = {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatar: user.avatar,
    };

    return corsResponse(response, 200);
  } catch (error) {
    return corsResponse({ message: '服务器异常，请稍后重试' } as MessageResponse, 500);
  }
}
