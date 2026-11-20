import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getChatHistory } from '@/lib/db';
import type { MessageResponse } from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId') || undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const offset = parseInt(searchParams.get('offset') || '0');
  const date = searchParams.get('date') || undefined;
  const before = searchParams.get('before')
    ? parseInt(searchParams.get('before')!)
    : undefined;
  const beforeDate = searchParams.get('beforeDate') || undefined;

  try {
    const rows = getChatHistory(auth.userId, agentId, limit, offset, date, before, beforeDate);

    const messages = rows.map((row: any) => ({
      id: row.id,
      role: row.role,
      agentId: row.agent_id,
      content: row.content,
      createdAt: row.created_at,
    }));

    return corsResponse({ messages }, 200);
  } catch (error) {
    console.error('[chat/history] Error:', error);
    return corsResponse({ message: '服务器异常' } as MessageResponse, 500);
  }
}
