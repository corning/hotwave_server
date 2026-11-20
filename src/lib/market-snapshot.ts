/**
 * 全市场行情快照 + 异动检测（主板大单雷达）
 *
 * hotwave_server 数据层：拉取全市场 A 股实时行情（价格/涨幅/成交量/成交额/换手率/总市值），
 * 提供两类异动能力：
 * - getAnomalyPool：涨幅区间 + 市值上限筛选沪深主板异动票池（涨幅 6~9.9% 等）
 * - getBigOrderAlerts：成交额突增检测（对比模块内存上一轮快照的成交额 delta）
 *
 * 供 /api/hotwave/market 端点，hotwave 的 market_anomaly / market_big_order 工具消费。
 * 与 stock-list.ts 共用东财 clist 全市场接口（fields 扩展行情字段），不引入额外数据源。
 */

import dns from 'node:dns';
import net from 'node:net';

// 该行情接口的 IPv6 节点拒绝 Node TLS 握手，与 stock-data.ts/stock-list.ts 一致强制 IPv4。
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

/** 全市场行情行 */
export interface MarketRow {
  symbol: string;   // 6 位代码
  name: string;
  price: number;    // 最新价（元）
  changePct: number; // 涨跌幅（%）
  volume: number;   // 成交量（手）
  amount: number;   // 成交额（元）
  turnover: number; // 换手率（%）
  marketCap: number; // 总市值（元）
}

export interface AnomalyPoolConfig {
  riseMin: number;      // 涨幅下限（%）
  riseMax: number;      // 涨幅上限（%），<=0 不限
  marketValueMax: number; // 总市值上限（亿元），<=0 不限
  limit: number;
}

export interface BigOrderConfig {
  bigOrderMin: number; // 成交额增量阈值（元）
  limit: number;
}

export interface BigOrderRow {
  symbol: string;
  name: string;
  delta: number;      // 本轮较上一轮成交额增量（元）
  dir: 1 | 2;         // 1=大单买入 2=大单卖出
  price: number;
  changePct: number;
}

const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const PAGE_SIZE = 200;

// 全市场 A 股分组（沪深两市）。业务参数不暴露第三方来源，分组为内部实现细节。
const CLIST_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 沪深主板（60x 沪 / 00x 深），与扩展 isMainBoard 一致 */
function isMainBoard(symbol: string): boolean {
  return symbol.startsWith('60') || symbol.startsWith('00');
}

// ---- 行情缓存 ----

