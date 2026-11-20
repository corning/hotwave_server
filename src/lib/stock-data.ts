import dns from 'node:dns';
import net from 'node:net';
import { callHotwave } from '@/lib/hotwave-ws-server';
import { getEastmoneyTrades } from '@/lib/eastmoney-data';
import { normalizeStockSymbol, pureStockCode, stockMarket, stockPrefixByCode, toTencentSymbol, toTsCode, isIndexSymbol } from '@/lib/stock-symbol';

// 东财 push2his 等接口的 IPv6 节点拒绝 Node TLS 握手（UND_ERR_SOCKET "other side closed"）。
// Node 24 默认 Happy Eyeballs（autoSelectFamily）先试 IPv6 → 被服务器 RST → 资金流等 "fetch failed"；
// curl 可连（TLS 栈不同）。模块加载时统一强制 IPv4，进程内全局生效。
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

type CacheEntry<T> = { expiresAt: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

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

// A 股交易时段判断（北京时间 UTC+8）：周一至周五 09:30-11:30、13:00-15:00。
// hotwave_server 进程时区不一定是 Asia/Shanghai，故用 UTC 换算。
function isAshareTradingTime(): boolean {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const bjHour = (utcHours + 8) % 24;
  const bjTotalMin = bjHour * 60 + now.getUTCMinutes();
  // UTC 16:00 起北京已是次日
  let bjDay = now.getUTCDay();
  if (utcHours >= 16) bjDay = (bjDay + 1) % 7;
  if (bjDay === 0 || bjDay === 6) return false; // 周日/周六
  return (
    (bjTotalMin >= 9 * 60 + 30 && bjTotalMin < 11 * 60 + 30) ||
    (bjTotalMin >= 13 * 60 && bjTotalMin < 15 * 60)
  );
}

// 行情数据 TTL：交易时段用短 TTL（≤前端 2 秒轮询间隔，保证每次轮询拿到新数据），
// 非交易时段用长 TTL 省请求（数据本身不动）。
function tradingTtl(idleMs: number, tradingMs: number): number {
  return isAshareTradingTime() ? tradingMs : idleMs;
}

// 腾讯盘口接口返回 GBK 编码，必须用 GBK 解码，否则中文名乱码
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 HotWave/1.0',
      Referer: 'https://stockapp.finance.qq.com/',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder('gbk').decode(buffer);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 HotWave/1.0',
      Referer: 'https://stockapp.finance.qq.com/',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseTencentQuote(raw: string, symbol: string) {
  const normalized = normalizeStockSymbol(symbol);
  const match = raw.match(/="([^"]*)"/);
  const parts = (match?.[1] || '').split('~');
  const name = parts[1] || pureStockCode(normalized);
  const code = parts[2] || pureStockCode(normalized);
  const price = num(parts[3]);
  const preClose = num(parts[4]);
  const open = num(parts[5]);
  const volume = num(parts[6]);
  const buy1Volume = num(parts[10]);
  const buy1Price = num(parts[9]);
  const sell1Volume = num(parts[20]);
  const sell1Price = num(parts[19]);
  const high = num(parts[33]);
  const low = num(parts[34]);
  // 腾讯 parts[37] 成交额单位为「万元」，统一转成元。
  const amount = num(parts[37]) * 1e4;
  const change = num(parts[31]) || price - preClose;
  const pctChg = num(parts[32]) || (preClose ? (change / preClose) * 100 : 0);
  // 换手率：parts[38]（与自算 成交额/流通市值 吻合：茅台0.36≈0.37%、东方锆业39.73≈37.95%）
  const turnover = num(parts[38]);
  const pe = num(parts[39]);
  const pb = num(parts[46]);
  // 腾讯市值单位为「亿元」(parts[45]=总市值、parts[44]=流通市值)，统一转成元。
  const marketCap = num(parts[45]) * 1e8;
  const flowMarketCap = num(parts[44]) * 1e8;
  // 量比：parts[49]（涨停放量股 parts[49]>1：东方锆业4.65/名家汇2.53；缩量股<1：茅台0.89，符合量比特征）
  const volumeRatio = num(parts[49]);
  // 当日均价 = 成交额 / 成交量(股)；腾讯成交量 parts[6] 单位为手，×100 转股
  const averagePrice = volume > 0 ? amount / (volume * 100) : price;

  const buy = [1, 2, 3, 4, 5].map((level) => ({
    level,
    price: num(parts[7 + level * 2]),
    volume: num(parts[8 + level * 2]),
  }));
  const sell = [1, 2, 3, 4, 5].map((level) => ({
    level,
    price: num(parts[17 + level * 2]),
    volume: num(parts[18 + level * 2]),
  }));
  // 委比 = (五档买盘总量 − 五档卖盘总量) / (买+卖) × 100%
  const buyVolSum = buy.reduce((s, b) => s + b.volume, 0);
  const sellVolSum = sell.reduce((s, b) => s + b.volume, 0);
  const commitRatio = buyVolSum + sellVolSum > 0
    ? ((buyVolSum - sellVolSum) / (buyVolSum + sellVolSum)) * 100
    : 0;

  return {
    symbol: normalized,
    code,
    tsCode: toTsCode(normalized),
    market: stockMarket(normalized),
    isIndex: isIndexSymbol(normalized),
    name,
    price,
    preClose,
    open,
    high,
    low,
    change,
    pctChg,
    volume,
    amount,
    turnover,
    pe,
    pb,
    marketCap,
    flowMarketCap,
    volumeRatio,
    commitRatio,
    averagePrice,
    buy1Price,
    buy1Volume,
    sell1Price,
    sell1Volume,
    buy,
    sell,
    rawUpdatedAt: parts[30] || '',
  };
}

