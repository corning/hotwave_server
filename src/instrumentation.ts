/**
 * Next.js instrumentation hook：server 运行时启动时执行一次。
 *
 * 启动 hotwave 长连接 WS server（默认 :18791）：hotwave 用 binding 凭证主动连入，
 * hotwave_server 通过该连接反向下发 RPC（chat.send、monitor.*、trader.balance）+ 接收上行 event
 * （monitor.alert/monitor.status_change）。
 *
 * hotwave_server 是平台能力，不主动连 hotwave gateway（无反向依赖）；仅当用户在 APP 绑定并启动
 * hotwave 后，hotwave 才主动连入建立长连接，双向通信。
 *
 * 注意：hotwave-ws-server -> db.ts -> better-sqlite3（需 node 'fs'）的 import 链必须在
 * `if (process.env.NEXT_RUNTIME === 'nodejs')` 内动态 import，否则 webpack 会将其打进
 * edge/客户端 bundle 导致 "Can't resolve 'fs'"。NEXT_RUNTIME 由 Next.js 在 register 调用时
 * 设置为 'nodejs'（server）或 'edge'。
 * 需 next.config.js 的 `experimental.instrumentationHook: true`（Next.js 14.2.35 仍需此 flag）。
 */
export async function register(): Promise<void> {
  console.log(
    `[instrumentation] register() 被调用, NEXT_RUNTIME=${process.env.NEXT_RUNTIME || 'undefined'}`
  );
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startHotwaveWsServer } = await import('./lib/hotwave-ws-server');
      startHotwaveWsServer()
        .then(() => console.log('[instrumentation] hotwave WS server 启动完成'))
        .catch((e) =>
          console.error('[instrumentation] hotwave WS 启动失败:', (e as Error).message)
        );
    } catch (e) {
      console.error('[instrumentation] 加载 hotwave-ws-server 失败:', (e as Error).message);
    }
  }
}
