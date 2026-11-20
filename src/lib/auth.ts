import jwt from 'jsonwebtoken';
import type { JwtPayload, AuthContext } from '@/types';

const TOKEN_EXPIRY = '7d';

// 开发模式兜底密钥：仅用于本机调试。生产环境未配置 SECRET_KEY 时直接抛错，
// 避免用公开默认值签发可伪造的 JWT。
const DEV_FALLBACK_SECRET = 'hotwave-dev-only-insecure-secret';
let warnedMissingSecret = false;

function secretKey(): string {
  const configured = process.env.SECRET_KEY?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SECRET_KEY 未配置：生产环境必须设置 SECRET_KEY（≥32 字节随机串，例如 openssl rand -hex 32）',
    );
  }
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    console.warn('[auth] SECRET_KEY 未配置，当前使用仅供开发的默认密钥，请勿用于生产');
  }
  return DEV_FALLBACK_SECRET;
}

export function signToken(userId: number, phone: string): string {
  return jwt.sign({ userId, phone } as JwtPayload, secretKey(), {
    expiresIn: TOKEN_EXPIRY,
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secretKey()) as JwtPayload;
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

export function getAuthContext(authHeader: string | null): AuthContext | null {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    return { userId: payload.userId, phone: payload.phone };
  } catch {
    return null;
  }
}
