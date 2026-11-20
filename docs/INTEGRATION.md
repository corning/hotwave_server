# 热浪金融服务端与 hotwave 对接说明

本文件描述 hotwave_server 与 [hotwave](https://github.com/corning/hotwave) 之间的连接、协议与数据契约。APP 与本服务的接口见 [API.md](API.md)。

## 1. 组件与连接

| 组件 | 端口 | 方向 | 用途 |
|------|------|------|------|
| hotwave_server | 8000 | 入站 HTTP | REST + SSE |
| hotwave_server | 18791 | 入站 WS | hotwave 反向长连接（hotwave 是 client） |
| hotwave runtime | 8791 | 出站 HTTP | CHAT_ENGINE=kernel 时聊天与控制面 |
| hotwave gateway | 18789 | — | 本服务不直连；IM/CLI 等渠道使用 |

典型部署：hotwave 与 hotwave_server 在同一台主机，均只监听回环地址，由反向代理对外。

## 2. 绑定生命周期

### 2.1 创建绑定

APP 登录后调用：

~~~http
POST /api/hotwave-bindings
Authorization: Bearer <JWT>
Content-Type: application/json

{ "label": "my-mac" }
~~~

返回（secret 明文只出现一次）：

~~~json
{
  "ok": true,
  "payload": {
    "id": 1,
    "bindingId": "hb_0123456789abcdef",
    "secret": "32-char-base64url-secret",
    "label": "my-mac",
    "createdAt": "2026-11-20 04:00:00"
  }
}
~~~

数据库只保存 secret 的 bcrypt 哈希；binding 状态为 active，可随时吊销。

### 2.2 配置 hotwave

在 hotwave 的 .env 中设置：

~~~bash
TRADE_API_BASE=http://127.0.0.1:8000/api
TRADE_API_WS_URL=ws://127.0.0.1:18791
TRADE_BINDING_ID=hb_0123456789abcdef
TRADE_BINDING_SECRET=32-char-base64url-secret
~~~

- TRADE_API_BASE 用于 REST 回写（交易、执行日志、简报）与 /api/hotwave/* 行情数据。
- TRADE_API_WS_URL 用于反向长连接。
- 不配置绑定凭证时 hotwave 为独立模式：不连本服务，也不落库。

### 2.3 连接与认证

hotwave 启动后主动连入 ws://127.0.0.1:18791。一个用户同一时间只保留一条连接：新连接会关闭旧连接（close code 4002）。

握手（10 秒超时）：

~~~text
Server -> hotwave : event connect.challenge { nonce, ts, seq: 0 }
hotwave -> Server : req   { id, method: "connect", params: { bindingId, bindingSecret, nonce } }
Server -> hotwave : res   { id, ok: true, payload: { userId } }
~~~

失败时返回：

~~~json
{ "type": "res", "id": "...", "ok": false, "error": { "code": "UNAUTHORIZED", "message": "binding_id 不存在，请解绑后重新绑定" } }
~~~

随后服务端关闭连接（code 4001）。认证失败原因会保留 60 秒，用于 APP 侧「hotwave 离线」的具体提示（binding_id、secret 不匹配、已停用、nonce 错误）。

### 2.4 保活与重连

- 服务端每 60 秒下发 tick 事件，避免 hotwave 侧 90 秒无消息判定僵死。
- hotwave 侧指数退避重连（1s -> 2s -> ... -> 30s 上限），连接成功后归零。
- 服务端 RPC 超时 30 秒；流式 RPC 空闲超时 300 秒。
- 客户端断开（APP SSE 取消）会通过 AbortSignal 立即终止流式 RPC。

### 2.5 吊销

APP 调用 DELETE /api/hotwave-bindings/[id] 后，binding 状态变为 revoked；后续连接认证失败，hotwave 需更换凭证。

## 3. WS 帧格式

与 hotwave 网关协议一致，三种帧：

~~~json
{ "type": "req", "id": "uuid", "method": "chat.send", "params": { } }
{ "type": "res", "id": "uuid", "ok": true, "payload": { }, "error": { "code": "", "message": "" } }
{ "type": "event", "event": "chat", "payload": { }, "seq": 0 }
~~~

服务端只接受已认证连接的 res / event；未认证只能发 connect。

## 4. 服务端到 hotwave 的 RPC

| 方法 | 参数 | 返回/事件 | 用途 |
|------|------|-----------|------|
| connect | bindingId, bindingSecret, nonce | { userId } | 握手（唯一由 hotwave 发起的 req） |
| chat.send | { message, sessionKey: "main" } | res ACK { sessionKey, runId } + chat 事件流 | legacy 引擎聊天 |
| chat.abort | { sessionKey, runId? } | { aborted, runId? } | 中断 run |
| agent.state | { sessionKey } | 运行态对象 | 状态卡 |
| approval.list | — | { approvals: [] } | 待审批 |
| approval.decide | { requestId, decision } | 决策结果 | allow-once / allow-always / deny |
| monitor.subscribe | { items: [ MonitorItem ] } | 订阅结果 | 新增监控 |
| monitor.unsubscribe | { itemIds: [] } | 结果 | 移除监控 |
| monitor.status | — | { running, items, alertsToday, uptimeMs, tradingSession, recentAlerts } | 监控快照 |
| monitor.search_stocks | { q } | 股票列表 | 搜索 |
| trader.balance | — | { totalAssets, availableFunds, positionMarketValue } | 实盘资产 |
| trader.liquidate | — | { liquidated, failed, skipped, submitted } | 实盘清仓 |
| trader.status | — | { mode, liveReady, inTradingSession } | 交易状态 |

MonitorItem 示例（代码中固定价格波动 3% 阈值）：

~~~json
{
  "id": "manual-sh600519",
  "symbol": "sh600519",
  "type": "stock",
  "interval": 3,
  "thresholds": [
    { "metric": "price_change_pct", "operator": "gte", "value": 3, "level": "warning", "message": "[监控] sh600519 触发价格波动阈值 3%" }
  ]
}
~~~

## 5. hotwave 到服务端的事件

| event | payload | 服务端处理 |
|-------|---------|------------|
| chat | { sessionKey, state, text, tool, isError } | 路由到该用户的活跃流式 RPC，转 SSE |
| monitor.alert | 告警对象 | 落 monitor_alerts + SSE monitor_alert |
| monitor.status_change | { ..., itemsList? } | SSE monitor_status / monitor_items |
| approval.request | 审批对象 | SSE approval_request |
| approval.resolved | 决策结果 | SSE approval_resolved |
| tick | { ts } | 保活，忽略 |

chat 的 state 取值：

| state | 字段 | SSE 映射 |
|-------|------|----------|
| delta | text | event: delta |
| reasoning | text | event: reasoning_delta |
| final | text | event: final，并结束流式 RPC |
| thinking | tool | event: thinking |
| thinking_done | tool, isError | event: thinking_done |
| error | error | 结束流式 RPC，转 event: error |

## 6. 两种聊天引擎

### 6.1 kernel（本机运行时）

~~~text
APP --POST /api/chat/send--> Server --POST http://127.0.0.1:8791/chat/send--> hotwave runtime
                                  |
                                  +-- 解析 SSE（delta/reasoning/thinking/final）--> 转 APP SSE
~~~

- 服务端调用运行时前先请求 GET /health（1.5 秒超时）；不健康返回 503。
- 控制面同样直连运行时：/state、/chat/abort、/approvals、/approvals/[id]。
- 需要 AGENT_RUNTIME_TOKEN 时，服务端自动带 Bearer。

### 6.2 legacy（反向 WS）

~~~text
APP --POST /api/chat/send--> Server --req chat.send--> hotwave（反向连接）
                                  <--res ACK + chat event--+
~~~

- 未连接时返回 503，提示先在 APP 绑定并启动 hotwave。
- 适合多用户/多实例：按绑定的 user_id 路由到各自连接。

## 7. 监控时序

~~~text
APP --GET /api/monitor/alerts (SSE)--> Server
                                        |-- 订阅内存事件
                                        |-- RPC monitor.status 拉初始快照
                                        |-- DB 回放最近 20 条历史告警
hotwave --event monitor.alert----------> Server --> 落库 + 推 SSE monitor_alert
hotwave --event monitor.status_change--> Server --> 推 SSE monitor_status/items
~~~

POST /api/monitor/subscribe 会调用 monitor.subscribe，固定生成 manual-<symbol> 的监控项；unsubscribe 先查 monitor.status 找到对应 id，再调 monitor.unsubscribe。

## 8. 回写接口

hotwave 使用绑定凭证（X-Binding-Id + X-Binding-Secret）或用户 JWT 调用：

### 8.1 交易记录

~~~http
POST /api/trades
X-Binding-Id: hb_xxx
X-Binding-Secret: xxx
Content-Type: application/json

{
  "mode": "paper",
  "stockCode": "600519",
  "stockName": "贵州茅台",
  "bsType": "buy",
  "price": 1500,
  "amount": 100,
  "cost": 5,
  "total": 150000,
  "status": "filled",
  "strategyTag": "heartbeat",
  "pnl": 0
}
~~~

### 8.2 执行日志

~~~http
POST /api/execution-logs
{ "mode": "paper", "title": "买入", "description": "...", "status": "success", "logType": "trade", "tradeId": 1, "strategyTag": "" }
~~~

### 8.3 简报/决策

~~~http
POST /api/heartbeat-reports
{
  "runId": "run-xxx",
  "text": "决策正文",
  "source": "heartbeat",
  "symbol": "sh600519",
  "inputTokens": 100,
  "outputTokens": 200,
  "totalTokens": 300,
  "cost": 0,
  "triggerReason": ""
}
~~~

- runId 必填且唯一；bridge 与 hotwave 回写同一 runId 时只落一条。
- source：heartbeat（定时）/ alert（异动）/ schedule（定时任务）。
- 该接口为 best-effort，hotwave 失败不应阻塞主流程。

## 9. 数据端点

hotwave 行情工具访问 /api/hotwave/*（公开、无鉴权）：

| 端点 | 方法 | 关键参数 | 返回 |
|------|------|----------|------|
| /api/hotwave/quote | POST | symbol | data: quote（含五档、市值、换手、量比、委比） |
| /api/hotwave/kline | POST | symbol, days | data: [{ time, open, close, high, low, volume, amount }] |
| /api/hotwave/f10 | POST | symbol, type? | data: 摘要或原始 F10 |
| /api/hotwave/hot | POST | type/period/list_type/stock_type/limit | data: 榜单 |
| /api/hotwave/market | POST | mode=pool/bigorder | data: { pool } 或 { alerts, baseline } |
| /api/hotwave/stocks | GET | — | data: 全市场列表 |
| /api/hotwave/stocks/search | GET | q | data: 搜索结果（最多 30） |
| /api/hotwave/trade-days | GET | year | data: { year, total, list } |

代码标准化规则：

- 接受 sh600519、600519、600519.SH 等写法，内部统一为 sh600519。
- 6 开头为沪市，0/3 开头为深市，4/8/9 开头为北交所，6 位代码补 ts_code 后缀。

行情缓存：

- 盘口交易时段 1 秒、非交易时段 3 秒。
- 分时 2-5 秒；K 线 2-5 秒（交易时段）。
- 全市场股票列表落盘 persistent/all_stocks.json，每日 08:30 后跨日刷新。

## 10. 错误与排障

| 现象 | 原因 | 排查 |
|------|------|------|
| APP 显示 hotwave 离线 | hotwave 未启动 / 凭证错误 / 端口不通 | 检查 hotwave 日志、绑定状态、18791 监听 |
| 认证失败提示 binding_id 不存在 | 绑定被删或环境不一致 | 重新创建绑定并更新 hotwave .env |
| 认证失败提示 secret 不匹配 | secret 复制错误或已轮换 | 吊销旧绑定后重新生成 |
| RPC 超时 | hotwave 无响应 | 查看 hotwave 进程与运行时日志 |
| 监控一直 connecting | 绑定连接未建立 | 同上；同时检查 HOTWAVE_WS_HOST |
| 行情端点 502 | 上游数据源限流/网络 | 重试；查看服务端 stock-data 相关日志 |
| 聊天 503 | kernel 运行时未就绪 / legacy 未连接 | 检查 8791 / 18791 与 CHAT_ENGINE 配置 |

## 11. 兼容性

- 帧格式、RPC 方法与 hotwave 网关协议保持一致，便于后续扩展。
- 新增 RPC 或事件时，请同时更新本文件与 hotwave 仓库的协议说明。
- 服务端对未知 event 不报错（仅忽略），便于 hotwave 渐进升级。
