import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getUserById, updateUser } from '@/lib/db';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type {
  UserInfoResponse,
  MessageResponse,
  AuthContext,
} from '@/types';
import type { NextResponse } from 'next/server';

const AVATAR_DIR = path.join(process.cwd(), 'public', 'uploads', 'avatars');

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function OPTIONS() {
  return corsOptions();
}

// 更新当前登录用户的资料（昵称 + 可选头像上传，multipart/form-data）
export async function POST(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in (auth as AuthContext))) {
    return auth as NextResponse; // 错误响应
  }
  const ctx = auth as AuthContext;

  try {
    const formData = await request.formData();
    const nicknameRaw = formData.get('nickname');
    const nickname =
      typeof nicknameRaw === 'string' ? nicknameRaw.trim() : '';
    const file = formData.get('file');

    let avatarUrl: string | undefined;

    if (file && typeof file === 'object' && 'arrayBuffer' in file) {
      const ext =
        MIME_TO_EXT[file.type] ||
        (file.name.includes('.')
          ? (file.name.split('.').pop() || 'jpg').toLowerCase()
          : 'jpg');
      const filename = `${ctx.userId}_${Date.now()}.${ext}`;
      await mkdir(AVATAR_DIR, { recursive: true });
      const buf = Buffer.from(await file.arrayBuffer());
      await writeFile(path.join(AVATAR_DIR, filename), buf);
      avatarUrl = `/api/uploads/avatars/${filename}`;
    }

    const user = getUserById(ctx.userId);
    if (!user) {
      return corsResponse(
        { message: '用户不存在' } as MessageResponse,
        404,
      );
    }

    // nickname 传 undefined 表示不改；空串允许清空
    updateUser(
      ctx.userId,
      nicknameRaw === null ? undefined : nickname,
      avatarUrl,
    );

    const updated = getUserById(ctx.userId)!;
    const response: UserInfoResponse = {
      id: updated.id,
      phone: updated.phone,
      nickname: updated.nickname,
      avatar: updated.avatar,
    };
    return corsResponse(response, 200);
  } catch (error: any) {
    console.error('[PROFILE ERROR]', error);
    return corsResponse(
      { message: '服务器异常' } as MessageResponse,
      500,
    );
  }
}
