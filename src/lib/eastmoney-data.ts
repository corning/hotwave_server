// 东方财富数据源：逐笔成交（含主动买卖方向）+ F10（公司概况/财务摘要）。
// 腾讯接口缺失逐笔成交方向与 F10，故此部分走东方财富。
// quote/kline/timeline 仍用腾讯（stock-data.ts），已支持股票/ETF/北交所。

import { normalizeStockSymbol, pureStockCode, stockMarket, toTsCode } from '@/lib/stock-symbol';

const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': AGENT,
      Referer: 'https://quote.eastmoney.com/',
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

/** 东方财富 secid：沪市 1.code，深/北 0.code */
export function toEastmoneySecid(symbol: string): string {
  const normalized = normalizeStockSymbol(symbol);
  const market = stockMarket(normalized);
  const code = pureStockCode(normalized);
  const prefix = market === 'sh' ? '1' : '0';
  return `${prefix}.${code}`;
}

/** 东方财富 F10 code：SZ000001 / SH600519 / BJ830799 */
function toEastmoneyF10Code(symbol: string): string {
  const tsCode = toTsCode(normalizeStockSymbol(symbol)); // 000001.SZ
  const [code, market] = tsCode.split('.');
  return `${market}${code}`; // SZ000001
}

/**
 * 逐笔成交（含主动买卖方向）。
 * 接口：push2.eastmoney.com/api/qt/stock/details/get
 * details 每条 "time,price,volume,buyCount,side"，side: 1=主动买 2=主动卖 4=中性
 * 返回最新在前（与旧 getStockTrades 行为一致）。
 */
export async function getEastmoneyTrades(symbol: string, limit: number = 50) {
  const secid = toEastmoneySecid(symbol);
  const pos = -Math.min(Math.max(limit, 1), 200);
  const url = `https://push2.eastmoney.com/api/qt/stock/details/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=${pos}&secid=${encodeURIComponent(secid)}&ut=bd1d9ddb04089700994027846b2e7856`;
  const json = await fetchJson<any>(url);
  const details: string[] = json?.data?.details || [];
  // 东方财富返回时间正序（旧->新），翻转使最新在前。
  const reversed = [...details].reverse();
  return reversed.map((line, index) => {
    const parts = String(line).split(',');
    const time = parts[0] || '';
    const price = num(parts[1]);
    const volume = num(parts[2]); // 单位：手
    const sideNum = num(parts[4]);
    const side = sideNum === 1 ? 'buy' : sideNum === 2 ? 'sell' : 'neutral';
    return {
      id: `${time}-${index}`,
      time,
      price,
      volume,
      amount: price * volume * 100, // 手->股：×100
      side,
    };
  });
}

/** F10 公司概况 */
export async function getEastmoneyF10Profile(symbol: string) {
  const code = toEastmoneyF10Code(symbol);
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${code}`;
  const json = await fetchJson<any>(url);
  const jbzl = json?.jbzl?.[0] || {};
  return {
    name: jbzl.ORG_NAME || jbzl.SECURITY_NAME_ABBR || '',
    industry: jbzl.EM2016 || jbzl.INDUSTRYCSRC1 || '',
    mainBusiness: (jbzl.BUSINESS_SCOPE || '').trim(),
    regCapital: num(jbzl.REG_CAPITAL), // 单位：万元
    employees: num(jbzl.EMP_NUM),
    intro: (jbzl.ORG_PROFILE || '').trim(),
    legalPerson: jbzl.LEGAL_PERSON || '',
    secretary: jbzl.SECRETARY || '',
    chairman: jbzl.CHAIRMAN || '',
    address: jbzl.ADDRESS || jbzl.REG_ADDRESS || '',
  };
}

/** F10 财务摘要（最新报告期主要指标） */
export async function getEastmoneyF10Finance(symbol: string) {
  const code = toEastmoneyF10Code(symbol);
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${code}`;
  const json = await fetchJson<any>(url);
  const list = json?.data || [];
  if (!list.length) return null;
  const latest = list[0];
  return {
    reportDate: latest.REPORT_DATE || latest.REPORT_DATE_NAME || '',
    revenue: num(latest.TOTALOPERATEREVE),
    revenueYoy: num(latest.TOTALOPERATEREVETZ),
    netProfit: num(latest.PARENTNETPROFIT),
    netProfitYoy: num(latest.PARENTNETPROFITTZ),
    roe: num(latest.ROEJQ),
    grossMargin: num(latest.XSMLL),
    netMargin: num(latest.XSJLL),
  };
}

/** F10 概况 + 财务（任一失败不阻断另一个） */
export async function getEastmoneyF10(symbol: string) {
  const [profile, finance] = await Promise.allSettled([
    getEastmoneyF10Profile(symbol),
    getEastmoneyF10Finance(symbol),
  ]);
  return {
    profile: profile.status === 'fulfilled' ? profile.value : null,
    finance: finance.status === 'fulfilled' ? finance.value : null,
  };
}
