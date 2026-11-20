export type MarketCode = 'sh' | 'sz' | 'bj' | 'hk' | 'us' | '';

// 指数代码白名单（6 位）。腾讯对指数也用 sh/sz 前缀：
// 上证系列 000xxx → sh，深证系列 399xxx → sz。
const INDEX_WHITELIST: Record<string, { market: 'sh' | 'sz' | 'bj'; name: string }> = {
  '000001': { market: 'sh', name: '上证指数' },
  '000016': { market: 'sh', name: '上证50' },
  '000300': { market: 'sh', name: '沪深300' },
  '000905': { market: 'sh', name: '中证500' },
  '000852': { market: 'sh', name: '中证1000' },
  '399001': { market: 'sz', name: '深证成指' },
  '399006': { market: 'sz', name: '创业板指' },
  '399005': { market: 'sz', name: '中小板指' },
  '399300': { market: 'sz', name: '沪深300' },
  '899050': { market: 'bj', name: '北证50' },
};

/**
 * 是否为指数符号。
 * - `idx` 前缀：指数意图（来自聊天 index: 链接）→ true
 * - 显式 sh/sz/bj 前缀：仅当 (市场, 代码) 命中白名单且市场匹配才算指数
 *   （sz000001 是平安银行个股，sh000001 才是上证指数）
 * - 裸 6 位代码：默认个股，不算指数
 */
export function isIndexSymbol(input: string): boolean {
  const raw = (input || '').trim().toLowerCase();
  if (raw.startsWith('idx')) return true;
  const m = raw.match(/^(sh|sz|bj)(\d{6})$/);
  if (m) {
    const meta = INDEX_WHITELIST[m[2]];
    return !!meta && meta.market === m[1];
  }
  return false;
}

/** 指数显示名称（找不到返回空串） */
export function indexName(input: string): string {
  const raw = (input || '').trim().toLowerCase();
  let code: string;
  if (raw.startsWith('idx')) code = raw.slice(3);
  else code = raw.replace(/^(sh|sz|bj)/, '');
  return INDEX_WHITELIST[code]?.name ?? '';
}

/** 按 6 位代码前缀推断个股市场：6/9→sh，8/4→bj，其余→sz */
export function stockPrefixByCode(code: string): string {
  if (code.startsWith('6') || code.startsWith('9')) return 'sh';
  if (code.startsWith('8') || code.startsWith('4')) return 'bj';
  return 'sz';
}

export function normalizeStockSymbol(input: string): string {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return '';

  // idx 前缀：指数标记（来自聊天链接 index:），解包为 sh/sz + 6 位代码
  if (raw.startsWith('idx')) {
    const code = raw.slice(3);
    const meta = INDEX_WHITELIST[code];
    if (meta) return `${meta.market}${code}`;
    return code;
  }

  // 已带 sh/sz/bj 前缀：尊重显式前缀，不因指数白名单覆盖
  // （sz000001 = 平安银行，sh000001 = 上证指数，二者代码同为 000001 需靠前缀区分）
  if (/^(sh|sz|bj)\d{6}$/.test(raw)) {
    return raw;
  }
  if (/^\d{6}\.(sh|sz|bj)$/i.test(raw)) {
    const [code, market] = raw.split('.');
    return `${market}${code}`;
  }
  // 裸 6 位代码：默认按个股前缀规则（指数需经 idx 前缀或显式 sh/sz 前缀访问）
  if (/^\d{6}$/.test(raw)) {
    return `${stockPrefixByCode(raw)}${raw}`;
  }
  return raw;
}

export function pureStockCode(symbol: string): string {
  const normalized = normalizeStockSymbol(symbol);
  const match = normalized.match(/^(sh|sz|bj)(\d{6})$/);
  return match ? match[2] : normalized.replace(/\.(sh|sz|bj)$/i, '');
}

export function stockMarket(symbol: string): MarketCode {
  const normalized = normalizeStockSymbol(symbol);
  const match = normalized.match(/^(sh|sz|bj)/);
  return (match?.[1] as MarketCode) || '';
}

export function toTsCode(symbol: string): string {
  const normalized = normalizeStockSymbol(symbol);
  const match = normalized.match(/^(sh|sz|bj)(\d{6})$/);
  if (!match) return symbol;
  return `${match[2]}.${match[1].toUpperCase()}`;
}

export function toTencentSymbol(symbol: string): string {
  return normalizeStockSymbol(symbol);
}
