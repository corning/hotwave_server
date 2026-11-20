import { corsResponse, corsOptions } from '@/lib/cors';
import { getAgentList } from '@/lib/agent-manager';

export async function OPTIONS() {
  return corsOptions();
}

export async function GET() {
  try {
    const agents = getAgentList();
    return corsResponse({ agents }, 200);
  } catch (error) {
    console.error('[agent/list] Error:', error);
    return corsResponse({ message: '服务器异常' }, 500);
  }
}
