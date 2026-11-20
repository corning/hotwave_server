import { corsResponse, corsOptions } from '@/lib/cors';
import { getUserByPhone } from '@/lib/db';
import { signToken } from '@/lib/auth';
import { compareSync } from 'bcryptjs';
import type { LoginRequest, LoginResponse, MessageResponse } from '@/types';

export async function OPTIONS() {
  return corsOptions();
}

export async function POST(request: Request) {
  let body: LoginRequest;

  try {
    body = await request.json();
  } catch {
    return corsResponse({ message: '请求格式错误' } as MessageResponse, 400);
  }

  const { phone, password } = body;
  if (!phone) {
    return corsResponse({ message: '手机号不能为空' } as MessageResponse, 400);
  }
  if (!/^1\d{10}$/.test(phone)) {
    return corsResponse({ message: '手机号格式不正确' } as MessageResponse, 400);
  }

  // 私有部署：仅密码登录（账号由 owner 预置，无公开注册与短信验证码）
  if (!password) {
    return corsResponse({ message: '密码不能为空' } as MessageResponse, 400);
  }

  try {
    const user = getUserByPhone(phone);

    if (!user) {
      return corsResponse({ message: '账号不存在，请联系主机 owner 开通' } as MessageResponse, 404);
    }
    if (!user.password_hash || !compareSync(password, user.password_hash)) {
      return corsResponse({ message: '手机号或密码错误' } as MessageResponse, 400);
    }

    // Generate JWT
    const token = signToken(user.id, user.phone);

    const response: LoginResponse = {
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname,
        avatar: user.avatar,
      },
    };

    return corsResponse(response, 200);
  } catch (error) {
    return corsResponse({ message: '服务器异常，请稍后重试' } as MessageResponse, 500);
  }
}
