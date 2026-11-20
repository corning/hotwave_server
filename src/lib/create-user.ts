/**
 * 主机侧创建/重置成员账号（私有部署）。
 *
 * 用法：
 *   npm run create-user -- --phone=13800138000 --password=your-password
 *
 * 说明：
 * - 私有部署无公开注册与短信，账号由主机 owner 预置；
 * - 手机号已存在则重置密码，否则新建（默认随机头像）。
 */
import { hashSync } from 'bcryptjs';
import { loadEnvFile } from './load-env';

function arg(name: string): string {
  const pref = '--' + name + '=';
  const inline = process.argv.find((a) => a.startsWith(pref));
  if (inline) return inline.slice(pref.length);
  const idx = process.argv.indexOf('--' + name);
  if (idx >= 0) return process.argv[idx + 1] || '';
  return '';
}

async function main(): Promise<void> {
  loadEnvFile();
  const { getUserByPhone, createUserWithPassword, updateUserPassword } = await import('./db');

  const phone = arg('phone').trim();
  const password = arg('password');

  if (!/^1\d{10}$/.test(phone)) {
    console.error('用法: npm run create-user -- --phone=13800138000 --password=your-password');
    console.error('错误: phone 必须是 11 位手机号');
    process.exit(1);
  }
  // 私有部署的便捷性与安全性权衡：最低 6 位，少于 8 位给出弱密码警告。
  if (password.length < 6) {
    console.error('错误: 密码至少 6 位');
    process.exit(1);
  }
  if (password.length < 8) {
    console.warn('警告: 密码少于 8 位，仅建议在内网/受信网络中部署时使用');
  }

  const passwordHash = hashSync(password, 10);
  const existing = getUserByPhone(phone);

  if (existing) {
    updateUserPassword(existing.id, passwordHash);
    console.log('已重置密码: ' + phone + ' (id=' + existing.id + ')');
    return;
  }

  const id = createUserWithPassword(phone, passwordHash);
  console.log('已创建账号: ' + phone + ' (id=' + id + ')');
}

main().catch((err) => {
  console.error('[create-user] 执行失败:', err);
  process.exit(1);
});
