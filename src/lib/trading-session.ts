// A 股交易时段判断（北京时间 UTC+8）：周一至周五 09:25-11:30、13:00-15:00。
// 与 hotwave src/trader/router.ts:isAshareTradingSession 口径完全一致（含 09:25 集合竞价），
// 用于交易风控闸（清仓/下单），非交易时段拒绝。
//
// 注意：src/lib/stock-data.ts 另有 isAshareTradingTime() 用 09:30 口径，仅供行情 TTL
// （开盘后才需要短 TTL 拉实时盘口，集合竞价阶段行情未正式开始），两者用途不同故口径不同。
export function isAshareTradingSession(): boolean {
  const now = new Date();
  // hotwave_server 进程时区不一定是 Asia/Shanghai，按 UTC+8 换算
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  const day = bj.getDay();
  if (day === 0 || day === 6) return false; // 周末
  const hhmm = bj.getHours() * 100 + bj.getMinutes();
  return (hhmm >= 925 && hhmm <= 1130) || (hhmm >= 1300 && hhmm <= 1500);
}
