import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashSync, compareSync } from 'bcryptjs';

// 数据库路径可用 DATABASE_PATH 覆盖（默认 database/hotwave.db）。
// 首次运行自动建目录，避免新克隆仓库因 database/ 不存在而 SQLITE_CANTOPEN。
const DB_PATH = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH || path.join('database', 'hotwave.db'),
);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    nickname TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    market TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'stock',
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, symbol),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );


  CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id, sort_order, created_at);

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('paper', 'live')),
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL DEFAULT '',
    bs_type TEXT NOT NULL CHECK(bs_type IN ('buy', 'sell')),
    price REAL NOT NULL,
    amount INTEGER NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'filled' CHECK(status IN ('pending', 'filled', 'cancelled', 'rejected')),
    entrust_no TEXT NOT NULL DEFAULT '',
    strategy_tag TEXT NOT NULL DEFAULT '',
    pnl REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, mode, created_at);
  CREATE INDEX IF NOT EXISTS idx_trades_stock ON trades(stock_code, mode, created_at);

  CREATE TABLE IF NOT EXISTS execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('paper', 'live')),
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('success', 'failure', 'pending', 'skipped')),
    log_type TEXT NOT NULL DEFAULT 'system' CHECK(log_type IN ('trade', 'risk_control', 'system', 'alert')),
    trade_id INTEGER,
    strategy_tag TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (trade_id) REFERENCES trades(id)
  );

  CREATE INDEX IF NOT EXISTS idx_execution_logs_user ON execution_logs(user_id, mode, created_at);

  -- hotwave 实例与用户的绑定关系。
  -- 一个用户可绑定多个 hotwave 实例（如多设备）；hotwave 用 binding_id + secret 鉴权落库交易，
  -- 交易归属绑定用户（user_id）。secret 仅存哈希，明文只在创建时返回一次；status=revoked 可即时吊销。
  CREATE TABLE IF NOT EXISTS hotwave_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    binding_id TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_hotwave_bindings_user ON hotwave_bindings(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_hotwave_bindings_bid ON hotwave_bindings(binding_id);
`);

// AI 风控规则功能已移除（2026-08），清理已部署库的遗留表（幂等，运行后表即消失，可于下个版本删除此句）
try {
  db.exec('DROP TABLE IF EXISTS risk_rules');
} catch {
  // ignore
}

// 已移除模块的遗留表清理（幂等，运行后表即消失，可于下个版本删除此段）。
// - 技能市场（2026-11：APP 市场 Tab / 服务端 skills 接口 / hotwave skills RPC 全部下线）
// - 评论社区与短信验证码（2026-11 私有化改造，P0 下线）
try {
  db.exec('DROP TABLE IF EXISTS skill_downloads');
  db.exec('DROP TABLE IF EXISTS skill_reactions');
  db.exec('DROP TABLE IF EXISTS skills');
  db.exec('DROP TABLE IF EXISTS comment_reactions');
  db.exec('DROP TABLE IF EXISTS comments');
  db.exec('DROP TABLE IF EXISTS sms_codes');

} catch {
  // ignore
}

// Migrate: add error_message column (safe for existing DBs)
try {
  db.exec('ALTER TABLE chat_messages ADD COLUMN error_message TEXT');
} catch {
  // Column may already exist — ignore
}

// Migrate: add run_id column for heartbeat 报告去重（bridge 与 hotwave 兜底回写同一条简报用同一 runId）
try {
  db.exec('ALTER TABLE chat_messages ADD COLUMN run_id TEXT');
} catch {
  // Column may already exist — ignore
}
// UNIQUE(agent_id, run_id)：仅 _heartbeat_ 用 runId 去重；普通消息 run_id 为 NULL，SQLite 唯一索引中 NULL 互不冲突，不受影响。
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_agent_run ON chat_messages(agent_id, run_id) WHERE run_id IS NOT NULL"
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_created ON chat_messages(agent_id, created_at)"
);

// Migrate: heartbeat 未读状态表（每用户最后查看 heartbeat 对话的时间）
db.exec(
  "CREATE TABLE IF NOT EXISTS heartbeat_read_state (user_id INTEGER PRIMARY KEY, last_read_at TEXT)"
);

// Migrate: heartbeat 简报独立表（彻底移出 chat 体系，简报不再落 chat_messages）
// hotwave message_end 时直写本表；APP 简报中心查询本表。chat_messages 不再承载 _heartbeat_。
db.exec(`
  CREATE TABLE IF NOT EXISTS heartbeat_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_heartbeat_reports_created ON heartbeat_reports(created_at);
`);

// Migrate: heartbeat_reports 扩展 LLM 决策元数据（source/symbol/tokens/cost/trigger_reason）
// 兼容旧数据：新列 DEFAULT，旧行 source 默认 heartbeat，token/cost 默认 0
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'heartbeat'"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN symbol TEXT"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN cost REAL NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE heartbeat_reports ADD COLUMN trigger_reason TEXT"); } catch {}

// Migrate: monitor_alerts 表（hotwave 上行 monitor.alert 事件落库，按用户隔离）。
// hotwave 主动连 hotwave_server 后，monitor_engine 产生 alert 经 gateway broadcast 上行到本表；
// APP 监控页 SSE 实时推送 + 历史回放均查本表。payload 为 alert 原始 JSON。
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_monitor_alerts_user_created ON monitor_alerts(user_id, created_at DESC);
`);

