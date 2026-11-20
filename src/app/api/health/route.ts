import { corsResponse, corsOptions } from '@/lib/cors';

// 公开健康检查：手机端「连接主机」页在配对前探测主机连通性。
// 不鉴权、不泄露业务数据，仅返回服务名与版本。
export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  return corsResponse(
    {
      ok: true,
      service: 'hotwave-server',
      version: '1.0.0',
      time: new Date().toISOString(),
    },
    200
  );
}
