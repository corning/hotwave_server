# 热浪金融服务端 API 参考

本文件描述 hotwave_server 对外提供的 REST 与 SSE 接口。所有路径以 /api 为前缀。

## 约定

### 鉴权

| 方式 | 请求头 | 适用 |
|------|--------|------|
| JWT | Authorization: Bearer <token> | APP / 用户接口 |
| hotwave 绑定 | X-Binding-Id: hb_xxx；X-Binding-Secret: xxx | hotwave 回写交易/简报/日志 |
| 无 | — | 健康检查、公开行情、启动配置、埋点 |

JWT 由 POST /api/auth/login 签发，有效期 7 天。

### 响应形态

业务接口统一返回：

~~~json
{ "ok": true, "payload": { } }
{ "ok": false, "error": "错误说明" }
~~~

认证/资料类接口沿用旧版 APP 约定：

~~~json
{ "message": "错误说明" }
~~~

### 时间与股票代码

- created_at 以 UTC 入库；APP 展示按北京时间（UTC+8）。
- 股票代码统一为 6 位数字加市场前缀，如 sh600519、sz000001、bj430047；指数如 sh000001。接口内部会做标准化，也接受 600519、600519.SH 等写法。

---

## 1. 健康检查

### GET /api/health

公开。用于 APP「连接主机」页配对前探测。

~~~json
{
  "ok": true,
  "service": "hotwave-server",
  "version": "1.0.0",
  "time": "2026-11-20T04:00:00.000Z"
}
~~~

---

## 2. 认证

### POST /api/auth/login

公开。

请求：

~~~json
{ "phone": "13800138000", "password": "your-password" }
~~~

响应：

~~~json
{
  "token": "<JWT>",
  "user": { "id": 1, "phone": "13800138000", "nickname": "owner", "avatar": "/defaults/avatars/avatar1.svg" }
}
~~~

错误：400 参数/密码错误；404 账号不存在。

### GET /api/auth/user-info

Bearer。响应：

~~~json
{ "id": 1, "phone": "13800138000", "nickname": "owner", "avatar": "/api/uploads/avatars/1_xxx.jpg" }
~~~

### POST /api/auth/profile

Bearer，multipart/form-data：

| 字段 | 类型 | 说明 |
|------|------|------|
| nickname | text | 新昵称；省略表示不改，空串表示清空 |
| file | file | 可选头像，支持 jpg/png/webp/gif |

响应同 user-info。头像会存到 public/uploads/avatars/。

---

## 3. Agent 与控制面

### GET /api/agent/list

公开。

~~~json
{
  "agents": [
    { "id": "hotwave", "name": "HotWave", "description": "HotWave 金融 AI Agent", "type": "ws", "connected": true }
  ]
}
~~~

### GET /api/agent/status

Bearer。

~~~json
{ "agents": { "hotwave": { "connected": true } } }
~~~

### GET /api/agent/state

Bearer。Query：sessionKey，默认 main。

kernel 模式返回 hotwave 运行时状态；legacy 模式经反向 WS RPC agent.state。

成功：

~~~json
{ "ok": true, "payload": { "status": "idle", "sessionKey": "main" } }
~~~

离线时（HTTP 仍为 200）：

~~~json
{ "ok": false, "error": "hotwave 离线", "payload": { "status": "offline", "sessionKey": "main" } }
~~~

### GET /api/agent/events

Bearer，SSE（text/event-stream）。事件：

| event | data | 说明 |
|-------|------|------|
| ready | { sessionKey, at } | 连接建立 |
| agent_state | 运行态对象 | 状态变化 |
| approval_list | { approvals: [] } | 当前待审批 |
| approval_request | 审批对象 | hotwave 上行 approval.request |
| approval_resolved | 审批结果 | hotwave 上行 approval.resolved |

每 15 秒发送 ": ping" 注释帧。

### GET /api/agent/supervisor

Bearer。查询本机 hotwave 服务状态。

~~~json
{
  "ok": true,
  "payload": { "connected": true, "enabled": false, "supervisor": "launchd", "label": "com.hotwave.runtime" }
}
~~~

### POST /api/agent/supervisor

Bearer。仅当 HOTWAVE_SUPERVISOR_ENABLED=true 可用。

请求：{ "action": "restart" }

响应：{ "ok": true, "payload": { "action": "restart", "label": "...", "accepted": true } }
未启用返回 403。

---

## 4. 审批

### GET /api/approvals

Bearer。

~~~json
{ "ok": true, "payload": { "approvals": [ { "requestId": "req-1", "tool": "trader_buy", "summary": "..." } ] } }
~~~

### POST /api/approvals/[requestId]

Bearer。

请求：{ "decision": "allow-once" | "allow-always" | "deny" }