// Migrate: app_configs 表（APP 端配置：启动画面等，key-value + JSON，由部署者维护）。
db.exec(`
  CREATE TABLE IF NOT EXISTS app_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_key TEXT NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate: user_rules 表（黑白名单 + 功能白名单，由部署者按需写入）。
// 支持按 user_id / phone / device_id 三个维度命中；block=黑名单拒绝，allow=白名单放行；
// scope: page 页面级 / action 操作级 / feature 新功能灰度 / all 全局（用户/设备级封禁）。
db.exec(`
  CREATE TABLE IF NOT EXISTS user_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL CHECK(target_type IN ('user_id', 'phone', 'device_id')),
    target_value TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('block', 'allow')),
    scope_type TEXT NOT NULL CHECK(scope_type IN ('page', 'action', 'feature', 'all')),
    scope_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_rules_target ON user_rules(target_type, target_value);
  CREATE INDEX IF NOT EXISTS idx_user_rules_scope ON user_rules(scope_type, scope_key);
`);

// Migrate: app_events 表（APP 端埋点，用于自有统计与排障）。
// 设备信息（机型/IP 等）取自请求头（resolveDeviceInfo），事件主体来自客户端批量上报；
// user_id 宽容关联（带 token 的上报才记录，未登录为 NULL）。
// event_time 由服务端写入 datetime('now')，客户端 10s 批量 flush 误差可接受。
db.exec(`
  CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    device_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    device_model TEXT NOT NULL DEFAULT '',
    os_version TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT 'action',
    event_name TEXT NOT NULL DEFAULT '',
    page_path TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    event_time TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_app_events_time ON app_events(event_time);
  CREATE INDEX IF NOT EXISTS idx_app_events_device ON app_events(device_id);
  CREATE INDEX IF NOT EXISTS idx_app_events_user ON app_events(user_id);
