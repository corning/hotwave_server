/**
 * A 股交易日历生成
 *
 * hotwave_server 作为权威源：内嵌法定节假日/调休表，Node 侧生成当年交易日，
 * 供 /api/hotwave/trade-days 端点，hotwave heartbeat 不再依赖本地文件与 Python。
 *
 * 生成规则 = 全年工作日(周一~五) − 法定节假日 + 调休上班日(周末补班)。
 *
 * ⚠️ 每年国务院公布次年放假安排（约 11-12 月）后，需把特殊日补入下表并重新部署；
 * 未录入年份退化为"仅排除周末"（与 heartbeat 原降级逻辑一致）。
 */
const HOLIDAYS: Record<number, string[]> = {
  2026: [
    "2026-01-01", "2026-01-02",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
    "2026-04-06",
    "2026-05-01", "2026-05-04", "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
  ],
};

/** 调休上班日（周末补班）。2026 无。 */
const MAKEUP_WORKDAYS: Record<number, string[]> = {
  2026: [],
};

export interface TradeDaysResult {
  year: number;
  total: number;
  list: string[];
}

/** 按年缓存（静态数据，进程生命周期内不变） */
const cache = new Map<number, TradeDaysResult>();

/** 生成指定年份的全部 A 股交易日（YYYY-MM-DD 升序） */
export function generateTradeDays(year: number): TradeDaysResult {
  const holidays = new Set(HOLIDAYS[year] ?? []);
  const makeups = new Set(MAKEUP_WORKDAYS[year] ?? []);
  const list: string[] = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const ymd = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend) {
      // 调休补班日算交易日
      if (makeups.has(ymd)) list.push(ymd);
    } else if (!holidays.has(ymd)) {
      list.push(ymd);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { year, total: list.length, list };
}

/** 取指定年份交易日（默认当年，按北京时区），带缓存 */
export function getTradeDays(year?: number): TradeDaysResult {
  const y = year ?? new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  const cached = cache.get(y);
  if (cached) return cached;
  const result = generateTradeDays(y);
  cache.set(y, result);
  return result;
}