响应：{ "ok": true, "payload": { ... } }；失败返回 ok:false（HTTP 200，便于 APP 展示）。

---

## 5. 聊天

### POST /api/chat/send

Bearer。请求：

~~~json
{ "agentId": "hotwave", "content": "今天大盘怎么样？" }
~~~

响应：SSE（text/event-stream）。

| event | data | 说明 |
|-------|------|------|
| delta | { content } | 正文增量 |
| final | { content } | 整轮完整文本（覆盖累积内容） |
| reasoning_delta | { __meta: true, type, text } | 推理增量 |
| thinking | { __meta: true, type, tool, isError } | 工具开始 |
| thinking_done | { __meta: true, type, tool, isError } | 工具结束 |
| done | { messageId, errorMessage? } | 结束并落库 |
| error | { message } | 错误（同时会发 done） |

每 15 秒发送 ": keepalive" 注释帧。上游未就绪返回 503。

### GET /api/chat/history

Bearer。Query：

| 参数 | 说明 |
|------|------|
| agentId | 可选，如 hotwave |
| limit | 默认 50，最大 200 |
| offset | 默认 0 |
| date | YYYY-MM-DD（北京日期），取当天 |
| before | 消息 id 游标，取更早 |
| beforeDate | YYYY-MM-DD，取该日期之前 |

响应：

~~~json
{
  "messages": [
    { "id": 12, "role": "user", "agentId": "hotwave", "content": "你好", "createdAt": "2026-11-20 03:00:00" }
  ]
}
~~~

### POST /api/chat/abort

Bearer。

请求：{ "sessionKey": "main", "runId": "可选" }

响应：{ "ok": true, "payload": { ... } }；失败 ok:false（HTTP 200）。

---

## 6. 监控

### GET /api/monitor/alerts

Bearer，SSE。事件：

| event | data | 说明 |
|-------|------|------|
| monitor_status | { running, items, alertsToday, uptimeMs, tradingSession } | 引擎状态 |
| monitor_items | 标的数组 | 监控清单 |
| monitor_alert | 告警对象 | 实时/历史告警 |
| error | { message } | hotwave 离线等原因 |

连接时先回放最近 20 条历史告警，再推送实时事件。

### GET /api/monitor/search-stocks

Bearer。Query：q。

响应：

~~~json
{ "ok": true, "payload": [ { "symbol": "sh600519", "name": "贵州茅台", "ts_code": "600519.SH", "type": 1 } ] }
~~~

### POST /api/monitor/subscribe

Bearer。请求：{ "symbol": "sh600519", "type": "stock" }

响应：{ "ok": true, "payload": { ... } }

### POST /api/monitor/unsubscribe

Bearer。请求：{ "symbol": "sh600519" }

响应：{ "ok": true, "payload": { "removed": ["manual-sh600519"] } }

---

## 7. 行情（APP，需 Bearer）

所有接口返回 { ok, payload }，上游失败时 HTTP 502。

### GET /api/stock/search?q=平安

payload:

~~~json
[ { "symbol": "sz000001", "name": "平安银行", "tsCode": "000001.SZ", "type": 1 } ]
~~~

### GET /api/stock/detail?symbol=sz000001

quote 字段 + type/description。

### GET /api/stock/quote?symbol=sz000001

payload 字段：

symbol, code, tsCode, market, isIndex, name, price, preClose, open, high, low,
change, pctChg, volume, amount, turnover, pe, pb, marketCap, flowMarketCap,
volumeRatio, commitRatio, averagePrice, buy1Price, buy1Volume, sell1Price,
sell1Volume, buy[5], sell[5], rawUpdatedAt

buy/sell 每档：{ level, price, volume }。

### GET /api/stock/quote-batch?symbols=sz000001,sh600519

payload: quote 数组（失败的标的会被剔除）。

### GET /api/stock/timeline?symbol=sz000001&range=1d|5d

payload: [ { time, price, volume, amount, avgPrice } ]；volume/amount 为每分钟增量，avgPrice 为当日 VWAP。

### GET /api/stock/kline?symbol=sz000001&period=day|week|month|quarter|year|m5|m15|m30|m60&limit=320

payload: [ { time, open, close, high, low, volume, amount } ]。

### GET /api/stock/trades?symbol=sz000001&limit=50

payload: [ { id, time, price, volume, amount, side } ]，side 为 buy/sell/neutral。

### GET /api/stock/hot?type=a&source=eastmoney|10jqka|rising

payload: 热榜列表。

### GET /api/stock/f10?symbol=sh600519

payload: 东财 F10 摘要（profile + finance）。

---

## 8. hotwave 数据端点（公开）

这些端点供 hotwave 行情工具使用，不鉴权，仅返回公开行情数据。

### POST /api/hotwave/quote