`);

// Migrate: execution_logs.status 加 'skipped' 枚举（T+1 跳过清仓用）
// CHECK 约束不能 ALTER，检测旧表 CHECK 不含 'skipped' 则重建表（保留数据）
try {
  const logsSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='execution_logs'")
    .get() as { sql: string } | undefined;
  if (logsSchema && !logsSchema.sql.includes("'skipped'")) {
    db.exec(`
      CREATE TABLE execution_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('paper', 'live')),
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('success', 'failure', 'pending', 'skipped')),
        log_type TEXT NOT NULL DEFAULT 'system' CHECK(log_type IN ('trade', 'risk_control', 'system', 'alert')),
        trade_id INTEGER,
        strategy_tag TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (trade_id) REFERENCES trades(id)
      );
      INSERT INTO execution_logs_new (id, user_id, mode, title, description, status, log_type, trade_id, strategy_tag, created_at)
        SELECT id, user_id, mode, title, description, status, log_type, trade_id, strategy_tag, created_at FROM execution_logs;
      DROP TABLE execution_logs;
      ALTER TABLE execution_logs_new RENAME TO execution_logs;
      CREATE INDEX IF NOT EXISTS idx_execution_logs_user ON execution_logs(user_id, mode, created_at);
    `);
    console.log('[db] execution_logs migrated: status CHECK added skipped');
  }
} catch (e) {
  console.error('[db] execution_logs migration failed:', e);
}


// Prepared statements
const stmtGetUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const stmtGetUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtCreateUser = db.prepare(
  'INSERT INTO users (phone, nickname, avatar) VALUES (?, ?, ?)'
);
const stmtCreateUserWithPassword = db.prepare(
  'INSERT INTO users (phone, password_hash, nickname, avatar) VALUES (?, ?, ?, ?)'
);

// 6 个系统默认卡通头像（SVG，public/defaults/avatars/）。新用户创建时随机分配其一。
const DEFAULT_AVATARS = Array.from(
  { length: 6 },
  (_, i) => `/defaults/avatars/avatar${i + 1}.svg`,
);

/** 随机返回一个默认卡通头像的相对路径 */
export function randomDefaultAvatar(): string {
  return DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)];
}
const stmtUpdateUserPassword = db.prepare(
  "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
);
// 用户资料更新（个人中心昵称/头像）
const stmtUpdateUser = db.prepare("UPDATE users SET nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar), updated_at = datetime('now') WHERE id = ?");


export function getUserByPhone(phone: string) {
  return stmtGetUserByPhone.get(phone) as any | undefined;
}

export function getUserById(id: number) {
  return stmtGetUserById.get(id) as any | undefined;
}

export function createUser(phone: string, nickname?: string, avatar?: string) {
  const result = stmtCreateUser.run(
    phone,
    nickname || '',
    avatar && avatar.length > 0 ? avatar : randomDefaultAvatar()
  );
  return result.lastInsertRowid as number;
}

export function createUserWithPassword(
  phone: string,
  passwordHash: string,
  nickname?: string,
  avatar?: string
) {
  const result = stmtCreateUserWithPassword.run(
    phone,
    passwordHash,
    nickname || '',
    avatar && avatar.length > 0 ? avatar : randomDefaultAvatar()
  );
  return result.lastInsertRowid as number;
}

export function updateUserPassword(userId: number, passwordHash: string) {
  stmtUpdateUserPassword.run(passwordHash, userId);
}

// Chat messages
const stmtInsertChatMessage = db.prepare(
  "INSERT INTO chat_messages (user_id, agent_id, role, content, error_message) VALUES (?, ?, ?, ?, ?)"
);
// 注意：created_at 存 datetime('now') 为 UTC，而 date/beforeDate 是北京日期。
// 用 datetime(?, '-8 hours') 把北京 0 点边界转成 UTC 边界，使北京 [date, date+1) 正确对应 UTC [date-8h, date+1-8h)。
// ORDER BY DESC: 初始取最新 N 条（保证最新消息可见，不被 ASC+LIMIT 截断）；上滑用 before 游标取更早的。
const stmtGetChatHistory = db.prepare(
  "SELECT * FROM chat_messages WHERE user_id = ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR created_at >= datetime(?, '-8 hours')) AND (? IS NULL OR id < ?) AND (? IS NULL OR created_at < datetime(?, '-8 hours')) ORDER BY created_at DESC, id DESC LIMIT ?"
);
const stmtGetChatMessageById = db.prepare(
  "SELECT * FROM chat_messages WHERE id = ?"
);
const stmtUpdateMessageContent = db.prepare(
  "UPDATE chat_messages SET content = ? WHERE id = ?"
);

export function insertChatMessage(
  userId: number,
  agentId: string,
  role: 'user' | 'assistant',
  content: string,
  errorMessage?: string
): number {
  const result = stmtInsertChatMessage.run(userId, agentId, role, content, errorMessage ?? null);
  return result.lastInsertRowid as number;
}

export function getChatHistory(
  userId: number,
  agentId?: string,
  limit: number = 50,
  offset: number = 0,
  date?: string,
  before?: number,
  beforeDate?: string
) {
  // date: YYYY-MM-DD format, filters created_at >= date
  // before: cursor ID, filters id < before (for "load older" pagination)
  // beforeDate: YYYY-MM-DD format, filters created_at < beforeDate (for load-more when no data today)
  return stmtGetChatHistory.all(
    userId,
    agentId || null,
    agentId || null,
    date ? `${date} 00:00:00` : null,
    date ? `${date} 00:00:00` : null,
    before || null,
    before || null,
    beforeDate ? `${beforeDate} 00:00:00` : null,
    beforeDate ? `${beforeDate} 00:00:00` : null,
    limit
  ) as any[];
}

export function getChatMessageById(id: number) {
  return stmtGetChatMessageById.get(id) as any | undefined;
}


// ===== Heartbeat 未读状态（C1）=====
const stmtGetHeartbeatLastRead = db.prepare(
  "SELECT last_read_at FROM heartbeat_read_state WHERE user_id = ?"
);
const stmtUpsertHeartbeatLastRead = db.prepare(
  "INSERT INTO heartbeat_read_state (user_id, last_read_at) VALUES (?, ?) "
  + "ON CONFLICT(user_id) DO UPDATE SET last_read_at = excluded.last_read_at"
);
/** 返回某用户最后查看 heartbeat 的时间（ISO 字符串），未记录则返回 null */
export function getHeartbeatLastRead(userId: number): string | null {
  const row = stmtGetHeartbeatLastRead.get(userId) as any;
  return row?.last_read_at ?? null;
}

/** 标记 heartbeat 已读：更新 last_read_at = now */
export function markHeartbeatRead(userId: number): string {
  const now = new Date().toISOString();
  stmtUpsertHeartbeatLastRead.run(userId, now);
  return now;
}

// ===== Heartbeat 简报独立表（移出 chat 体系，承载 heartbeat/alert/schedule 三类 LLM 决策）=====
const stmtUpsertHeartbeatReportV2 = db.prepare(
  "INSERT OR IGNORE INTO heartbeat_reports (run_id, content, source, symbol, input_tokens, output_tokens, total_tokens, cost, trigger_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const stmtGetHeartbeatReportsV2 = db.prepare(
  "SELECT * FROM heartbeat_reports WHERE created_at >= datetime(?, '-8 hours') AND created_at < datetime(?, '+1 day', '-8 hours') ORDER BY created_at DESC, id DESC"
);
const stmtCountHeartbeatReportsSince = db.prepare(
  "SELECT COUNT(*) as count FROM heartbeat_reports WHERE created_at > ?"
);
const stmtCountHeartbeatReportsAll = db.prepare(
  "SELECT COUNT(*) as count FROM heartbeat_reports"
);

/** 北京时区今天的日期（YYYY-MM-DD） */
function _todayBeijing(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/**
 * 按 runId 去重写入 LLM 决策记录（hotwave message_end / alert / schedule 直写主路径）。
 * source 区分来源，opts 携带 token 用量与触发原因（含并发等待记录）。
 * 返回新插入 id（runId 冲突被忽略则 undefined）。
 */
export function upsertHeartbeatReportV2(
  runId: string,
  content: string,
  opts?: {
    source?: string;
    symbol?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
    triggerReason?: string;
  },
): number | undefined {
  if (!runId) return undefined;
  const result = stmtUpsertHeartbeatReportV2.run(
    runId,
    content,
    opts?.source ?? "heartbeat",
    opts?.symbol ?? null,
    opts?.inputTokens ?? 0,
    opts?.outputTokens ?? 0,
    opts?.totalTokens ?? 0,
    opts?.cost ?? 0,
    opts?.triggerReason ?? null,
  );
  return result.changes > 0 ? (result.lastInsertRowid as number) : undefined;
}

/** 查询指定日期（YYYY-MM-DD 北京时区）的 LLM 决策记录，倒序全量返回。date 留空取今天。 */
export function getHeartbeatReportsV2(date?: string): any[] {
  const d = date ?? _todayBeijing();
  return stmtGetHeartbeatReportsV2.all(d, d) as any[];
}

/** 某用户的 heartbeat 简报未读数（基于 heartbeat_read_state，改查 heartbeat_reports）。 */
export function countHeartbeatUnreadV2(userId: number): number {
  const lastRead = getHeartbeatLastRead(userId);
  if (!lastRead) {
    const row = stmtCountHeartbeatReportsAll.get() as any;
    return row?.count ?? 0;
  }
  const row = stmtCountHeartbeatReportsSince.get(lastRead) as any;
  return row?.count ?? 0;
}

export function updateMessageContent(id: number, content: string): void {
  stmtUpdateMessageContent.run(content, id);
}

// ===== Monitor alerts（hotwave 上行 monitor.alert 落库）=====
const stmtInsertMonitorAlert = db.prepare(
  "INSERT INTO monitor_alerts (user_id, payload) VALUES (?, ?)"
);
const stmtGetRecentMonitorAlerts = db.prepare(
  "SELECT id, payload, created_at FROM monitor_alerts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"
);

/** 落库一条 hotwave 上行 monitor.alert，返回新插入 id。 */
export function insertMonitorAlert(userId: number, payload: unknown): number {
  const result = stmtInsertMonitorAlert.run(
    userId,
    typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
  );
  return result.lastInsertRowid as number;
}

/** 查询某用户最近的 monitor.alert 列表（倒序，默认 50 条）。 */
export function getRecentMonitorAlerts(userId: number, limit: number = 50): any[] {
  const rows = stmtGetRecentMonitorAlerts.all(
    userId,
    Math.max(1, Math.min(limit, 200))
  ) as any[];
  return rows.map((r) => {
    let payload: any = r.payload;
    try { payload = JSON.parse(r.payload); } catch { /* 保留原始字符串 */ }
    return { id: r.id, payload, created_at: r.created_at };
  });
}

// ===== 用户资料 =====

export function updateUser(id: number, nickname?: string, avatar?: string) {
  stmtUpdateUser.run(nickname || null, avatar || null, id);
  return stmtGetUserById.get(id) as any | undefined;
}

// ===== Watchlist =====
const stmtGetWatchlist = db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY sort_order ASC, id DESC');
const stmtGetWatchItem = db.prepare('SELECT * FROM watchlist WHERE user_id = ? AND symbol = ?');
const stmtAddWatchItem = db.prepare(`
  INSERT INTO watchlist (user_id, symbol, name, market, type, note)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, symbol) DO UPDATE SET
    name = excluded.name,
    market = excluded.market,
    type = excluded.type,
    note = excluded.note,
    updated_at = datetime('now')