export async function searchStocks(userId: number, q: string) {
  const query = q.trim();
  if (!query) return [];
  const key = `search:${query}`;
  const cached = getCache<unknown[]>(key);
  if (cached) return cached;
  const result = await callHotwave<unknown[]>(userId, 'monitor.search_stocks', { q: query });
  return setCache(key, result, 60_000);
}

export async function getStockQuote(symbol: string) {
  const normalized = normalizeStockSymbol(symbol);
  const key = `quote:${normalized}`;
  const cached = getCache<ReturnType<typeof parseTencentQuote>>(key);
  if (cached) return cached;
  const url = `https://web.sqt.gtimg.cn/q=${encodeURIComponent(toTencentSymbol(normalized))}`;
  const text = await fetchText(url);
  return setCache(key, parseTencentQuote(text, normalized), tradingTtl(3_000, 1_000));
}

export async function getStockDetail(symbol: string) {
  const quote = await getStockQuote(symbol);
  return {
    ...quote,
    type: 'stock',
    description: `${quote.name}(${quote.tsCode})`,
  };
}

function parseKlineRows(rows: unknown[] | undefined) {
  return (rows || []).map((row) => {
    const arr = Array.isArray(row) ? row : String(row).split(' ');
    return {
      time: String(arr[0] || ''),
      open: num(arr[1]),
      close: num(arr[2]),
      high: num(arr[3]),
      low: num(arr[4]),
      volume: num(arr[5]),
      amount: num(arr[6]),
    };
  }).filter((item) => item.time);
}

// mkline 仅支持分钟K线(m5/m15/m30/m60)；日/周/月/年K 必须用 fqkline/get
const MINUTE_PERIODS = ['m5', 'm15', 'm30', 'm60'];
const FQ_PERIOD_KEY: Record<string, string> = {
  day: 'qfqday',
  week: 'qfqweek',
  month: 'qfqmonth',
};

type KlineRow = {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
};

