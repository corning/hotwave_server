# 数据库结构与会话口径

热浪金融服务端使用 SQLite（WAL 模式），默认文件 database/hotwave.db，可用 DATABASE_PATH 指定其他路径。首次启动自动建目录与表，并对旧库做幂等迁移。

## 1. 表一览

| 表 | 用途 |
|----|------|
| users | 用户账号 |
| chat_messages | 聊天消息（含错误信息） |
| watchlist | 自选股票 |
| trades | 交易记录（模拟/实盘） |
| execution_logs | 执行日志（交易/风控/系统/告警） |
| monitor_alerts | hotwave 上行告警落库 |
| heartbeat_reports | LLM 决策/简报（run_id 去重） |
| heartbeat_read_state | 每用户简报最后阅读时间 |
| hotwave_bindings | hotwave 实例绑定凭证 |
| app_configs | APP 配置（启动画面等，key-value） |
| user_rules | 黑白名单 / 功能白名单 |
| app_events | APP 埋点 |

## 2. 主要字段

### users

id, phone（唯一）, password_hash, nickname, avatar, created_at, updated_at

- 头像存相对 URL，如 /defaults/avatars/avatar1.svg 或 /api/uploads/avatars/1_xxx.jpg。
- 账号只能通过主机侧 create-user 脚本创建；无公开注册。

### chat_messages

id, user_id（FK users）, agent_id, role（user/assistant）, content, error_message, run_id（可空）, created_at

- error_message 为 Agent 执行错误文案，SSE done 事件会带上。
- run_id 仅历史 _heartbeat_ 消息兼容使用；新简报写入 heartbeat_reports。

### watchlist

id, user_id, symbol, name, market, type, note, sort_order, created_at, updated_at
唯一约束 (user_id, symbol)。

### trades

id, user_id, mode（paper/live）, stock_code, stock_name, bs_type（buy/sell）,
price, amount, cost, total, status（pending/filled/cancelled/rejected）,
entrust_no, strategy_tag, pnl, note, created_at

- cost 为手续费（买入佣金或卖出佣金+印花税）。
- 展示层不直接信任 pnl：卖出记录按持仓回合重算。

### execution_logs

id, user_id, mode, title, description, status（success/failure/pending/skipped）,
log_type（trade/risk_control/system/alert）, trade_id, strategy_tag, created_at

### monitor_alerts

id, user_id, payload（原始告警 JSON）, created_at
按 (user_id, created_at desc) 建索引。

### heartbeat_reports

id, run_id（唯一）, content, source（heartbeat/alert/schedule）, symbol,
input_tokens, output_tokens, total_tokens, cost, trigger_reason, created_at

### heartbeat_read_state

user_id（主键）, last_read_at

### hotwave_bindings

id, user_id, binding_id（唯一）, secret_hash（bcrypt）, label,
status（active/revoked）, last_seen_at, created_at, revoked_at

- secret 明文只在创建时返回一次。
- 一个用户可绑定多个 hotwave 实例；连接按 user_id 路由。

### app_configs

id, config_key（唯一）, config_value（JSON 字符串）, updated_by, updated_at

目前使用 startup 键存启动画面配置，供 GET /api/app/startup 读取。

### user_rules

id, target_type（user_id/phone/device_id）, target_value,
rule_type（block/allow）, scope_type（page/action/feature/all）, scope_key,
enabled, note, created_by, created_at

鉴权中间件用它做全局封禁；GET /api/app/permissions 用它下发页面/操作/功能快照。

### app_events

id, user_id（可空）, device_id, session_id, platform, device_model,
os_version, app_version, ip, event_type, event_name, page_path, extra,
event_time

## 3. 时间口径

- created_at 默认 datetime('now')，存 UTC。
- 按北京日期筛选时，查询里用 datetime(参数, '-8 hours') 把北京 0 点转成 UTC 边界。
- 交易统计的「今日买入」用 date(created_at, '+8 hours') 转北京日期。
- 简报查询按北京日期：created_at >= datetime(?, '-8 hours') 且 < datetime(?, '+1 day', '-8 hours')。

## 4. 交易统计口径