`);
const stmtRemoveWatchItem = db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?');

export function getWatchlist(userId: number) {
  return stmtGetWatchlist.all(userId) as any[];
}

export function getWatchItem(userId: number, symbol: string) {
  return stmtGetWatchItem.get(userId, symbol) as any | undefined;
}

export function addWatchItem(userId: number, item: { symbol: string; name?: string; market?: string; type?: string; note?: string }) {
  stmtAddWatchItem.run(userId, item.symbol, item.name || '', item.market || '', item.type || 'stock', item.note || '');
  return getWatchItem(userId, item.symbol);
}

export function removeWatchItem(userId: number, symbol: string) {
  const result = stmtRemoveWatchItem.run(userId, symbol);
  return result.changes > 0;
}

// ===== Trades（模拟盘/实盘交易记录）=====
export interface TradeRecord {
  userId: number;
  mode: 'paper' | 'live';
  stockCode: string;
  stockName?: string;
  bsType: 'buy' | 'sell';
  price: number;
  amount: number;
  cost?: number;
  total?: number;
  status?: 'pending' | 'filled' | 'cancelled' | 'rejected';
  entrustNo?: string;
  strategyTag?: string;
  pnl?: number;
  note?: string;
}

const stmtInsertTrade = db.prepare(`
  INSERT INTO trades (user_id, mode, stock_code, stock_name, bs_type, price, amount, cost, total, status, entrust_no, strategy_tag, pnl, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function createTrade(t: TradeRecord) {
  const total = t.total ?? t.price * t.amount;
  const result = stmtInsertTrade.run(
    t.userId,
    t.mode,
    t.stockCode,
    t.stockName || '',
    t.bsType,
    t.price,
    t.amount,
    t.cost ?? 0,
    total,
    t.status || 'filled',
    t.entrustNo || '',
    t.strategyTag || '',
    t.pnl ?? 0,
    t.note || '',
  );
  return getTradeById(Number(result.lastInsertRowid));
}

const stmtGetTradeById = db.prepare('SELECT * FROM trades WHERE id = ?');
export function getTradeById(id: number) {
  return stmtGetTradeById.get(id) as any | undefined;
}

// 用户查询自己的交易记录（按 mode 筛选 + 分页 + 可选股票代码）。
export function getUserTrades(opts: {
  userId: number;
  mode?: string;
  stockCode?: string;
  bsType?: string;
  page: number;
  pageSize: number;
}) {
  const { userId, mode, stockCode, bsType, page, pageSize } = opts;
  const where: string[] = ['user_id = ?'];
  const params: any[] = [userId];
  if (mode) {
    where.push('mode = ?');
    params.push(mode);
  }
  if (stockCode) {
    where.push('stock_code = ?');
    params.push(stockCode);
  }
  if (bsType) {
    where.push('bs_type = ?');
    params.push(bsType);
  }
  const whereSql = where.join(' AND ');
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(`SELECT * FROM trades WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as any[];
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM trades WHERE ${whereSql}`).get(...params) as any
  ).count as number;
  // 用重算盈亏覆盖 sell 记录入库的 pnl（防历史脏数据：旧版把卖出手续费当盈亏落库）。
  // buy 记录 pnl 本就为 0，无需覆盖。
  if (mode) {
    const { pnlByTradeId } = recomputeTradePnl(userId, mode);
    for (const row of rows) {
      if (row.bs_type === 'sell' && pnlByTradeId.has(row.id)) {
        row.pnl = pnlByTradeId.get(row.id);
      }
    }
  }
  return { rows, total, page, pageSize };
}

