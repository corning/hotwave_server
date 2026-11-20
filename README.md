# 热浪金融 — 服务端（HotWave Server / hotwave_server）

> 热浪金融（HotWave）的平台服务端：账号与会话、行情聚合、监控上行、交易与简报落库，以及 HotWave APP 的 REST/SSE 接口。基于 Next.js 14 App Router + SQLite，单进程即可运行。

![Node](https://img.shields.io/badge/node-%3E%3D22-339933)
![Next.js](https://img.shields.io/badge/Next.js-14-black)
![SQLite](https://img.shields.io/badge/database-SQLite-003B57)
![License](https://img.shields.io/badge/license-MIT-blue)

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 与 HotWave 的关系](#2-与-hotwave-的关系)
- [3. 功能特性](#3-功能特性)
- [4. 架构](#4-架构)
- [5. 目录结构](#5-目录结构)
- [6. 快速开始](#6-快速开始)
- [7. 配置参考](#7-配置参考)
- [8. 与 hotwave 对接](#8-与-hotwave-对接)
- [9. API 概览](#9-api-概览)
- [10. 数据库](#10-数据库)
- [11. 部署](#11-部署)
- [12. 安全与免责](#12-安全与免责)
- [13. 开发与测试](#13-开发与测试)
- [14. 排障](#14-排障)
- [15. 贡献与 License](#15-贡献与-license)

---

## 1. 项目简介

热浪金融服务端为客户端 Agent 与手机 APP 提供统一的数据与业务接口：

- **账号与会话**：预置账号、JWT 登录、聊天记录持久化。
- **Agent 控制面**：运行态、流式中断、审批、进程重启。
- **行情数据**：A 股/ETF 的报价、五档、分时、K 线、逐笔、F10、热榜、异动、交易日历。
- **监控**：订阅/取消订阅、告警 SSE、历史告警回放。
- **交易与执行**：交易记录、持仓重放、盈亏/胜率统计、执行日志、一键清仓。
- **简报（heartbeat）**：LLM 决策落库、未读红点。
- **绑定**：hotwave 实例与用户的绑定凭证（binding id + secret）。
- **APP 配套**：启动画面配置、权限快照、埋点上报、头像上传。

本仓库只包含服务端，与 hotwave、APP 相关的接口全部保留。

---

## 2. 与 HotWave 的关系

| 组件 | 角色 | 是否在本仓库 |
|------|------|--------------|
| [hotwave](https://github.com/corning/hotwave) | 客户端 Agent 运行时：对话、工具、监控、交易、心跳 | 否（独立仓库） |
| **hotwave_server（本仓库）** | 平台服务：账号、行情聚合、数据落库、APP 接口 | 是 |
| hotwave_app | Flutter 手机 APP | 暂未开源 |

~~~text
                       +------------------------------+
   hotwave_app ------>|  HotWave Server  :8000       |
   (REST / SSE)        |  账号 · 会话 · 行情 · 交易    |
                       |  简报 · 监控 · 绑定 · 上传    |
   hotwave  ---------->|                              |
   (反向 WS :18791)    +--------------+---------------+
                                       |
                          +------------+------------+
                          | SQLite（WAL）            |
                          | 用户/会话/交易/简报/绑定 |
                          +-------------------------+
~~~

两种运行形态：

- **本机单 Agent（默认推荐）**：CHAT_ENGINE=kernel，Server 直接调用同机 hotwave 运行时的 HTTP/SSE 接口；hotwave 再通过反向 WS 提供监控与交易 RPC。
- **多用户/多实例**：CHAT_ENGINE=legacy，聊天也走 hotwave 主动建立的反向 WS 连接；每个用户绑定各自的 hotwave 实例。

---

## 3. 功能特性

| 能力 | 说明 |
|------|------|
| 账号体系 | 私有部署，无公开注册；账号由主机 owner 预置，仅密码登录 |
| JWT 鉴权 | 7 天有效期；Bearer Token；生产环境强制要求 SECRET_KEY |
| hotwave 绑定鉴权 | X-Binding-Id + X-Binding-Secret，secret 仅存 bcrypt 哈希 |
| 流式聊天 | POST /api/chat/send 返回 SSE：正文增量、推理增量、工具状态、最终文本 |
| Agent 控制面 | 状态、中断、审批列表/决策、控制面事件 SSE、进程托管 |
| 行情聚合 | 腾讯/东方财富/同花顺公开数据 + 内存 TTL 缓存，统一代码格式 |
| 监控 | 订阅/取消、告警 SSE、历史告警落库回放 |
| 交易 | 模拟/实盘记录、持仓重放、T+1 清仓、盈亏与胜率重算、执行日志 |
| 简报 | heartbeat_reports 独立表，run_id 去重，按用户未读计数 |
| APP 配套 | 启动画面、权限快照、埋点、头像/启动资源静态访问 |
| 部署 | npm / Docker Compose；支持 launchd、systemd 托管 |

---

## 4. 架构

### 4.1 端口与方向

| 端口 | 方向 | 用途 | 配置 |
|------|------|------|------|
| 8000 | 入站 HTTP | REST + SSE，APP 与 hotwave 数据端点 | BIND_HOST / PORT |
| 18791 | 入站 WS | hotwave 反向长连接（hotwave 为 client） | HOTWAVE_WS_PORT / HOTWAVE_WS_HOST |
| 8791 | 出站 HTTP | 仅 CHAT_ENGINE=kernel 时访问同机 hotwave 运行时 | AGENT_RUNTIME_URL |

### 4.2 聊天链路

~~~text
APP --POST /api/chat/send--> Server --kernel: HTTP POST /chat/send--> hotwave runtime
                              |        legacy: WS req chat.send ----> hotwave（反向连接）
                              |
                              +- 落库用户消息
                              +- 逐条转发 delta / reasoning / thinking
                              +- done：落库完整 assistant 消息
~~~

- SSE 事件：delta、final、reasoning_delta、thinking、thinking_done、done、error。
- 15 秒 keepalive 注释帧，避免移动网络/反代空闲断链。
- 客户端断开时中止上游流式请求。

### 4.3 反向长连接与绑定

~~~text
1. APP 调 POST /api/hotwave-bindings 生成 binding_id + secret（明文仅返回一次）
2. 把 binding_id / secret 写入 hotwave 的 .env：
     TRADE_API_BASE=http://127.0.0.1:8000/api
     TRADE_API_WS_URL=ws://127.0.0.1:18791
     TRADE_BINDING_ID=...
     TRADE_BINDING_SECRET=...
3. hotwave 启动后主动连入 Server 的 :18791
4. Server 发 connect.challenge -> hotwave 回 connect（bindingId/secret/nonce）
5. 校验通过后，Server 可下发 RPC，hotwave 可上行事件
~~~

RPC 与事件帧格式、方法清单见 [docs/INTEGRATION.md](docs/INTEGRATION.md)。

---

## 5. 目录结构

~~~text
hotwave_server/
├── package.json               # 依赖与脚本（dev/build/start/seed/create-user/typecheck）
├── next.config.js             # instrumentation hook + better-sqlite3/ws externals
├── Dockerfile                 # 多阶段构建，非 root 运行
├── docker-compose.yml         # 单服务编排（8000 + 18791）
├── .env.example               # 环境变量模板
├── database/                  # SQLite（运行期生成，已在 .gitignore 中）
├── persistent/                # 全市场股票列表缓存（运行期生成）
├── public/
│   ├── defaults/avatars/      # 默认头像
│   └── uploads/               # 用户上传（运行期生成，已忽略）
├── scripts/
│   └── dev.mjs                # Node 版本探测 + 端口检查 + 启动 next
└── src/
    ├── instrumentation.ts     # 启动时拉起反向 WS server（:18791）
    ├── types/index.ts
    ├── lib/
    │   ├── db.ts                    # SQLite 连接、建表/迁移、全部查询
    │   ├── auth.ts                  # JWT 签发/校验
    │   ├── middleware.ts            # authenticateRequest + 设备上下文 + 全局封禁
    │   ├── hotwave-ws-server.ts     # 反向 WS：握手、RPC、上行事件、流式通道
    │   ├── agent-kernel-bridge.ts   # kernel 引擎 HTTP/SSE 桥接
    │   ├── agent-manager.ts         # Agent 列表/状态
    │   ├── seed.ts                  # 建库脚本
    │   ├── create-user.ts           # 预置账号脚本
    │   ├── load-env.ts              # tsx 脚本的 .env 加载
    │   ├── stock-data.ts            # 行情/K线/分时/逐笔/热榜
    │   ├── finance-data.ts          # 东财/同花顺榜单与 F10
    │   ├── eastmoney-data.ts        # 东财 F10/逐笔成交
    │   ├── market-snapshot.ts       # 异动票池/大单检测
    │   ├── stock-list.ts            # 全市场列表缓存
    │   ├── stock-symbol.ts          # 代码标准化
    │   ├── trade-days.ts            # 交易日历
    │   ├── trading-session.ts       # 交易时段判断
    │   └── cors.ts / upstream-error.ts
    └── app/api/
        ├── health/                 # 公开健康检查
        ├── auth/{login,user-info,profile}/
        ├── chat/{send,history,abort}/
        ├── agent/{list,status,state,events,supervisor}/
        ├── approvals/ + approvals/[id]/
        ├── monitor/{alerts,search-stocks,subscribe,unsubscribe}/
        ├── stock/{search,detail,quote,quote-batch,timeline,kline,trades,hot,f10}/
        ├── hotwave/{quote,kline,f10,hot,market,stocks,stocks/search,trade-days}/  # 公开数据端点
        ├── watchlist/ + watchlist/[symbol]/
        ├── trades/{,stats,status,liquidate}/
        ├── execution-logs/
        ├── account/summary/
        ├── heartbeat-reports/{,unread,read}/
        ├── hotwave-bindings/ + hotwave-bindings/[id]/
        ├── app/{permissions,startup}/
        ├── events/
        ├── news/eastmoney/
        └── uploads/[...path]/
~~~

---

## 6. 快速开始

### 6.1 环境要求

- Node.js **>= 22**（better-sqlite3 原生模块与 scripts/dev.mjs 均要求）
- npm（仓库使用 package-lock.json）
- 可选：Docker / Docker Compose

### 6.2 启动服务端

~~~bash
git clone https://github.com/corning/hotwave_server.git
cd hotwave_server
npm install

cp .env.example .env
# 生产环境务必生成并填入 SECRET_KEY
openssl rand -hex 32

npm run seed        # 建库 + 建表
npm run create-user -- --phone=13800138000 --password=your-password
npm run dev         # http://127.0.0.1:8000
~~~

健康检查：

~~~bash
curl http://127.0.0.1:8000/api/health
# {"ok":true,"service":"hotwave-server","version":"1.0.0","time":"..."}
~~~

### 6.3 连接 hotwave

1. 登录 APP 或直接调用接口创建绑定：

~~~bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/auth/login -H "Content-Type: application/json" -d '{"phone":"13800138000","password":"your-password"}' | jq -r .token)

curl -X POST http://127.0.0.1:8000/api/hotwave-bindings -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"label":"my-mac"}'
# 返回 bindingId 与 secret（secret 只显示这一次）
~~~

2. 写入 hotwave 的 .env：

~~~bash
TRADE_API_BASE=http://127.0.0.1:8000/api
TRADE_API_WS_URL=ws://127.0.0.1:18791
TRADE_BINDING_ID=hb_xxxxxxxxxxxxxxxx
TRADE_BINDING_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
~~~

3. 重启 hotwave。看到 hotwave 已连接后，APP 的 Agent 状态应变为在线。

> hotwave 的完整配置见其仓库的 .env.example 与 README。

---

## 7. 配置参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| SECRET_KEY | 无（开发模式有兜底） | JWT 签名密钥。生产必须设置 ≥32 字节随机串 |
| BIND_HOST | 127.0.0.1 | HTTP 监听地址（勿用 HOSTNAME，Docker 会注入） |
| PORT | 8000 | HTTP 端口 |
| DATABASE_PATH | database/hotwave.db | SQLite 文件路径（相对仓库根） |
| TZ | Asia/Shanghai | 时区；交易时段/简报日期依赖北京时间 |
| HOTWAVE_WS_PORT | 18791 | 反向 WS 监听端口 |
| HOTWAVE_WS_HOST | 127.0.0.1 | 反向 WS 监听地址 |
| CHAT_ENGINE | legacy | kernel（本机 HTTP 运行时）或 legacy（反向 WS） |
| AGENT_RUNTIME_URL | http://127.0.0.1:8791 | kernel 模式下的 hotwave 运行时地址 |
| AGENT_RUNTIME_TOKEN | 空 | 运行时 Bearer Token（hotwave 设置了才需填） |
| PAPER_INITIAL_CASH | 1000000 | 模拟盘初始资金（元） |
| HOTWAVE_SUPERVISOR_ENABLED | false | 是否允许 /api/agent/supervisor 重启本机 hotwave 服务 |
| HOTWAVE_SUPERVISOR_LABEL | com.hotwave.runtime | launchd label 或 systemd unit 名 |

完整模板见 [.env.example](.env.example)。

---

## 8. 与 hotwave 对接

### 8.1 数据契约（供 hotwave 行情工具）

hotwave 的行情工具统一访问本服务的 /api/hotwave/* 端点（**无鉴权**，仅返回公开行情数据）：

| 端点 | 方法 | 用途 |
|------|------|------|
| /api/hotwave/quote | POST | 个股/指数实时报价 + 五档 |
| /api/hotwave/kline | POST | 日 K（前复权） |
| /api/hotwave/f10 | POST | F10 基本面（摘要或原始 8 类） |
| /api/hotwave/hot | POST | 热榜 / 涨幅榜 / ETF / 港股 / 美股 |
| /api/hotwave/market | POST | 异动票池 / 大单突增 |
| /api/hotwave/stocks | GET | 全市场股票 + ETF 列表 |
| /api/hotwave/stocks/search | GET | 股票搜索 |
| /api/hotwave/trade-days | GET | A 股交易日历 |

请求/响应字段见 [docs/INTEGRATION.md](docs/INTEGRATION.md) 与 [docs/API.md](docs/API.md)。

### 8.2 回写链路

hotwave 通过绑定凭证或 JWT 回写：

| 数据 | 端点 | 说明 |
|------|------|------|
| 交易记录 | POST /api/trades | mode/stockCode/bsType/price/amount 等 |
| 执行日志 | POST /api/execution-logs | 步骤化交易/风控日志 |
| 简报/决策 | POST /api/heartbeat-reports | runId 去重，source 区分 heartbeat/alert/schedule |
| 告警 | WS 上行 monitor.alert | Server 落库并由 SSE 推给 APP |

### 8.3 详细文档

- [docs/INTEGRATION.md](docs/INTEGRATION.md)：握手、RPC 方法、事件、数据端点、时序。
- [docs/API.md](docs/API.md)：全部 REST/SSE 接口。
- [docs/DATABASE.md](docs/DATABASE.md)：表结构与统计口径。
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)：systemd/launchd/Docker、反向代理与备份。

---

## 9. API 概览

> 鉴权：Bearer JWT 或 X-Binding-Id + X-Binding-Secret；标注「公开」的端点无需鉴权。

### 9.1 基础

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | /api/health | 健康检查 | 公开 |
| POST | /api/auth/login | 密码登录 | 公开 |
| GET | /api/auth/user-info | 当前用户信息 | Bearer |
| POST | /api/auth/profile | 修改昵称/上传头像（multipart） | Bearer |

### 9.2 聊天与控制面

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat/send | SSE 流式对话 |
| GET | /api/chat/history | 历史消息（agentId/date/before/beforeDate/分页） |
| POST | /api/chat/abort | 中断当前 run |
| GET | /api/agent/list | Agent 列表（公开） |
| GET | /api/agent/status | Agent 在线状态 |
| GET | /api/agent/state | 运行态 |
| GET | /api/agent/events | 控制面事件 SSE |
| GET/POST | /api/agent/supervisor | 进程状态 / 重启 |
| GET | /api/approvals | 待审批列表 |
| POST | /api/approvals/[id] | 审批决策 |

### 9.3 行情与监控

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stock/search / detail / quote / quote-batch | 搜索/详情/报价/批量报价 |
| GET | /api/stock/timeline / kline / trades / hot / f10 | 分时/K线/逐笔/热榜/F10 |
| GET | /api/monitor/alerts | 告警 SSE |
| GET | /api/monitor/search-stocks | 搜索（经 hotwave） |
| POST | /api/monitor/subscribe / unsubscribe | 订阅/取消订阅 |
| GET | /api/news/eastmoney | 东财 7×24 资讯 |

### 9.4 交易、账户与简报

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | /api/trades | 查询/写入交易记录 |
| GET | /api/trades/stats | 盈亏、胜率、按策略统计 |
| GET | /api/trades/status | hotwave 交易状态 |
| POST | /api/trades/liquidate | 一键清仓（含 T+1 校验） |
| GET/POST | /api/execution-logs | 执行日志 |
| GET | /api/account/summary | 账户资产摘要 |
| GET/POST | /api/heartbeat-reports | 简报查询/回写 |
| GET | /api/heartbeat-reports/unread | 未读数 |
| POST | /api/heartbeat-reports/read | 标记已读 |

### 9.5 绑定与 APP 配套

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | /api/hotwave-bindings | 绑定列表/创建 |
| DELETE | /api/hotwave-bindings/[id] | 吊销绑定 |
| GET | /api/app/startup | 启动画面配置（公开，可为 null） |
| GET | /api/app/permissions | 权限快照 |
| POST | /api/events | 埋点上报（公开） |
| GET | /api/uploads/[...path] | 上传文件静态访问 |

完整请求参数、响应体与 SSE 事件定义见 [docs/API.md](docs/API.md)。

---

## 10. 数据库

SQLite（WAL），默认 database/hotwave.db。表：

users · chat_messages · watchlist · trades · execution_logs · monitor_alerts · heartbeat_reports · heartbeat_read_state · hotwave_bindings · app_configs · user_rules · app_events

关键口径：

- **交易盈亏/胜率**按「持仓回合」重算，不依赖入库 pnl；买入手续费摊入成本，卖出扣佣金+印花税。
- **T+1**：一键清仓只卖非当日买入部分。
- **时间**：created_at 以 UTC 存储，展示/筛选按北京时间换算。
- **简报去重**：heartbeat_reports.run_id 唯一，bridge 与 hotwave 回写同一 runId 只落一条。

详见 [docs/DATABASE.md](docs/DATABASE.md)。

---

## 11. 部署

### 11.1 本机常驻

~~~bash
npm run build
npm start    # 默认 127.0.0.1:8000
~~~

macOS 可用 launchd、Linux 可用 systemd 托管，示例见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

### 11.2 Docker

~~~bash
cp .env.example .env
docker compose up -d --build

# 首次部署：容器内建库并预置账号
docker compose exec server npm run seed
docker compose exec server npm run create-user -- --phone=13800138000 --password=your-password
~~~

容器内监听 0.0.0.0，数据库与上传目录通过卷持久化。**不要把 .env、database/、public/uploads/ 打进镜像**（.dockerignore 已排除）。

### 11.3 生产检查清单

- [ ] SECRET_KEY 已设置为随机长串
- [ ] 服务只监听回环地址，由反向代理终结 TLS
- [ ] HOTWAVE_WS_HOST 未暴露到公网
- [ ] HOTWAVE_SUPERVISOR_ENABLED 按需开启
- [ ] 定期备份 database/ 与 public/uploads/
- [ ] 不把 .env、数据库、上传文件提交到版本库

---

## 12. 安全与免责

- 本项目面向**私有部署**：没有公开注册、短信与找回密码。账号由主机 owner 预置。
- 行情数据来自公开第三方接口，仅供研究，不构成投资建议。
- 实盘交易依赖 hotwave 端的交易通道与风控；本项目只做记录与展示，不直接下单。
- 默认配置尽量收紧（回环监听、supervisor 关闭、绑定凭证哈希存储），但部署者仍需自行评估网络暴露面。
- 若发现安全问题，请通过 Issues 或仓库维护者私下联系，不要公开可利用细节。

---

## 13. 开发与测试

~~~bash
npm run typecheck   # tsc --noEmit
npm run build       # next build
npm run dev         # 开发模式
~~~

- 数据库表结构在 src/lib/db.ts 中以幂等 CREATE TABLE IF NOT EXISTS / ALTER TABLE 维护，启动即迁移。
- 新增接口请遵循现有响应约定：成功 { ok: true, payload }，失败 { ok: false, error }；APP 兼容接口沿用 { message }。
- 所有路由需处理 OPTIONS（CORS 预检）。
- 修改 hotwave 相关协议时，请同步更新 [docs/INTEGRATION.md](docs/INTEGRATION.md)。

---

## 14. 排障

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| Could not locate the bindings file | Node 大版本变化后 better-sqlite3 未重编 | npm rebuild better-sqlite3 |
| 端口 8000/18791 被占用 | 已有实例在跑 | lsof -nP -iTCP:8000 -sTCP:LISTEN，先停旧实例 |
| APP 显示 hotwave 离线 | 绑定凭证不一致 / hotwave 未启动 | 重新生成绑定并同步 hotwave .env，查看服务端日志 |
| 行情端点 502 | 第三方数据源限流或网络问题 | 稍后重试；检查 src/lib/stock-data.ts 日志 |
| 登录返回 500 | 生产环境未配置 SECRET_KEY | 在 .env 填入随机密钥并重启 |
| 简报未读数不对 | heartbeat_read_state 未更新 | 调 POST /api/heartbeat-reports/read |

---

## 15. 贡献与 License

- 欢迎提交 Issue / PR。请保持改动聚焦，并附上复现步骤或测试结果。
- 提交前运行 npm run typecheck 与 npm run build。
- 本项目采用 [MIT License](LICENSE)。

相关问题与反馈：<https://github.com/corning/hotwave_server/issues>