### 4.1 手续费

| 项目 | 费率 |
|------|------|
| 买入佣金 | 成交额 0.03%，最低 5 元 |
| 卖出佣金 | 成交额 0.04%，最低 5 元 |
| 印花税 | 卖出成交额 0.1% |

### 4.2 成本与盈亏

- 持仓成本按加权平均计算，买入手续费摊入成本。
- 卖出已实现盈亏 = (卖价 - 成本价) × 数量 - 卖出手续费（佣金 + 印花税）。
- getTradeStats / getUserTrades 会用 recomputeTradePnl 实时重算，不依赖入库 pnl，避免历史脏数据影响展示。

### 4.3 胜率

按「持仓回合」而非单笔卖出：

- 同一股票从首次建仓到清仓为一个回合。
- 回合内可分批卖出，盈亏累加。
- 清仓（剩余数量 <= 0）时判定：回合盈亏 > 0 记为胜。
- 胜率 = 胜回合数 / 总回合数。

### 4.4 T+1

一键清仓时，当日买入数量不可卖：

- 可卖数量 = 持仓数量 - 当日买入数量。
- 若可卖数量 <= 0，整仓跳过并记一条 status=skipped 的执行日志。
- 部分可卖时卖出可卖部分，备注保留的当日买入数量。

## 5. 简报未读

- heartbeat_read_state 记录每个用户最后打开简报的时间。
- 未读数 = last_read_at 之后的 heartbeat_reports 数量；从未阅读则计全部。
- POST /api/heartbeat-reports/read 更新 last_read_at 为当前时间。
- hotwave 与 bridge 回写同一 runId 时，INSERT OR IGNORE 保证只落一条。

## 6. 迁移与维护

### 6.1 自动迁移

db.ts 在模块加载时执行：

- CREATE TABLE IF NOT EXISTS 建表。
- ALTER TABLE ... ADD COLUMN 包在 try/catch 中，重复执行不报错。
- execution_logs 的 status CHECK 约束变更通过重建表完成，保留数据。
- 旧版本遗留表（comments、skills、sms_codes、risk_rules）会在启动时幂等删除。

### 6.2 备份

~~~bash
# 在线备份（推荐，WAL 下安全）
sqlite3 database/hotwave.db ".backup 'backup/hotwave-$(date +%Y%m%d).db'"

# 同时备份上传文件
tar -czf backup/uploads-$(date +%Y%m%d).tar.gz public/uploads
~~~

### 6.3 恢复

停止服务后，用备份文件替换 database/hotwave.db，并删除同目录下的 -wal / -shm 文件，再启动。

### 6.4 清理

~~~sql
-- 删除某用户及其聊天
DELETE FROM chat_messages WHERE user_id = 7;
DELETE FROM users WHERE id = 7;

-- 删除历史告警
DELETE FROM monitor_alerts WHERE created_at < datetime('now', '-30 days');

-- 删除旧简报
DELETE FROM heartbeat_reports WHERE created_at < datetime('now', '-90 days');
~~~

### 6.5 手动维护 APP 配置 / 黑白名单

需要时可直接写库：

~~~sql
-- 启动画面配置
INSERT INTO app_configs (config_key, config_value, updated_by)
VALUES ('startup', '{"enabled":true,"animation":{"type":"image","url":"/uploads/startup/x.png","durationMs":2000},"splash":{"imageUrl":"","clickUrl":"","durationMs":3000,"skipable":true},"minVersion":"","maxVersion":""}', 0)
ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = datetime('now');

-- 封禁某用户
INSERT INTO user_rules (target_type, target_value, rule_type, scope_type, scope_key, enabled, note, created_by)
VALUES ('user_id', '7', 'block', 'all', '*', 1, 'spam', 0);
~~~

## 7. 安全

- 数据库文件包含手机号、聊天、交易等敏感信息，不要提交到版本库（.gitignore 已排除 database/）。
- 备份文件同样需要加密或限制访问权限。
- hotwave_bindings 只存 bcrypt 哈希；如怀疑泄露，吊销后重新创建。
- 生产环境建议设置文件权限 600，并限制数据库目录访问。