// ===== 执行日志 =====

export interface ExecutionLogInput {
  userId: number;
  mode: 'paper' | 'live';
  title: string;
  description?: string;
  status?: 'success' | 'failure' | 'pending' | 'skipped';
  logType?: 'trade' | 'risk_control' | 'system' | 'alert';
  tradeId?: number;
  strategyTag?: string;
}

const stmtInsertExecutionLog = db.prepare(`
  INSERT INTO execution_logs (user_id, mode, title, description, status, log_type, trade_id, strategy_tag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function createExecutionLog(input: ExecutionLogInput) {
  const result = stmtInsertExecutionLog.run(
    input.userId,
    input.mode,
    input.title,
    input.description || '',
    input.status || 'pending',
    input.logType || 'system',
    input.tradeId ?? null,
    input.strategyTag || '',
  );
  return getExecutionLogById(Number(result.lastInsertRowid));
}

const stmtGetExecutionLogById = db.prepare('SELECT * FROM execution_logs WHERE id = ?');
export function getExecutionLogById(id: number) {
  return stmtGetExecutionLogById.get(id) as any | undefined;
}

export function getUserExecutionLogs(opts: {
  userId: number;
  mode?: string;
  page: number;
  pageSize: number;
}) {
  const { userId, mode, page, pageSize } = opts;
  const where: string[] = ['user_id = ?'];
  const params: any[] = [userId];
  if (mode) {
    where.push('mode = ?');
    params.push(mode);
  }
  const whereSql = where.join(' AND ');
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT * FROM execution_logs WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as any[];
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM execution_logs WHERE ${whereSql}`).get(...params) as any
  ).count as number;
  return { rows, total, page, pageSize };
}

