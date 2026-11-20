import { corsResponse, corsOptions } from '@/lib/cors';
import { getAppConfig } from '@/lib/db';

// APP 启动画面配置（启动动画 + 开屏页）。配置存于 app_configs 表（可选），由部署者维护。
// 公开接口（无鉴权）：未登录场景（启动时）也要能拉取。
// 无配置时 payload 为 null，客户端走本地默认动画。

const STARTUP_KEY = 'startup';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  const raw = getAppConfig(STARTUP_KEY);
  if (!raw) {
    return corsResponse({ ok: true, payload: null }, 200);
  }

  // 配置损坏（非 JSON）时降级 null，避免客户端解析崩溃
  try {
    return corsResponse({ ok: true, payload: JSON.parse(raw) }, 200);
  } catch {
    return corsResponse({ ok: true, payload: null }, 200);
  }
}