请求：{ "symbol": "sh600519" }

响应：{ "ok": true, "data": <quote 对象，字段同 /api/stock/quote> }

### POST /api/hotwave/kline

请求：{ "symbol": "600519", "days": 60 }

响应：{ "ok": true, "data": [ { time, open, close, high, low, volume, amount } ] }（日 K，前复权）。

### POST /api/hotwave/f10

请求：

~~~json
{ "symbol": "600519.SH", "type": "base" }
~~~

type 可选：base / risk / hold / indicator / pepre / index / board / margin；不传返回摘要 { profile, finance }。

响应：{ "ok": true, "data": ... }

### POST /api/hotwave/hot

请求字段：

| 字段 | 说明 |
|------|------|
| type | hot / rise / etf / hk / us，默认 hot |
| period | hour / day |
| list_type | normal / skyrocket / tech / value / trend |
| stock_type | a / etf |
| limit | 条数，默认 20 |

带 period/list_type/stock_type 任一走同花顺风格榜单，否则走东财基础榜单。

### POST /api/hotwave/market

请求：

~~~json
{ "mode": "pool", "riseMin": 6, "riseMax": 9.9, "marketValueMax": 500, "limit": 20 }
{ "mode": "bigorder", "bigOrderMin": 100000, "limit": 20 }
~~~

响应：pool 返回 { pool }；bigorder 返回 { alerts, baseline }。

### GET /api/hotwave/stocks

响应：{ "ok": true, "data": [ { "symbol": "600519", "name": "贵州茅台", "ts_code": "600519.SH", "type": 1 } ] }

### GET /api/hotwave/stocks/search?q=茅台

响应：{ "ok": true, "data": [ ... ] }，最多 30 条。

### GET /api/hotwave/trade-days?year=2026

响应：

~~~json
{ "ok": true, "data": { "year": 2026, "total": 242, "list": ["2026-01-05", "..."] } }
~~~

---

## 9. 自选

### GET /api/watchlist

Bearer。payload：watchlist 行数组（id, user_id, symbol, name, market, type, note, sort_order, created_at, updated_at）。

### POST /api/watchlist

Bearer。请求：

~~~json
{ "symbol": "sz000001", "name": "平安银行", "market": "sz", "type": "stock", "note": "" }
~~~

同一用户同一 symbol 重复添加会更新字段。

### DELETE /api/watchlist/[symbol]

Bearer。响应：{ "ok": true }。

---

## 10. 交易

### GET /api/trades

Bearer。Query：mode=paper|live，stockCode，bsType=buy|sell，page，pageSize<=100。

payload：

~~~json
{ "rows": [ { "id": 1, "mode": "paper", "stock_code": "600519", "bs_type": "buy", "price": 1500, "amount": 100, "pnl": 0, "created_at": "..." } ], "total": 1, "page": 1, "pageSize": 20 }
~~~

卖出记录的 pnl 会用持仓回合实时重算。

### POST /api/trades

Bearer（hotwave 使用绑定凭证）。请求：

~~~json
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
  "entrustNo": "",
  "strategyTag": "",
  "pnl": 0,
  "note": ""
}
~~~

### GET /api/trades/stats?mode=paper

payload：

~~~json
{
  "totalCount": 10,
  "buyCount": 6,
  "sellCount": 4,
  "winRate": 75.0,
  "totalPnl": 12345.67,
  "totalAmount": 1000000,
  "byStrategy": [ { "strategy_tag": "liquidate", "count": 2, "pnl": 100 } ]
}
~~~

### GET /api/trades/status

Bearer。经 hotwave 查交易路由状态：{ mode, liveReady, inTradingSession }。

### POST /api/trades/liquidate

Bearer。请求：{ "mode": "paper" | "live" }

- 非 A 股交易时段（北京时间 09:25-11:30 / 13:00-15:00）返回 400。
- 模拟盘本地成交，T+1 当日买入部分跳过。
- 实盘委托 hotwave 的 trader.liquidate。

响应：

~~~json
{
  "ok": true,
  "payload": {
    "liquidated": [ { "stockCode": "600519", "stockName": "贵州茅台", "amount": 100, "price": 1600, "pnl": 10000 } ],
    "skipped": [ { "stockCode": "000001", "stockName": "平安银行", "amount": 100, "reason": "T+1（今日买入，次日开盘可卖）" } ],
    "totalPnl": 10000
  }
}
~~~

---

## 11. 执行日志

### GET /api/execution-logs

Bearer。Query：mode，page，pageSize<=100。

payload：{ rows, total, page, pageSize }，行字段含 title/description/status/log_type/trade_id/strategy_tag。

### POST /api/execution-logs

Bearer。请求：

~~~json
{ "mode": "paper", "title": "买入", "description": "...", "status": "success", "logType": "trade", "tradeId": 1, "strategyTag": "" }
~~~