// 交易费率（与 hotwave src/trader/model.ts PerTrade 保持一致）。
// 买入佣金 0.03%、卖出佣金 0.04% + 印花税 0.1%，每笔佣金最低 5 元。
const TRADE_BUY_COST_RATE = 0.0003;
const TRADE_SELL_COST_RATE = 0.0004;
const TRADE_CLOSE_TAX_RATE = 0.001;
const TRADE_MIN_COST = 5;

function calcTradeFee(amount: number, price: number, bs: 'B' | 'S'): number {
  const total = amount * price;
  let cost = Math.max(TRADE_MIN_COST, total * TRADE_BUY_COST_RATE);
  if (bs === 'S') {
    cost = Math.max(TRADE_MIN_COST, total * TRADE_SELL_COST_RATE) + total * TRADE_CLOSE_TAX_RATE;
  }
  return Math.round(cost * 100) / 100;
}

/**
 * 按当前正确公式重算每笔卖出的已实现盈亏，不依赖入库 pnl 字段。
 *
 * 历史 bug：旧版落库时把「卖出手续费」写进了 pnl、把「毛盈亏(价差×量)」写进了 cost，
 * 导致低价卖出反而显示盈利。当前 paper.ts 已修正，但库里历史记录仍脏。
 * 展示层（列表卡片盈亏、累计盈亏、胜率、按策略分组）一律以此重算为准，
 * 对历史脏数据与未来潜在落库错误都免疫。
 *
 * 成本口径与 paper.ts 一致：costPrice 含买入手续费摊入（加权平均），
 * pnl = (卖价 - costPrice) × 量 - 卖出手续费(佣金+印花税)。
 */
export function recomputeTradePnl(userId: number, mode: string): {
  pnlByTradeId: Map<number, number>;
  totalRealizedPnl: number;
  roundCount: number;
  winCount: number;
  pnlByStrategy: Map<string, number>;
} {
  const rows = db
    .prepare(
      `SELECT id, stock_code, bs_type, price, amount, strategy_tag FROM trades
       WHERE user_id = ? AND mode = ? AND status = 'filled'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId, mode) as any[];

  const pnlByTradeId = new Map<number, number>();
  const pnlByStrategy = new Map<string, number>();
  const held = new Map<string, { amount: number; costPrice: number; roundPnl: number }>();
  let roundCount = 0;
  let winCount = 0;
  let totalRealizedPnl = 0;

  for (const r of rows) {
    if (r.bs_type === 'buy') {
      const fee = calcTradeFee(r.amount, r.price, 'B');
      const h = held.get(r.stock_code);
      if (h && h.amount > 0) {
        const newAmt = h.amount + r.amount;
        h.costPrice = (h.costPrice * h.amount + r.price * r.amount + fee) / newAmt;
        h.amount = newAmt;
      } else {
        held.set(r.stock_code, {
          amount: r.amount,
          costPrice: (r.price * r.amount + fee) / r.amount,
          roundPnl: 0,
        });
      }
    } else {
      // sell
      const h = held.get(r.stock_code);
      const costPrice = h?.costPrice ?? r.price; // 无持仓兜底（理论上不出现）
      const fee = calcTradeFee(r.amount, r.price, 'S');
      const pnl = Math.round(((r.price - costPrice) * r.amount - fee) * 100) / 100;
      pnlByTradeId.set(r.id, pnl);
      totalRealizedPnl += pnl;
      const tag = r.strategy_tag || '';
      pnlByStrategy.set(tag, (pnlByStrategy.get(tag) ?? 0) + pnl);
      if (h) {
        h.roundPnl += pnl;
        h.amount -= r.amount;
        if (h.amount <= 0) {
          roundCount += 1;
          if (h.roundPnl > 0) winCount += 1;
          held.delete(r.stock_code);
        }
      }
    }
  }

  return { pnlByTradeId, totalRealizedPnl, roundCount, winCount, pnlByStrategy };
}

// 交易统计：累计盈亏、买卖笔数、胜率（按持仓回合）、按策略分组。
// 盈亏/胜率/按策略均用 recomputeTradePnl 实时重算，不依赖入库 pnl（防历史脏数据）。
export function getTradeStats(userId: number, mode: string) {
  const summary = db
    .prepare(
      `SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN bs_type='buy' THEN 1 ELSE 0 END) as buy_count,
        SUM(CASE WHEN bs_type='sell' THEN 1 ELSE 0 END) as sell_count,
        SUM(total) as total_amount
       FROM trades WHERE user_id = ? AND mode = ? AND status = 'filled'`,
    )
    .get(userId, mode) as any;

  const { totalRealizedPnl, roundCount, winCount, pnlByStrategy } = recomputeTradePnl(userId, mode);
  const winRate = roundCount > 0 ? (winCount / roundCount) * 100 : 0;

  const strategyRows = db
    .prepare(
      `SELECT strategy_tag, COUNT(*) as count
       FROM trades WHERE user_id = ? AND mode = ? AND status = 'filled'
       GROUP BY strategy_tag ORDER BY count DESC`,
    )
    .all(userId, mode) as any[];
  const byStrategy = strategyRows.map((s: any) => ({
    strategy_tag: s.strategy_tag,
    count: s.count,
    pnl: Math.round((pnlByStrategy.get(s.strategy_tag || '') ?? 0) * 100) / 100,
  }));

  return {
    totalCount: summary.total_count || 0,
    buyCount: summary.buy_count || 0,
    sellCount: summary.sell_count || 0,
    winRate: Number(winRate.toFixed(2)),
    totalPnl: Math.round(totalRealizedPnl * 100) / 100,
    totalAmount: summary.total_amount || 0,
    byStrategy,
  };
}

// 重放交易记录重建模拟盘/实盘持仓快照（按时间正序，加权平均成本）。
// 供 stats 路由计算浮动盈亏用。返回 [{ stockCode, amount, costPrice }]。
export function getTradePositions(userId: number, mode: string) {
  const rows = db
    .prepare(
      `SELECT stock_code, bs_type, price, amount, cost FROM trades
       WHERE user_id = ? AND mode = ? AND status = 'filled'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId, mode) as any[];
  const cost = new Map<string, { stockCode: string; amount: number; costPrice: number }>();
  for (const r of rows) {
    if (r.bs_type === 'buy') {
      const c = cost.get(r.stock_code);
      if (c && c.amount > 0) {
        const newAmt = c.amount + r.amount;
        // costPrice 含买入手续费摊入，与 paper.ts / recomputeTradePnl 口径一致
        c.costPrice = (c.costPrice * c.amount + r.price * r.amount + (r.cost || 0)) / newAmt;
        c.amount = newAmt;
      } else {
        cost.set(r.stock_code, {
          stockCode: r.stock_code,
          amount: r.amount,
          costPrice: (r.price * r.amount + (r.cost || 0)) / r.amount,
        });
      }
    } else {
      const c = cost.get(r.stock_code);
      if (c) {
        c.amount -= r.amount;
        if (c.amount <= 0) cost.delete(r.stock_code);
      }
    }
  }
  return [...cost.values()].filter((p) => p.amount > 0);
}

