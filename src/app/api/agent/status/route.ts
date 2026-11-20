import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { getAgentStatus } from '@/lib/agent-manager';
import type { MessageResponse } from '@/types';
import type { NextResponse } from 'next/server';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  try {
    const status = getAgentStatus();
    return corsResponse({ agents: status }, 200);
  } catch (error) {
    console.error('[agent/status] Error:', error);
    return corsResponse({ message: '服务器异常' } as MessageResponse, 500);
  }
}