status：success / failure / pending / skipped；logType：trade / risk_control / system / alert。

---

## 12. 账户摘要

### GET /api/account/summary?mode=paper|live

Bearer。

- paper：以 PAPER_INITIAL_CASH 为初始资金，重放交易计算可用资金，再拉实时行情计算持仓市值。
- live：经 hotwave RPC trader.balance 查询真实账户。

响应：

~~~json
{
  "ok": true,
  "payload": {
    "mode": "paper",
    "initialCash": 1000000,
    "totalAssets": 1000000,
    "availableFunds": 900000,
    "positionMarketValue": 100000,
    "floatingPnl": 0
  }
}
~~~

---

## 13. 简报（heartbeat）

### GET /api/heartbeat-reports?date=YYYY-MM-DD

Bearer。date 为北京日期，默认今天。

payload：

~~~json
{
  "rows": [
    {
      "id": 1,
      "run_id": "run-xxx",
      "content": "...",
      "source": "heartbeat",
      "symbol": null,
      "input_tokens": 100,
      "output_tokens": 200,
      "total_tokens": 300,
      "cost": 0,
      "trigger_reason": null,
      "created_at": "..."
    }
  ]
}
~~~

### POST /api/heartbeat-reports

Bearer 或绑定凭证。请求：

~~~json
{ "runId": "run-xxx", "text": "决策正文", "source": "heartbeat", "symbol": "sh600519", "inputTokens": 100, "outputTokens": 200, "totalTokens": 300, "cost": 0, "triggerReason": "" }
~~~

响应：{ "ok": true, "payload": { "inserted": true, "id": 1, "runId": "run-xxx" } }。同一 runId 重复写入时 inserted=false。

### GET /api/heartbeat-reports/unread

Bearer。响应：{ "ok": true, "unread": 3 }。

### POST /api/heartbeat-reports/read

Bearer。响应：{ "ok": true, "lastReadAt": "..." }。

---

## 14. hotwave 绑定

### GET /api/hotwave-bindings

Bearer。payload：

~~~json
{
  "rows": [
    { "id": 1, "userId": 1, "bindingId": "hb_xxx", "label": "my-mac", "status": "active", "lastSeenAt": "...", "createdAt": "...", "revokedAt": null }
  ]
}
~~~

### POST /api/hotwave-bindings

Bearer。请求：{ "label": "my-mac" }

响应（secret 明文仅此一次）：

~~~json
{
  "ok": true,
  "payload": { "id": 1, "bindingId": "hb_xxx", "secret": "xxx", "label": "my-mac", "createdAt": "..." }
}
~~~

### DELETE /api/hotwave-bindings/[id]

Bearer。仅绑定所属用户可吊销。响应：{ "ok": true }。

---

## 15. APP 配套

### GET /api/app/startup

公开。启动画面配置，来自 app_configs 的 startup 键；未配置返回 payload:null。

~~~json
{
  "ok": true,
  "payload": {
    "enabled": true,
    "minVersion": "",
    "maxVersion": "",
    "animation": { "type": "lottie", "url": "/uploads/startup/xxx.json", "durationMs": 3000 },
    "splash": { "imageUrl": "", "clickUrl": "", "durationMs": 3000, "skipable": true }
  }
}
~~~

### GET /api/app/permissions

Bearer。权限快照（来自 user_rules）：

~~~json
{ "ok": true, "payload": { "blocked": false, "blockedPages": [], "blockedActions": [], "featureFlags": {} } }
~~~

### POST /api/events

公开。批量埋点，兼容直接数组或 { events: [...] }，单次最多 50 条。

~~~json
{ "events": [ { "event_type": "page_view", "event_name": "home", "page_path": "/home", "session_id": "s1", "extra": "{}" } ] }
~~~

响应：{ "ok": true, "received": 3 }。

### GET /api/uploads/[...path]

公开。读取 public/uploads 下的文件，带扩展名白名单与路径穿越防护。

---

## 16. 新闻

### GET /api/news/eastmoney?size=10&sortEnd=

Bearer。东财 7×24 快讯。

payload：

~~~json
{
  "rows": [ { "id": "xxx", "title": "...", "summary": "...", "time": "2026-11-20 12:00:00", "commentCount": 0, "images": [] } ],
  "sortEnd": "xxx",
  "hasMore": true
}
~~~

分页：把上一页返回的 sortEnd 作为下一页参数。

---

## 17. CORS

所有路由均处理 OPTIONS。响应头：

- Access-Control-Allow-Origin: *
- Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
- Access-Control-Allow-Headers: Content-Type, Authorization, version
- Access-Control-Max-Age: 86400

生产部署建议在反向代理层收紧 Origin。
