#!/usr/bin/env node
/**
 * hotwave_server 启动器：自动选择 Node >= MIN_MAJOR 后再执行 next。
 *
 * 为什么需要：macOS 上 DevEco Studio / 系统自带 node18 常遮蔽 nvm，
 * 而本项目依赖 Node >= 22（better-sqlite3 原生模块按 ABI 编译，
 * 用错版本会报 "Could not locate the bindings file"）。
 *
 * 用法：
 *   node scripts/dev.mjs dev     # next dev（默认 127.0.0.1:8000）
 *   node scripts/dev.mjs start   # next start
 *
 * 可通过 BIND_HOST / PORT 环境变量（或 .env）修改监听地址与端口。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const MIN_MAJOR = 22;
const PORT = Number(process.env.PORT || envFromFile('PORT') || 8000);
const HOST = process.env.BIND_HOST || envFromFile('BIND_HOST') || '127.0.0.1';
const TARGETS = {
  dev: ['next', 'dev', '-p', String(PORT), '-H', HOST],
  start: ['next', 'start', '-p', String(PORT), '-H', HOST],
};

const target = process.argv[2] || 'dev';
const nextArgs = TARGETS[target];
if (!nextArgs) {
  console.error('[dev] 未知目标: ' + target + '（可用: ' + Object.keys(TARGETS).join(', ') + '）');
  process.exit(1);
}

const majorOf = (bin) => {
  try {
    return Number(execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0]);
  } catch {
    return -1;
  }
};

const versionValue = (v) => {
  const [, major, minor, patch] = (v.match(/^v(\d+)\.(\d+)\.(\d+)/) || []).map(Number);
  return (major || 0) * 1e6 + (minor || 0) * 1e3 + (patch || 0);
};

const currentMajor = Number(process.version.replace(/^v/, '').split('.')[0]);

function candidates() {
  const list = [];
  if (process.env.NODE_BIN) list.push(process.env.NODE_BIN);
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    const dirs = fs
      .readdirSync(versionsDir)
      .filter((d) => /^v\d+/.test(d))
      .sort((a, b) => versionValue(b) - versionValue(a));
    for (const d of dirs) list.push(path.join(versionsDir, d, 'bin', 'node'));
  } catch { /* 未安装 nvm */ }
  list.push('/usr/local/bin/node', '/opt/homebrew/bin/node');
  return list;
}

let chosen = currentMajor >= MIN_MAJOR ? process.execPath : null;
if (!chosen) {
  for (const bin of candidates()) {
    if (!bin || !fs.existsSync(bin) || bin === process.execPath) continue;
    if (majorOf(bin) >= MIN_MAJOR) { chosen = bin; break; }
  }
}

if (!chosen) {
  console.error(
    '[dev] 未找到 Node >= ' + MIN_MAJOR + '。\n' +
    '  请安装 nvm 后执行 nvm install 22 && nvm use 22，或设置 NODE_BIN=/path/to/node。',
  );
  process.exit(1);
}

if (chosen !== process.execPath && currentMajor < MIN_MAJOR) {
  const v = execFileSync(chosen, ['-v'], { encoding: 'utf8' }).trim();
  console.log('[dev] 当前 Node ' + process.version + ' 不满足 >= ' + MIN_MAJOR + '，已自动切换到 ' + v);
}


// 预检：better-sqlite3 原生绑定必须与所选 Node 的 ABI 匹配，
// 否则 instrumentation 会在启动时抛 "Could not locate the bindings file"。
// 这里只做一次轻量探测，失败时给出明确修复命令，避免用户看一长串 tried 路径。
try {
  execFileSync(chosen, ['-e', "const D=require('better-sqlite3');new D(':memory:').close()"], {
    cwd: process.cwd(),
    stdio: 'ignore',
    timeout: 15000,
  });
} catch {
  console.error(
    '[dev] better-sqlite3 原生绑定与当前 Node (' + (execFileSync(chosen, ['-v'], { encoding: 'utf8' }).trim()) + ') 不匹配。\n' +
    '  修复：cd hotwave_server && npm rebuild better-sqlite3\n' +
    '  （换过 Node 大版本后必须重建一次）',
  );
  process.exit(1);
}

// 用所选 Node 跑 next CLI（node <next bin> ...）
const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
if (!fs.existsSync(nextBin)) {
  console.error('[dev] 找不到 next CLI：' + nextBin + '（请先 npm install）');
  process.exit(1);
}

const basePort = PORT;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    // 必须与 next 的绑定地址一致，否则会误判为"空闲"
    srv.listen(port, HOST);
  });
}

// 从 .env 读 WS 端口（Next 尚未加载 .env，这里只做最小解析）
function envFromFile(key) {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const m = raw.match(new RegExp('^' + key + '\\s*=\\s*(\\S+)', 'm'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const wsPort = Number(process.env.HOTWAVE_WS_PORT || envFromFile('HOTWAVE_WS_PORT') || 18791);

// 端口固定：只允许一个实例；占用即失败退出（不递延）。
for (const port of [basePort, wsPort]) {
  if (await portFree(port)) continue;
  console.error(
    '[dev] 端口 ' + port + ' 已被占用，本进程退出（hotwave_server 同一时间只允许一个实例）。\n' +
      '  排查占用者：lsof -nP -iTCP:' + port + ' -sTCP:LISTEN\n' +
      '  若占用者是系统常驻服务，先停它（launchd 示例）：\n' +
      '    launchctl bootout gui/$(id -u)/<your-service-label>',
  );
  process.exit(1);
}

const spawnArgs = nextArgs.slice(1);
const child = spawn(chosen, [nextBin, ...spawnArgs], { stdio: 'inherit', env: process.env, cwd: process.cwd() });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
