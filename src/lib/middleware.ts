import { getAuthContext } from '@/lib/auth';
import { corsResponse } from '@/lib/cors';
import { getGlobalBlock, getUserById, verifyBinding } from '@/lib/db';
import type { AuthContext, DeviceInfo } from '@/types';
import type { NextResponse } from 'next/server';

/**
 * 鉴权请求：支持两种凭证。
 *
 * 1. hotwave 服务凭证（优先）：请求带 `X-Binding-Id` + `X-Binding-Secret` header，
 *    校验 hotwave_bindings 表（active + secret 哈希比对），通过则 auth.userId = 绑定用户。
 *    用于 hotwave 实例落库交易等场景——交易归属其绑定用户（方案 B）。
 * 2. Bearer JWT：用户的标准 JWT。除校验 JWT 本身外，额外校验 userId 对应用户
 *    是否存在：避免 token 仍有效但用户记录已被删除/重建时，后续写表触发
 *    FOREIGN KEY 约束失败。
 *
 * 返回 AuthContext on success，或 error NextResponse on failure。
 */
export function authenticateRequest(request: Request): AuthContext | NextResponse {
  // 设备上下文：与登录态解耦，认证成功/失败都会带上（供埋点、黑白名单设备维度使用）
  const device = resolveDeviceInfo(request);

  let ctx: AuthContext | null = null;

  // 1. hotwave 绑定凭证
  const bindingId = request.headers.get('X-Binding-Id');
  const bindingSecret = request.headers.get('X-Binding-Secret');
  if (bindingId && bindingSecret) {
    const binding = verifyBinding(bindingId, bindingSecret);
    if (!binding) {
      return corsResponse({ message: '绑定凭证无效或已吊销' }, 401);
    }
    // 绑定用户须存在（防外键异常）
    if (!getUserById(binding.user_id)) {
      return corsResponse({ message: '绑定用户不存在' }, 401);
    }
    ctx = { userId: binding.user_id, phone: '' };
  } else {
    // 2. Bearer JWT
    const authHeader = request.headers.get('Authorization');
    const jwtCtx = getAuthContext(authHeader);
    if (!jwtCtx) {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return corsResponse({ message: '未提供认证令牌' }, 401);
      }
      return corsResponse({ message: '认证令牌无效或已过期' }, 401);
    }
    // 校验用户记录仍存在（防止 token 有效但用户已删导致外键异常）
    if (!getUserById(jwtCtx.userId)) {
      return corsResponse({ message: '用户不存在，请重新登录' }, 401);
    }
    ctx = jwtCtx;
  }

  // 3. 黑白名单主防线：用户/手机/设备命中「全局封禁」(block + scope=all) 直接拒绝
  if (getGlobalBlock(ctx.userId, ctx.phone, device.deviceId)) {
    return corsResponse({ message: '账号已被限制访问' }, 403);
  }

  return { ...ctx, ...device };
}

/**
 * 解析客户端设备上下文（埋点统计 / 黑白名单 / 设备维度分析）。
 *
 * 客户端（flutter HttpUtil）在请求头注入：
 *   X-Device-Id / X-Device-Model / X-Device-OS / X-App-Version / X-Platform
 * 未登录请求也可携带设备头（未登录也埋点、设备级屏蔽）。
 */
export function resolveDeviceInfo(request: Request): DeviceInfo {
  return {
    deviceId: request.headers.get('X-Device-Id') ?? '',
    platform: request.headers.get('X-Platform') ?? '',
    deviceModel: request.headers.get('X-Device-Model') ?? '',
    osVersion: request.headers.get('X-Device-OS') ?? '',
    appVersion: request.headers.get('X-App-Version') ?? '',
    ip: clientIp(request),
  };
}

/** 提取客户端 IP：x-forwarded-for（代理/负载均衡，取最左真实 IP）优先，回退 x-real-ip / cf-connecting-ip。 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('cf-connecting-ip') ??
    ''
  );
}