/**
 * 查今日（北京日期）已成交买入数量。
 * T+1 规则：当日买入不可卖。一键清仓需扣除当日买入量，只卖可卖部分（历史持仓）。
 * created_at 存 UTC，用 date(created_at, '+8 hours') 转北京日期。
 */
export function getTodayBoughtAmount(userId: number, mode: string, stockCode: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS amt FROM trades
       WHERE user_id = ? AND mode = ? AND stock_code = ? AND bs_type = 'buy' AND status = 'filled'
       AND date(created_at, '+8 hours') = date('now', '+8 hours')`,
    )
    .get(userId, mode, stockCode) as { amt: number } | undefined;
  return row?.amt ?? 0;
}

// ===== hotwave 绑定关系 =====
// hotwave 实例与用户绑定：binding_id + secret 鉴权，交易归属绑定用户。

const stmtCreateBinding = db.prepare(
  'INSERT INTO hotwave_bindings (user_id, binding_id, secret_hash, label) VALUES (?, ?, ?, ?)'
);
const stmtGetBindingByBindingId = db.prepare(
  'SELECT * FROM hotwave_bindings WHERE binding_id = ?'
);
const stmtGetBindingsByUser = db.prepare(
  "SELECT id, user_id, binding_id, label, status, last_seen_at, created_at, revoked_at FROM hotwave_bindings WHERE user_id = ? ORDER BY id DESC"
);
const stmtGetBindingById = db.prepare(
  'SELECT * FROM hotwave_bindings WHERE id = ?'
);
const stmtTouchBinding = db.prepare(
  "UPDATE hotwave_bindings SET last_seen_at = datetime('now') WHERE id = ?"
);
const stmtRevokeBinding = db.prepare(
  "UPDATE hotwave_bindings SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?"
);
export interface HotwaveBindingRow {
  id: number;
  user_id: number;
  binding_id: string;
  secret_hash: string;
  label: string;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** 生成 binding_id（hb_ + 16 hex） */
export function generateBindingId(): string {
  return 'hb_' + crypto.randomBytes(8).toString('hex');
}

/** 生成 secret 明文（32 char base64url，仅创建时返回一次，库中只存哈希） */
export function generateBindingSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** 创建绑定，返回 { binding, secret }（secret 明文仅此一次） */
export function createBinding(userId: number, label: string): {
  binding: Omit<HotwaveBindingRow, 'secret_hash'>;
  secret: string;
} {
  const bindingId = generateBindingId();
  const secret = generateBindingSecret();
  stmtCreateBinding.run(userId, bindingId, hashSync(secret, 10), label || '');
  const row = stmtGetBindingByBindingId.get(bindingId) as HotwaveBindingRow;
  const { secret_hash, ...rest } = row;
  return { binding: rest, secret };
}

export function getBindingByBindingId(bindingId: string): HotwaveBindingRow | undefined {
  return stmtGetBindingByBindingId.get(bindingId) as HotwaveBindingRow | undefined;
}

/** 校验 binding_id + secret，返回 active 的绑定行（同时更新 last_seen_at）；否则 undefined */
export function verifyBinding(
  bindingId: string,
  secret: string
): HotwaveBindingRow | undefined {
  const row = stmtGetBindingByBindingId.get(bindingId) as HotwaveBindingRow | undefined;
  if (!row || row.status !== 'active') return undefined;
  if (!compareSync(secret, row.secret_hash)) return undefined;
  stmtTouchBinding.run(row.id);
  return row;
}

export function getBindingsByUser(userId: number) {
  return stmtGetBindingsByUser.all(userId) as any[];
}

export function getBindingById(id: number): HotwaveBindingRow | undefined {
  return stmtGetBindingById.get(id) as HotwaveBindingRow | undefined;
}

/** 吊销绑定（仅绑定所属用户可调）。返回是否成功 */
export function revokeBinding(id: number): boolean {
  const result = stmtRevokeBinding.run(id);
  return result.changes > 0;
}

// ===== app_configs（APP 端配置，key-value + JSON）=====
// ===== app_configs（APP 端配置，key-value + JSON）=====
const stmtGetAppConfig = db.prepare('SELECT config_value FROM app_configs WHERE config_key = ?');

/** 读取配置（key-value），不存在返回 null。 */
export function getAppConfig(key: string): string | null {
  const row = stmtGetAppConfig.get(key) as { config_value: string } | undefined;
  return row?.config_value ?? null;
}

// ===== user_rules（黑白名单 / 功能白名单，按用户/手机/设备维度）=====
export type UserRuleTargetType = 'user_id' | 'phone' | 'device_id';
export type UserRuleType = 'block' | 'allow';
export type UserRuleScopeType = 'page' | 'action' | 'feature' | 'all';

export interface UserRuleRow {
  id: number;
  target_type: UserRuleTargetType;
  target_value: string;
  rule_type: UserRuleType;
  scope_type: UserRuleScopeType;
  scope_key: string;
  enabled: number;
  note: string;
  created_by: number;
  created_at: string;
}

/** 某用户命中的启用规则（按 user_id / phone / device_id 三个维度匹配）。 */
export function getUserRulesForTarget(
  userId: number,
  phone: string,
  deviceId: string,
): UserRuleRow[] {
  const targets = [String(userId)];
  if (phone) targets.push(phone);
  if (deviceId) targets.push(deviceId);
  const placeholders = targets.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM user_rules WHERE enabled = 1 AND target_type = 'user_id' AND target_value IN (${placeholders})
       UNION
       SELECT * FROM user_rules WHERE enabled = 1 AND target_type = 'phone' AND target_value IN (${placeholders})
       UNION
       SELECT * FROM user_rules WHERE enabled = 1 AND target_type = 'device_id' AND target_value IN (${placeholders})`,
    )
    .all(...targets, ...targets, ...targets) as UserRuleRow[];
  return rows;
}

