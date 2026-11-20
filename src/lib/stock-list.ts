/**
 * 全市场股票+ETF 列表拉取与缓存
 *
 * hotwave_server 作为权威源：拉取全市场 A 股（沪深 + 北交所）与 ETF 列表，
 * 供 /api/hotwave/stocks 与 /api/hotwave/stocks/search 端点，hotwave 名称搜索 /
 *
 * 数据覆盖（东财全市场列表接口，分组分页拉取）：
 * - 沪深 A 股：m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23（~5549 只）
 * - 北交所：  m:0+t:81+s:2048（~347 只）
 * - ETF：     b:MK0021,b:MK0022,b:MK0023,b:MK0024（~1569 只）
 *
 * 缓存策略：进程内存 + 落盘 hotwave_server/persistent/all_stocks.json（重启免重拉）；
 * 每日北京时间 08:30 后自动刷新一次（跨日触发）。
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';

// 东财 push2 部分 IPv6 节点会拒绝 Node TLS 握手，与 stock-data.ts 一致强制 IPv4。
// stock-data.ts 已被引用时全局已生效，此处幂等设置以兼容本模块被独立加载的场景。
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

export interface StockEntry {
  symbol: string;
  name: string;
  ts_code: string;
  type: number; // 1=股票 2=ETF
}

const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const PAGE_SIZE = 200; // 单页 200，全市场约 29 页（减请求数，降低触发限流概率）

// 全市场分组：{ fs, type }。业务参数不暴露第三方来源，分组为内部实现细节。
const CLIST_GROUPS: Array<{ fs: string; type: number }> = [
  { fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', type: 1 }, // 沪深 A 股
  { fs: 'm:0+t:81+s:2048', type: 1 }, // 北交所
  { fs: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024', type: 2 }, // ETF
];

/** 代码→市场后缀（对齐 monitor_engine post_market.py add_suffix） */
function addSuffix(symbol: string): string {
  if (/^[65]/.test(symbol)) return `${symbol}.SH`;
  if (/^[013]/.test(symbol)) return `${symbol}.SZ`;
  if (/^[849]/.test(symbol)) return `${symbol}.BJ`;
  return '';
}

/** 北京时间 YYYY-MM-DD（与 heartbeat toBeijingDate 一致思路） */
function beijingDateStr(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 北京时间 HHMM（用于盘前刷新判断） */
function beijingHHMM(): number {
  const s = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16);
  return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5));
}

const PERSIST_DIR = path.join(process.cwd(), 'persistent');
const PERSIST_PATH = path.join(PERSIST_DIR, 'all_stocks.json');

let cache: StockEntry[] | null = null;
let cacheDate = ''; // 内存缓存对应的北京日期

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单页 clist 拉取（失败重试 3 次，指数退避；东财对高频请求会临时限流） */
async function fetchClistPage(fs: string, page: number): Promise<{ total: number; diff: Array<{ f12?: string; f14?: string }> }> {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2` +
    `&fid=f12&fs=${encodeURIComponent(fs)}&fields=f12,f14`;
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
      return { total: Number(json?.data?.total) || 0, diff: json?.data?.diff ?? [] };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 拉取一组全量（分页直到拿全或连续空页） */
async function fetchGroup(group: { fs: string; type: number }): Promise<StockEntry[]> {
  const out: StockEntry[] = [];
  const seen = new Set<string>();
  let page = 1;
  for (; ;) {
    const { diff } = await fetchClistPage(group.fs, page);
    if (!diff.length) break;
    for (const item of diff) {
      const symbol = String(item.f12 || '').trim();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push({
        symbol,
        name: String(item.f14 || '').trim(),
        ts_code: addSuffix(symbol),
        type: group.type,
      });
    }
    if (diff.length < PAGE_SIZE) break;
    page += 1;
    if (page > 200) break; // 安全上限
    await sleep(80); // 页间节流，避免触发东财限流
  }
  return out;
}

/** 拉全市场（三组并发），返回合并列表 */
async function fetchAll(): Promise<StockEntry[]> {
  const groups = await Promise.allSettled(CLIST_GROUPS.map((g) => fetchGroup(g)));
  const merged: StockEntry[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (g.status !== 'fulfilled') {
      console.error('[stock-list] 分组拉取失败:', g.reason?.message ?? g.reason);
      continue;
    }
    for (const item of g.value) {
      if (seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      merged.push(item);
    }
  }
  if (!merged.length) throw new Error('全市场列表拉取为空');
  return merged;
}

function writeDisk(list: StockEntry[]) {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(list), 'utf-8');
  } catch (err) {
    console.error('[stock-list] 落盘失败:', (err as Error).message);
  }
}

function readDisk(): StockEntry[] | null {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8')) as StockEntry[];
    return Array.isArray(raw) && raw.length ? raw : null;
  } catch {
    return null;
  }
}

/** 取全市场列表：内存 → 落盘 → 拉取（首请求懒加载） */
export async function getStockList(): Promise<StockEntry[]> {
  if (cache && cache.length) return cache;
  const disk = readDisk();
  if (disk) {
    cache = disk;
    cacheDate = beijingDateStr();
    return cache;
  }
  cache = await fetchAll();
  cacheDate = beijingDateStr();
  writeDisk(cache);
  return cache;
}

/** 强制刷新（从数据源重拉全量，更新内存 + 落盘） */
export async function refreshStockList(): Promise<StockEntry[]> {
  const list = await fetchAll();
  cache = list;
  cacheDate = beijingDateStr();
  writeDisk(list);
  console.log(`[stock-list] 已刷新全市场列表 ${list.length} 条`);
  return list;
}

/** 每日盘前自动刷新：跨日 + 北京时间 >= 08:30 时触发一次 */
async function ensureDailyRefresh() {
  const today = beijingDateStr();
  if (cacheDate === today) return;
  if (beijingHHMM() < 830) return; // 盘前 8:30 后才允许刷新（避免凌晨/深夜重拉）
  try {
    await refreshStockList();
  } catch (err) {
    console.error('[stock-list] 每日刷新失败:', (err as Error).message);
  }
}

// 进程内周期检查（1 分钟粒度，静态数据仅跨日 + 盘前触发一次重拉）
setInterval(() => {
  void ensureDailyRefresh();
}, 60_000);
