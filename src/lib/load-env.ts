import fs from 'node:fs';
import path from 'node:path';

/**
 * 轻量 .env 加载器（脚本用，不依赖 dotenv）。
 *
 * Next.js 会自行加载 .env；但 seed / create-user 等 tsx 脚本不会。
 * 优先用 Node 内置 process.loadEnvFile（Node >= 20.12），不可用时回退到最小解析。
 * 已存在的环境变量不会被覆盖。
 */
export function loadEnvFile(file: string = '.env'): void {
  const absolute = path.resolve(process.cwd(), file);
  if (!fs.existsSync(absolute)) return;

  const nativeLoader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof nativeLoader === 'function') {
    try {
      nativeLoader(absolute);
      return;
    } catch {
      /* 回退到手动解析 */
    }
  }

  for (const rawLine of fs.readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