type CacheEntry<T> = { expiresAt: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setCache<T>(key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// A 股交易时段判断（北京时间 UTC+8），与 stock-data.ts 思路一致。
function isAshareTradingTime(): boolean {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const bjHour = (utcHours + 8) % 24;
  const bjTotalMin = bjHour * 60 + now.getUTCMinutes();
  let bjDay = now.getUTCDay();
  if (utcHours >= 16) bjDay = (bjDay + 1) % 7;
  if (bjDay === 0 || bjDay === 6) return false;
  return (
    (bjTotalMin >= 9 * 60 + 30 && bjTotalMin < 11 * 60 + 30) ||
    (bjTotalMin >= 13 * 60 && bjTotalMin < 15 * 60)
  );
}

// 快照 TTL：交易时段短 TTL（供 LLM 高频调用拿到新数据），非交易时段长 TTL（数据不动省请求）。
function snapshotTtl(): number {
  return isAshareTradingTime() ? 10_000 : 300_000;
}

// ---- 全市场行情拉取 ----

/** 单页行情拉取（失败重试 3 次，指数退避；东财对高频请求会临时限流） */
async function fetchSnapshotPage(page: number): Promise<Array<Record<string, unknown>>> {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2` +
    `&fid=f3&fs=${encodeURIComponent(CLIST_FS)}&fields=f2,f3,f5,f6,f8,f12,f14,f20`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': AGENT, Referer: 'https://quote.eastmoney.com/' },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const json: any = await resp.json();
      const diff: unknown[] = json?.data?.diff ?? [];
      return diff.map((item) => (typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}));
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 拉全市场 A 股行情（分页直到拿全或连续空页），非交易时段价格/涨幅/成交额为 "-" 容错为 0 */
async function fetchSnapshot(): Promise<MarketRow[]> {
  const out: MarketRow[] = [];
  const seen = new Set<string>();
  let page = 1;
  for (; ;) {
    const diff = await fetchSnapshotPage(page);
    if (!diff.length) break;
    for (const item of diff) {
      const symbol = String(item.f12 || '').trim();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push({
        symbol,
        name: String(item.f14 || '').trim(),
        price: num(item.f2),
        changePct: num(item.f3),
        volume: num(item.f5),
        amount: num(item.f6),
        turnover: num(item.f8),
        marketCap: num(item.f20),
      });
    }
    if (diff.length < PAGE_SIZE) break;
    page += 1;
    if (page > 200) break; // 安全上限
    await sleep(80); // 页间节流
  }
  if (!out.length) throw new Error('全市场行情拉取为空');
  return out;
}

/** 取全市场行情快照（内存缓存：交易时段 10s / 非交易 5min） */
export async function getMarketSnapshot(): Promise<MarketRow[]> {
  const key = 'market:snapshot';
  const cached = getCache<MarketRow[]>(key);
  if (cached) return cached;
  const rows = await fetchSnapshot();
  return setCache(key, rows, snapshotTtl());
}

// ---- 异动检测 ----

/** 沪深主板异动票池：涨幅区间 + 市值上限筛选，按涨幅降序 */
export async function getAnomalyPool(cfg: AnomalyPoolConfig): Promise<MarketRow[]> {
  const snapshot = await getMarketSnapshot();
  const riseMax = cfg.riseMax > 0 ? cfg.riseMax : Infinity;
  const mvLimit = cfg.marketValueMax > 0 ? cfg.marketValueMax * 1e8 : Infinity;
  const pool = snapshot
    .filter((q) =>
      isMainBoard(q.symbol) &&
      q.changePct > cfg.riseMin &&
      q.changePct < riseMax &&
      q.marketCap > 0 &&
      q.marketCap <= mvLimit
    )
    .sort((a, b) => b.changePct - a.changePct);
  return pool.slice(0, cfg.limit > 0 ? cfg.limit : 20);
}

// 上一轮成交额基准（模块内存，跨调用保留，等价扩展的 prevAmounts）。
// 每次 bigorder 检测后更新，供下一次调用对比 delta。
const prevAmounts = new Map<string, number>();

/**
 * 大单突增检测：票池内股票本轮成交额较上一轮增量 >= 阈值 视为异动。
 * 首次调用（无基准）返回空数组 + baseline=true 标记，同时建立基准。
 * 方向判断：现价涨幅 > 0 视为买盘（盘口数据无开盘价，与扩展 popup.js 一致）。
 */
export async function getBigOrderAlerts(cfg: BigOrderConfig): Promise<{
  alerts: BigOrderRow[];
  baseline: boolean;
}> {
  const baseline = prevAmounts.size === 0;
  // 基准检测范围与扩展一致：只在异动票池内检测大单
  const pool = await getAnomalyPool({ riseMin: 6, riseMax: 9.9, marketValueMax: 500, limit: 2000 });

  const alerts: BigOrderRow[] = [];
  for (const q of pool) {
    const prev = prevAmounts.get(q.symbol);
    if (prev !== undefined && q.amount > prev) {
      const delta = q.amount - prev;
      if (delta >= cfg.bigOrderMin) {
        alerts.push({
          symbol: q.symbol,
          name: q.name,
          delta,
          dir: q.price > 0 && q.changePct > 0 ? 1 : 2,
          price: q.price,
          changePct: q.changePct,
        });
      }
    }
    prevAmounts.set(q.symbol, q.amount);
  }
  alerts.sort((a, b) => b.delta - a.delta);
  return {
    alerts: alerts.slice(0, cfg.limit > 0 ? cfg.limit : 20),
    baseline,
  };
}
