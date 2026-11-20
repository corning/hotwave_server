import type { AgentInfo } from '@/types';
import { hotwaveConnections } from './hotwave-ws-server';

interface AgentConfig {
  id: string;
  name: string;
  description: string;
  type: 'mock' | 'http' | 'ws';
  endpoint?: string;
}

// 唯一真实 Agent 是 hotwave：connected 状态来自是否有 hotwave 长连接接入
// （用户在 APP 绑定并启动 hotwave 后，hotwave 用 binding 凭证主动连入本服务）。
const AGENTS: AgentConfig[] = [
  {
    id: 'hotwave',
    name: 'HotWave',
    description: 'HotWave 金融 AI Agent',
    type: 'ws',
  },
];

/** agent 列表（connected = 是否有 hotwave 长连接接入） */
export function getAgentList(): AgentInfo[] {
  const connected = hotwaveConnections.anyConnected();
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    type: a.type,
    endpoint: a.endpoint,
    connected,
  }));
}

/** agent 状态 */
export function getAgentStatus(): Record<string, { connected: boolean }> {
  const connected = hotwaveConnections.anyConnected();
  const status: Record<string, { connected: boolean }> = {};
  for (const agent of AGENTS) {
    status[agent.id] = { connected };
  }
  return status;
}
