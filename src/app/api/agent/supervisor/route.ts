import { corsResponse, corsOptions } from '@/lib/cors';
import { authenticateRequest } from '@/lib/middleware';
import { hotwaveConnections } from '@/lib/hotwave-ws-server';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { NextResponse } from 'next/server';

const execAsync = promisify(exec);

// Agent 进程托管（P2）：status + restart。
//
// 设计：进程本身由系统服务托管（launchd / systemd），本接口只做"查状态 + 触发重启"，
// 不让 hotwave_server 自己养子进程（避免 hotwave_server 重启连带 agent）。
//
// 启用条件：HOTWAVE_SUPERVISOR_ENABLED=true，否则返回 403（默认关闭，防止误操作）。
// 服务名：HOTWAVE_SUPERVISOR_LABEL，默认 com.hotwave.runtime。
// 注意：网关(:18789)已并入 runtime 单进程，重启 runtime = 重启整个 Agent。

function label(): string {
  return process.env.HOTWAVE_SUPERVISOR_LABEL || 'com.hotwave.runtime';
}

function supervisorEnabled(): boolean {
  return process.env.HOTWAVE_SUPERVISOR_ENABLED === 'true';
}

function buildCommand(action: 'status' | 'restart'): string {
  const name = label();
  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    return action === 'restart'
      ? 'launchctl kickstart -k gui/' + uid + '/' + name
      : 'launchctl print gui/' + uid + '/' + name;
  }
  return action === 'restart'
    ? 'systemctl --user restart ' + name
    : 'systemctl --user is-active ' + name;
}

export async function OPTIONS() {
  return corsOptions();
}

export async function GET(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  const connected = hotwaveConnections.isConnected(auth.userId);
  return corsResponse(
    {
      ok: true,
      payload: {
        connected,
        enabled: supervisorEnabled(),
        supervisor: process.platform === 'darwin' ? 'launchd' : 'systemd',
        label: label(),
      },
    },
    200
  );
}

export async function POST(request: Request) {
  const auth = authenticateRequest(request);
  if (!('userId' in auth)) return auth as NextResponse;

  if (!supervisorEnabled()) {
    return corsResponse(
      {
        ok: false,
        error: 'supervisor 未启用（设置 HOTWAVE_SUPERVISOR_ENABLED=true 后可用）',
      },
      403
    );
  }

  let body: { action?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* ignore */
  }
  const action = body.action || 'restart';
  if (action !== 'restart') {
    return corsResponse({ ok: false, error: 'action must be restart' }, 400);
  }

  try {
    await execAsync(buildCommand('restart'), { timeout: 15000 });
    return corsResponse(
      { ok: true, payload: { action: 'restart', label: label(), accepted: true } },
      200
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse({ ok: false, error: '重启失败：' + msg }, 500);
  }
}