/** 全局封禁检查：用户/手机/设备命中 block + scope=all（黑名单主防线）。 */
export function getGlobalBlock(
  userId: number,
  phone: string,
  deviceId: string,
): UserRuleRow | undefined {
  const rules = getUserRulesForTarget(userId, phone, deviceId);
  return rules.find((r) => r.rule_type === 'block' && r.scope_type === 'all');
}

// ===== app_events（APP 埋点上报）=====
export interface AppEventIn {
  event_type?: string; // page_view | action | custom
  event_name?: string;
  page_path?: string;
  session_id?: string;
  extra?: string; // JSON string
}

const stmtInsertAppEvent = db.prepare(
  `INSERT INTO app_events
     (user_id, device_id, session_id, platform, device_model, os_version, app_version, ip,
      event_type, event_name, page_path, extra)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** 批量写入埋点（事务）。设备信息从请求上下文带过来，事件主体为客户端批量上报。 */
export function recordAppEvents(
  userId: number | null,
  device: { deviceId: string; platform: string; deviceModel: string; osVersion: string; appVersion: string; ip: string },
  events: AppEventIn[],
): void {
  const txn = db.transaction((list: AppEventIn[]) => {
    for (const e of list) {
      stmtInsertAppEvent.run(
        userId,
        device.deviceId || 'unknown',
        e.session_id ?? '',
        device.platform,
        device.deviceModel,
        device.osVersion,
        device.appVersion,
        device.ip,
        e.event_type ?? 'action',
        e.event_name ?? '',
        e.page_path ?? '',
        e.extra ?? '{}',
      );
    }
  });
  txn(events);
}

export default db;
