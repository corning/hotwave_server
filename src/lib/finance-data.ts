// 迁移自 hotwave/src/tools/finance.ts 的独有数据源（hotwave_server 原 stock-data/eastmoney-data 未覆盖）：
// - 东方财富榜单（5 类：A股热榜/涨幅榜/ETF/港股/美股）
// - 同花顺热榜（带 stock_type/type/list_type 参数）
// - 东方财富 F10 原始数据（8 种 reportName）
// 供 /api/hotwave/* 端点分发，hotwave finance 工具不再直连外部网址。

import { getStockQuote } from './stock-data';

const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

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

/** 生成 UUID-like 随机字符串（对齐 hotwave getRandom，东财接口要求 rnd 参数） */
function getRandom(prefix = 'rnd_'): string {
  const hexChars = '0123456789ABCDEF';
  const chars: string[] = [];
  for (let i = 0; i < 32; i++) {
    chars.push(hexChars[Math.floor(Math.random() * 16)]);
  }
  chars[12] = '4';
  const original = parseInt(chars[16], 16);
  chars[16] = ((original & 3) | 8).toString(16).toUpperCase();
  return prefix + chars.join('');
}

// ============== 东方财富榜单（5 类） ==============

/**
 * 东方财富热榜（迁移自 hotwave finance.ts financeEastmoneyHotTool）。
 * type: 'hot'(A股热榜) | 'rise'(涨幅榜) | 'etf'(ETF热榜) | 'hk'(港股) | 'us'(美股)，默认 'hot'
 *
 * 注意：东财榜单接口返回精简结构 data:[{sc,rk,rc,hisRc}]（无 name/涨幅），
 * 原 hotwave 解析 data?.data?.stock_list 是长期 bug（items 全 undefined）。
 * 此处修正为：code 从 sc 提取，rank/rankChg 映射，A股/ETF 用 getStockQuote 补全名称。
 * 返回字段 {code, name, rank, rankChg, hisRankChg}
 */