// 腾讯 fqkline 不支持 quarter；year 端点仅返回当年。
// 两者都改为用 month 数据本地聚合：quarter 按自然季度，year 按自然年。
function aggregateMonth(monthRows: KlineRow[], bucket: 'quarter' | 'year'): KlineRow[] {
  const grouped = new Map<string, KlineRow>();
  for (const row of monthRows) {
    const year = row.time.slice(0, 4);
    const m = Number(row.time.slice(5, 7));
    if (!m) continue;
    const gKey = bucket === 'year' ? year : `${year}-Q${Math.ceil(m / 3)}`;
    const existing = grouped.get(gKey);
    if (!existing) {
      grouped.set(gKey, { ...row });
    } else {
      existing.high = Math.max(existing.high, row.high);
      existing.low = Math.min(existing.low, row.low);
      existing.volume += row.volume;
      existing.amount += row.amount;
      existing.close = row.close; // 收盘取该周期最后一个月收盘
      existing.time = row.time;   // 时间取该周期最后一个月日期
    }
  }
  return Array.from(grouped.values());
}

export async function getStockKline(symbol: string, period: string = 'day', limit: number = 320) {
  const normalized = normalizeStockSymbol(symbol);
  const safePeriod = [...MINUTE_PERIODS, 'day', 'week', 'month', 'quarter', 'year'].includes(period) ? period : 'day';
  const key = `kline:${normalized}:${safePeriod}:${limit}`;
  const cached = getCache<unknown[]>(key);
  if (cached) return cached;

  // 注意：腾讯 kline 接口的 param 不接受 URL 编码的逗号(%2C)，否则返回 param error；
  // 因此只对 symbol 编码，分隔逗号保持原样。
  // param 格式：mkline = code,period,start,end,count；fqkline = code,period,start,end,count,type
  // start/end 留空即两个空字段，故 period 与 count 之间为三个逗号 ,,,。
  const sym = encodeURIComponent(normalized);

  // 分钟K线用 mkline
  if (MINUTE_PERIODS.includes(safePeriod)) {
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${sym},${safePeriod},,,${limit}`;
    const json = await fetchJson<any>(url);
    return setCache(key, parseKlineRows(json?.data?.[normalized]?.[safePeriod] || []), tradingTtl(60_000, 2_000));
  }

  // 季K/年K：腾讯不支持或仅当年，改用月K本地聚合
  if (safePeriod === 'quarter' || safePeriod === 'year') {
    const monthLimit = Math.max(limit * (safePeriod === 'quarter' ? 3 : 12), 320);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},month,,,${monthLimit},qfq`;
    const json = await fetchJson<any>(url);
    const monthRows = parseKlineRows(json?.data?.[normalized]?.qfqmonth || []) as KlineRow[];
    const aggregated = aggregateMonth(monthRows, safePeriod === 'quarter' ? 'quarter' : 'year');
    return setCache(key, aggregated, tradingTtl(60_000, 5_000));
  }

  // 日/周/月K 用 fqkline
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},${safePeriod},,,${limit},qfq`;
  const json = await fetchJson<any>(url);
  return setCache(key, parseKlineRows(json?.data?.[normalized]?.[FQ_PERIOD_KEY[safePeriod]] || []), tradingTtl(60_000, 5_000));
}

export async function getStockTimeline(symbol: string, range: string = '1d') {
  const normalized = normalizeStockSymbol(symbol);
  const safeRange = range === '5d' ? '5d' : '1d';
  const key = `timeline:${normalized}:${safeRange}`;
  const cached = getCache<unknown[]>(key);
  if (cached) return cached;
  const url = safeRange === '5d'
    ? `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${encodeURIComponent(normalized)}`
    : `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(normalized)}`;
  const json = await fetchJson<any>(url);
  const data = json?.data?.[normalized] || {};
  // 腾讯分时数据字段：time price cumVolume cumAmount（无均价字段）。
  // - cumVolume 是【累计成交量】(单位手)，需做差得到每分钟增量 vol = cumVolume - prevCumVolume（参考 huohuo_stock_app），
  //   否则成交量柱状图会单调递增成累加形式。
  // - 均价 VWAP = 累计成交额 / 累计成交股数(amount / (cumVolume*100))；5 日分时按每个交易日独立累计与重置。
  type Point = { time: string; price: number; volume: number; amount: number; avgPrice: number };
  // 腾讯分时 arr：[time, price, cumVolume(当日累计量/手), cumAmount(当日累计额/元)]。
  // cumVolume/cumAmount 已是当日累计，VWAP = cumAmount / (cumVolume*100)，无需再累加。
  // volume/amount 存当分钟增量（cum - prevCum），每个交易日重置 prev。
  const pushPoint = (
    out: Point[],
    arr: any[],
    cum: { prevVol: number; prevAmount: number },
  ) => {
    const timeStr = String(arr[0] || '');
    if (!timeStr) return;
    const price = num(arr[1]);
    const cumVolume = num(arr[2]);
    const cumAmount = num(arr[3]);
    const volume = Math.max(cumVolume - cum.prevVol, 0); // 当分钟成交量增量
    const amount = Math.max(cumAmount - cum.prevAmount, 0); // 当分钟成交额增量
    cum.prevVol = cumVolume;
    cum.prevAmount = cumAmount;
    out.push({
      time: timeStr,
      price,
      volume,
      amount,
      avgPrice: cumVolume > 0 ? cumAmount / (cumVolume * 100) : price,
    });
  };

  const parsed: Point[] = [];
  if (safeRange === '5d') {
    // 腾讯 5d 接口 data.data 按日期"新→旧"返回（今天在前）。
    // 五日分时需按时间正序（旧→新）拼接成连续曲线，否则曲线方向会反，
    // 表现为整体上涨/下跌与日K相反。按 date 升序排序后再拼接。
    const days = (Object.values(data?.data || {}) as any[])
      .filter((day) => day && day.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const day of days) {
      const cum = { prevVol: 0, prevAmount: 0 }; // 每个交易日独立累计与重置
      for (const row of (day?.data || []) as any[]) {
        const arr = Array.isArray(row) ? row : String(row).split(' ');
        pushPoint(parsed, arr, cum);
      }
    }
  } else {
    const rows = (data?.data?.data || data?.data || []) as any[];
    const cum = { prevVol: 0, prevAmount: 0 };
    for (const row of rows) {
      const arr = Array.isArray(row) ? row : String(row).split(' ');
      pushPoint(parsed, arr, cum);
    }
  }
  return setCache(key, parsed, safeRange === '5d' ? tradingTtl(30_000, 5_000) : tradingTtl(5_000, 2_000));
}

export async function getStockTrades(symbol: string, limit: number = 50) {
  // 优先东方财富逐笔成交（含主动买卖方向 f55: 1买/2卖/4中性）；
  // 接口不稳定或无数据时 fallback 腾讯分时（无方向，保底有成交数据）。
  try {
    const trades = await getEastmoneyTrades(symbol, limit);
    if (trades.length > 0) return trades;
  } catch {
    // 东方财富不可用，继续 fallback
  }
  const timeline = await getStockTimeline(symbol, '1d') as any[];
  return timeline.slice(-limit).reverse().map((item, index) => ({
    id: `${item.time}-${index}`,
    time: item.time,
    price: item.price,
    volume: item.volume,
    amount: item.amount,
    side: 'neutral',
  }));
}

type StockSearchResult = {
  symbol: string;
  name: string;
  tsCode: string;
  type: number;
  rank?: number;
};

async function fetchEastmoneyJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': AGENT,
      Referer: 'https://vipmoney.eastmoney.com/',
      Host: 'emappdata.eastmoney.com',
      'Content-Type': 'application/json',
      Origin: 'https://vipmoney.eastmoney.com',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function fetch10jqkaJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': AGENT,
      Referer: 'https://eq.10jqka.com.cn/',
      Host: 'dq.10jqka.com.cn',
      'Content-Type': 'application/json',
      Origin: 'https://eq.10jqka.com.cn',
      Accept: '*/*',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function jqkaMarketPrefix(market: number, code: string): string {
  if (market === 17) return 'sh';
  if (market === 33) return 'sz';
  return stockPrefixByCode(code);
}

async function enrichNames(list: StockSearchResult[]) {
  await Promise.allSettled(
    list.map(async (item) => {
      if (item.name && item.name !== item.symbol) return;
      try {
        const quote = await getStockQuote(item.symbol);
        if (quote?.name) item.name = quote.name;
      } catch {
        // keep empty name
      }
    }),
  );
}

export async function getEastmoneyHotStocks(): Promise<StockSearchResult[]> {
  const key = 'hot:eastmoney';
  const cached = getCache<StockSearchResult[]>(key);
  if (cached) return cached;

  const data = await fetchEastmoneyJson<any>('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
    appId: 'appId01',
    globalId: '786e4c21-70dc-435a-93bb-38',
    marketType: '',
    pageNo: 1,
    pageSize: 100,
    _t: Math.random(),
  });

  const list: StockSearchResult[] = ((data?.data as any[]) || []).map((item: any) => {
    const sc = String(item.sc || '').toLowerCase(); // e.g. sh603650
    const symbol = normalizeStockSymbol(sc);
    return {
      symbol,
      name: '',
      tsCode: toTsCode(symbol),
      type: 1,
      rank: Number(item.rk) || 0,
    };
  }).filter((item) => item.symbol.length >= 8);

  await enrichNames(list);
  return setCache(key, list, 60_000);
}

export async function get10jqkaHotStocks(): Promise<StockSearchResult[]> {
  const key = 'hot:10jqka';
  const cached = getCache<StockSearchResult[]>(key);
  if (cached) return cached;

  const url = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock';
  const data = await fetch10jqkaJson<any>(`${url}?stock_type=a&type=hour&list_type=normal&_t=${Math.random()}`);

  const list: StockSearchResult[] = ((data?.data?.stock_list as any[]) || []).map((item: any) => {
    const code = String(item.code || '');
    const prefix = jqkaMarketPrefix(Number(item.market) || 0, code);
    const symbol = `${prefix}${code}`;
    return {
      symbol,
      name: String(item.name || ''),
      tsCode: toTsCode(symbol),
      type: 1,
      rank: Number(item.order) || 0,
    };
  }).filter((item) => item.symbol.length >= 8);

  return setCache(key, list, 60_000);
}

export async function getRisingStocks(): Promise<StockSearchResult[]> {
  const key = 'hot:rising';
  const cached = getCache<StockSearchResult[]>(key);
  if (cached) return cached;

  const data = await fetchEastmoneyJson<any>('https://emappdata.eastmoney.com/stockrank/getAllHisRcList', {
    appId: 'appId01',
    globalId: '786e4c21-70dc-435a-93bb-38',
    marketType: '',
    pageNo: 1,
    pageSize: 100,
    _t: Math.random(),
  });

  const list: StockSearchResult[] = ((data?.data as any[]) || []).map((item: any) => {
    const sc = String(item.sc || '').toLowerCase();
    const symbol = normalizeStockSymbol(sc);
    return {
      symbol,
      name: '',
      tsCode: toTsCode(symbol),
      type: 1,
      rank: Number(item.hrcrk) || Number(item.rk) || 0,
    };
  }).filter((item) => item.symbol.length >= 8);

  await enrichNames(list);
  return setCache(key, list, 60_000);
}

export async function getHotStocks(userId: number, type: string = 'a', source?: string) {
  const key = source ? `hot:${source}` : `hot:${type}`;
  const cached = getCache<StockSearchResult[]>(key);
  if (cached) return cached;

  if (source === 'eastmoney') return getEastmoneyHotStocks();
  if (source === '10jqka') return get10jqkaHotStocks();
  if (source === 'rising') return getRisingStocks();

  const list = await callHotwave<any[]>(userId, 'monitor.search_stocks', { q: '' }).catch(() => []);
  const fallback = [
    { symbol: '000001', ts_code: '000001.SZ', name: '平安银行', type: 1 },
    { symbol: '600519', ts_code: '600519.SH', name: '贵州茅台', type: 1 },
    { symbol: '300750', ts_code: '300750.SZ', name: '宁德时代', type: 1 },
    { symbol: '000858', ts_code: '000858.SZ', name: '五粮液', type: 1 },
  ];
  return setCache(key, (list && list.length ? list.slice(0, 20) : fallback), 60_000);
}

