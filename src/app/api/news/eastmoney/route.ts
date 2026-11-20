import { corsOptions, corsResponse } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import type { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

// 东财 7X24 小时快讯接口（fastColumn=102）。服务端抓取后做字段清洗与短时缓存。
// 分页采用东财 sortEnd 游标：第一页 sortEnd 为空，后续页传上一页返回的 sortEnd，
// 返回更早（时间向前）的资讯。hasMore = 本页满 size。
const EASTMONEY_URL =
  'https://np-listapi.eastmoney.com/comm/web/getFastNewsList';

// 仅缓存第一页（sortEnd 空），按 size 分桶（避免不同 size 互相覆盖），60s TTL。
const cache = new Map<
  number,
  { ts: number; rows: any[]; sortEnd: string; hasMore: boolean }
>();
const CACHE_TTL = 60_000;

// 东财 summary 形如「【标题】正文」，去掉【标题】前缀只留正文。
function cleanSummary(summary: string): string {
  let s = (summary || '').trim();
  if (s.startsWith('【')) {
    const end = s.indexOf('】');
    if (end > 0) s = s.substring(end + 1).trim();
  }
  return s;
}

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: NextRequest) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const params = new URL(request.url).searchParams;
  const size = Math.max(Math.min(Number(params.get('size') || 10), 50), 1);
  const sortEnd = params.get('sortEnd') || '';

  if (!sortEnd) {
    const c = cache.get(size);
    if (c && Date.now() - c.ts < CACHE_TTL) {
      return corsResponse({
        ok: true,
        payload: { rows: c.rows, sortEnd: c.sortEnd, hasMore: c.hasMore },
      });
    }
  }

  try {
    const url = `${EASTMONEY_URL}?client=web&biz=web_724&fastColumn=102&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=${size}&req_trace=1`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: 'https://kuaixun.eastmoney.com/',
      },
      cache: 'no-store',
    });
    if (!resp.ok) {
      return corsResponse({ ok: false, error: `eastmoney ${resp.status}` }, 502);
    }
    const json: any = await resp.json();
    const rawList = json?.data?.fastNewsList ?? [];
    const nextSortEnd = json?.data?.sortEnd ?? '';
    const rows = rawList.map((n: any) => ({
      id: n.code ?? '',
      title: n.title ?? '',
      summary: cleanSummary(n.summary ?? ''),
      // showTime 已是北京时间字符串，原样透传，前端不再做时区转换。
      time: n.showTime ?? '',
      commentCount: Number(n.pinglun_Num ?? 0),
      images: Array.isArray(n.image) ? n.image : [],
    }));
    const hasMore = rows.length >= size;
    if (!sortEnd) cache.set(size, { ts: Date.now(), rows, sortEnd: nextSortEnd, hasMore });
    return corsResponse({
      ok: true,
      payload: { rows, sortEnd: nextSortEnd, hasMore },
    });
  } catch (err) {
    console.error('[news/eastmoney] error:', err);
    return corsResponse({ ok: false, error: String(err) }, 500);
  }
}
