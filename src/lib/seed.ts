/**
 * 初始化 SQLite 数据库（建目录 + 建表 + WAL），不预置任何可登录账号。
 *
 * 用法：
 *   npm run seed
 *
 * 建表逻辑集中在 src/lib/db.ts：本脚本导入该模块即完成初始化，
 * 随后可执行 npm run create-user 预置账号。
 */
import { loadEnvFile } from './load-env';

loadEnvFile();

async function main(): Promise<void> {
  const { default: db } = await import('./db');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;

  console.log('[seed] 数据库初始化完成');
  console.log('  表: ' + tables.map((t) => t.name).join(', '));
  console.log('');
  console.log('  下一步：预置一个可登录账号');
  console.log('    npm run create-user -- --phone=13800138000 --password=your-password');
  console.log('');
  console.log('  然后在 APP 中登录并创建 hotwave 绑定，把生成的');
  console.log('  TRADE_BINDING_ID / TRADE_BINDING_SECRET 写入 hotwave 的 .env。');

  db.close();
}

main().catch((err) => {
  console.error('[seed] 初始化失败:', err);
  process.exit(1);
});