export async function getEastmoneyRankList(type: string = 'hot', limit: number = 20): Promise<any[]> {
  const key = `rank:${type}`;
  const cached = getCache<any[]>(key);
  if (cached) return cached.slice(0, limit);

  let url = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList';
  const body: Record<string, unknown> = {
    appId: 'appId01',
    globalId: '786e4c21-70dc-435a-93bb-38',
    marketType: '',
    pageNo: 1,
    pageSize: 100,
    _t: Math.random(),
  };
  if (type === 'rise') {
    url = 'https://emappdata.eastmoney.com/stockrank/getAllHisRcList';
  } else if (type === 'etf') {
    body.marketType = 'etf';
    url = 'https://emappdata.eastmoney.com/fundrank/getAllHisRcETFList';
  } else if (type === 'hk') {
    body.marketType = '000003';
    url = 'https://emappdata.eastmoney.com/stockrank/getAllHisRcHkUsList';
  } else if (type === 'us') {
    body.marketType = '000004';
    url = 'https://emappdata.eastmoney.com/stockrank/getAllCurrHkUsList';
  }

  const resp = await fetch(url, {
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
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const data: any = await resp.json();

  // 东财榜单 data 是数组 [{sc, rk, rc/hrc, hisRc/hrcrk}]；sc 形如 SH600667 / HK|01630 / NASDAQ|AAPL / SH520750
  const raw: any[] = Array.isArray(data?.data) ? data.data : [];
  const items = raw.slice(0, limit).map((item) => {
    const sc = String(item.sc || '');
    const code = sc.includes('|') ? sc.split('|')[1] : sc.replace(/^(SH|SZ|BJ)/i, '');
    return {
      code,
      name: '',
      rank: Number(item.rk) || 0,
      rankChg: Number(item.rc ?? item.hrc) || 0,
      hisRankChg: Number(item.hisRc ?? item.hrcrk) || 0,
    };
  });
  await enrichRankNames(items);
  return setCache(key, items, 60_000).slice(0, limit);
}

/** 榜单补全名称：仅对 6 位数字代码（A股/ETF）调 getStockQuote；HK/US 保留空名（LLM 可用代码后续查 quote） */
async function enrichRankNames(items: any[]) {
  await Promise.allSettled(
    items.map(async (item) => {
      if (!/^\d{6}$/.test(String(item.code || ''))) return;
      try {
        const quote = await getStockQuote(item.code);
        if (quote?.name) item.name = quote.name;
      } catch {
        // keep empty name
      }
    }),
  );
}

// ============== 同花顺热榜（带参数） ==============

/**
 * 同花顺热榜（迁移自 hotwave finance.ts finance10jqkaHotTool）。
 * stock_type 默认 'a'；type: 'hour'|'day'；list_type: 'normal'|'skyrocket'|'tech'|'value'|'trend'
 */
export async function get10jqkaRankList(
  params: { stock_type?: string; type?: string; list_type?: string },
  limit: number = 20,
): Promise<any[]> {
  const stockType = params.stock_type ?? 'a';
  const type = params.type ?? 'hour';
  const listType = params.list_type ?? 'normal';
  const key = `jqka:${stockType}:${type}:${listType}`;
  const cached = getCache<any[]>(key);
  if (cached) return cached.slice(0, limit);

  const url = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock';
  const qs = new URLSearchParams({ stock_type: stockType, type, list_type: listType, _t: String(Math.random()) });
  const resp = await fetch(`${url}?${qs}`, {
    headers: {
      'User-Agent': AGENT,
      Referer: 'https://eq.10jqka.com.cn/',
      Host: 'dq.10jqka.com.cn',
      'Content-Type': 'application/json',
      Origin: 'https://eq.10jqka.com.cn',
      Accept: '*/*',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const data: any = await resp.json();
  // 同花顺返回 {data:{stock_list:[{code,name,rise_and_fall,hot_rank_chg,tag:{concept_tag}}]}}
  // 原 hotwave 解析 data?.data 拿到的是 {stock_list:[...]} 对象（非数组）→ 空列表 bug，此处修正
  const list = data?.data?.stock_list ?? [];
  const items = Array.isArray(list) ? list.slice(0, limit) : [];
  return setCache(key, items, 60_000).slice(0, limit);
}

// ============== 东方财富 F10 原始数据（8 种 reportName） ==============

const F10_REPORT_MAP: Record<string, string> = {
  base: 'RPT_F10_ORG_BASICINFO',
  risk: 'RPT_CUSTOM_RISK_MINESWEEPER_SUMMARIZE',
  hold: 'RPT_F10_EH_HOLDERNUM',
  indicator: 'RPT_DMSK_NEWINDICATOR',
  pepre: 'RPT_PERFORMTREND_RESPREDICT',
  index: 'RTP_F10_INDEX',
  board: 'RPT_F10_CORETHEME_BOARDTYPE',
  margin: 'RPT_MARGIN_STATISTICS_STOCKS',
};

/**
 * 东方财富 F10 原始数据（迁移自 hotwave finance.ts financeF10DataTool，8 种 reportName 能力 100% 保留）。
 * type: 'base'|'risk'|'hold'|'indicator'|'pepre'|'index'|'board'|'margin'
 * code: 带市场后缀，如 '002074.SZ'、'600000.SH'
 * 返回东财原始 JSON（与 hotwave 原工具一致，供 LLM 解析）。
 */
export async function getEastmoneyF10Raw(type: string, code: string): Promise<unknown> {
  const key = `f10raw:${type}:${code}`;
  const cached = getCache<unknown>(key);
  if (cached) return cached;

  const codeArr = code.split('.');
  const useApi1 = ['index', 'margin'];
  const baseUrl = useApi1.includes(type)
    ? 'https://datacenter.eastmoney.com/securities/api/data/get'
    : 'https://datacenter.eastmoney.com/securities/api/data/v1/get';

  const randomNumber = Math.random();
  const rnd = getRandom();
  const paramsMap: Record<string, { pass: boolean; params: string }> = {
    hold: {
      pass: true,
      params: `reportName=RPT_F10_EH_HOLDERNUM&columns=A_MARK%2CB_MARK%2CH_MARK%2CSECUCODE%2CSECURITY_CODE%2CORG_CODE%2CEND_DATE%2CHOLDER_TOTAL_NUM%2CTOTAL_NUM_RATIO%2CHOLDER_A_NUM%2CHOLDER_ANUM_RATIO%2CAVG_FREE_SHARES%2CAVG_FREESHARES_RATIO%2CPRICE%2CAVG_HOLD_AMT%2CHOLD_FOCUS%2CHOLD_RATIO_TOTAL%2CFREEHOLD_RATIO_TOTAL%2CHOLDER_B_NUM%2CHOLDER_H_NUM%2CHOLDER_BNUM_RATIO%2CHOLDER_HNUM_RATIO&filter=(SECUCODE%3D%22${code}%22)&client=APP&source=SECURITIES&pageNumber=1&pageSize=100&sr=-1&st=END_DATE&rdm=${rnd}&v=${randomNumber}`,
    },
    indicator: {
      pass: true,
      params: `reportName=RPT_DMSK_NEWINDICATOR&columns=SECUCODE%2CSECURITY_CODE%2CORG_CODE%2CSECURITY_NAME_ABBR%2CEPS%2CBVPS%2CTOTAL_OPERATE_INCOME%2COPERATE_INCOME_RATIO%2CNETPROFIT%2CNETPROFIT_RATIO%2CGROSS_PROFIT_RATIO%2CNPR%2CROE%2CDEBT%2CCAPITAL_ADEQUACY_RATIO%2CNPL%2CALLOWANCE_NPL%2CCOMMNREVE%2CCOMMNREVE_YOY%2CEARNED_PREMIUM%2CCOMPENSATE_EXPENSE%2CSURRENDER_RATE_LIFE%2CSOLVENCY_AR%2CRESEARCH_EXPENSE%2CRSEXPENSE_RATIO%2CRESEARCH_NUM%2CRESEARCH_NUM_RATIO%2CTOTAL_SHARES%2CA_SHARES_EQUITY%2CFREE_A_SHARES%2CPLEDGE_RATIO%2CGOODWILL%2CCDR_SHARE%2CCDR_CONVERT_RATIO%2CMARKETCAP_A%2CB_SHARES_EQUITY%2CMARKETCAP_B%2CFREE_B_SHARES%2CB_UNIT%2CSECURITYTYPE%2CTRADEMARKET%2CDATE_TYPE%2CIS_PROFIT%2CORG_TYPE%2CIS_VOTE_DIFF%2CLISTING_STATE%2CPE_DYNAMIC_SOURCE%2CPB_NOTICE_SOURCE%2CEPS_SOURCE%2CBVPS_SOURCE%2CTOI_SOURCE%2COIR_SOURCE%2CNETPROFIT_SOURCE%2CNETPROFIT_RATIO_SOURCE%2CGPR_SOURCE%2CNPR_SOURCE%2CROE_SOURCE%2CDEBT_SOURCE%2CNPL_SOURCE%2CALLOWANCE_NPL_SOURCE%2CCAR_SOURCE%2CCOMMNREVE_SOURCE%2CCOMMNREVE_YOY_SOURCE%2CEARNED_PREMIUM_SOURCE%2CCOMPENSATE_EXPENSE_SOURCE%2CSRL_SOURCE%2CSOLVENCY_AR_SOURCE%2CRESEARCH_EXPENSE_SOURCE%2CRSEXPENSE_RATIO_SOURCE%2CRESEARCH_NUM_SOURCE%2CRNR_SOURCE%2CTOTAL_SHARES_SOURCE%2CTMC_SOURCE%2CCDR_SHARE_SOURCE%2CCCR_SOURCE%2CASE_SOURCE%2CFAS_SOURCE%2CMCFA_SOURCE%2CPLEDGE_RATIO_SOURCE%2CMCA_SOURCE%2CGOODWILL_SOURCE%2CBSE_SOURCE%2CMCB_SOURCE%2CFBS_SOURCE%2CMCFB_SOURCE%2CEQUITY_NEW_REPORT%2CDIVIDEND_RATIO%2CDIVIDEND_PAY_RATIO%2CDIVIDEND_RATIO_EXPLAIN%2CDIVIDEND_PAY_RATIO_EXPLAIN%2CDIVIDEND_RATIO_YSS%2CDIVIDEND_PAY_RATIO_YSS&quoteColumns=f9~01~SECURITY_CODE~PE_DYNAMIC%2Cf23~01~SECURITY_CODE~PB_NEW_NOTICE%2Cf20~01~SECURITY_CODE~TOTAL_MARKET_CAP%2Cf21~01~SECURITY_CODE~MARKETCAP_FREE_B%2Cf114~01~SECURITY_CODE~PE_STATIC%2Cf115~01~SECURITY_CODE~PE_TTM%2Cf21~01~SECURITY_CODE~MARKETCAP_FREE_A%2Cf2~01~SECURITY_CODE~f2%2Cf18~01~SECURITY_CODE~f18&filter=(SECUCODE%3D%22${code}%22)&pageNumber=1&pageSize=200&rdm=${rnd}&v=${randomNumber}`,
    },
    base: {
      pass: true,
      params: `reportName=RPT_F10_ORG_BASICINFO&columns=SECUCODE%2CSECURITY_CODE%2CSECURITY_NAME_ABBR%2CSECURITY_TYPE_CODE%2CSECURITY_PINYIN%2CLISTING_DATE%2CTRADE_MARKET%2CTRADE_MARKET_CODE%2CSECURITY_INNER_CODE%2CORG_CODE%2CLISTING_STATE%2CSECURITY_TYPE%2CORG_TYPE%2CCODE_TYPE%2CORG_TYPE_CODE%2CSECUCODE_N%2CCORRECODE%2CCORRECODE_INNER_CODE&filter=(SECURITY_CODE%3D%22${codeArr[0]}%22)&client=APP&source=SECURITIES&pageNumber=1&pageSize=200&sr=-1&rdm=${rnd}&v=${randomNumber}`,
    },
    pepre: {
      pass: true,
      params: `reportName=RPT_PERFORMTREND_RESPREDICT&columns=SECUCODE%2CSECURITY_CODE%2CSECURITY_NAME_ABBR%2CYEAR%2CYEAR_MARK%2CPARENT_NETPROFIT%2CPARENT_NETPROFIT_RATIO%2CPE%2CPEG&filter=(YEAR_MARK%3D%22E%22)(SECUCODE%3D%22${code}%22)&pageNumber=1&pageSize=200&sortTypes=1&sortColumns=RANK&source=SECURITIES&client=APP&rdm=${rnd}&v=${randomNumber}`,
    },
    index: {
      pass: true,
      params: `type=RTP_F10_INDEX&params=${code}&source=SECURITIES&client=APP&rdm=${rnd}&v=${randomNumber}`,
    },
    board: {
      pass: true,
      params: `reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=SECUCODE%2CSECURITY_CODE%2CSECURITY_NAME_ABBR%2CNEW_BOARD_CODE%2CBOARD_NAME%2CSELECTED_BOARD_REASON%2CIS_PRECISE%2CBOARD_RANK%2CBOARD_YIELD%2CDERIVE_BOARD_CODE&quoteColumns=f3~05~NEW_BOARD_CODE~BOARD_YIELD&filter=(SECUCODE%3D%22${code}%22)(IS_PRECISE%3D%221%22)&client=APP&source=SECURITIES&pageNumber=1&pageSize=6&sortTypes=1&sortColumns=BOARD_RANK&rdm=${rnd}&v=${randomNumber}`,
    },
    margin: {
      pass: true,
      params: `type=RPT_MARGIN_STATISTICS_STOCKS&sty=SECUCODE%2CSECURITY_CODE%2CSECURITY_NAME_ABBR%2CTRADE_DATE%2CFIN_BALANCE%2CLOAN_BALANCE&filter=(SECUCODE%3D%22${code}%22)&client=APP&source=SECURITIES&st=TRADE_DATE&sr=-1&p=1&ps=20&rdm=${rnd}&v=${randomNumber}`,
    },
    risk: {
      pass: true,
      params: `reportName=RPT_CUSTOM_RISK_MINESWEEPER_SUMMARIZE&filter=(SECUCODE%3D%22${code}%22)&client=APP&source=SECURITIES&rdm=${rnd}&v=${randomNumber}`,
    },
  };

  if (!(type in F10_REPORT_MAP) || !(type in paramsMap) || !paramsMap[type]!.pass) {
    throw new Error(`不存在的 F10 请求类型: ${type}`);
  }

  const fullUrl = `${baseUrl}?${paramsMap[type]!.params}`;
  const resp = await fetch(fullUrl, {
    headers: {
      'User-Agent': AGENT,
      Referer: 'https://emh5.eastmoney.com/',
      Host: 'datacenter.eastmoney.com',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return setCache(key, data, 600_000);
}
