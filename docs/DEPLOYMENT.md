# 部署指南

本文件覆盖本机部署、反向代理、systemd/launchd 托管、Docker、升级与备份。

## 1. 环境要求

- Node.js >= 22（推荐 22 LTS 或 24）
- npm
- Linux / macOS
- 可选：反向代理（nginx、Caddy、Tailscale serve 等）

> 为什么要求 Node 22：better-sqlite3 原生模块按 Node ABI 编译；scripts/dev.mjs 也会探测版本并在不满足时给出提示。

## 2. 本机部署

~~~bash
git clone https://github.com/corning/hotwave_server.git
cd hotwave_server
npm ci
cp .env.example .env
# 编辑 .env：至少设置 SECRET_KEY
npm run seed
npm run create-user -- --phone=13800138000 --password=your-password
npm run build
npm start
~~~

默认监听 127.0.0.1:8000（BIND_HOST）。首次运行会在 database/ 下创建 SQLite 文件。

### 2.1 目录与数据

| 路径 | 内容 | 是否应备份 |
|------|------|------------|
| database/ | SQLite 主库与 WAL | 是 |
| public/uploads/ | 头像、启动资源 | 是 |
| persistent/all_stocks.json | 股票列表缓存 | 否（可自动重建） |
| .env | 密钥与配置 | 是（妥善保管） |

## 3. 反向代理与 TLS

服务端只监听回环地址，由反向代理对外提供服务。注意 SSE 不能缓冲。

### 3.1 nginx

~~~nginx
server {
    listen 443 ssl;
    server_name example.internal;

    ssl_certificate     /etc/ssl/example.crt;
    ssl_certificate_key /etc/ssl/example.key;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE：关闭缓冲，放宽读超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
~~~

### 3.2 Caddy

~~~caddy
example.internal {
    reverse_proxy 127.0.0.1:8000 {
        flush_interval -1
    }
}
~~~

### 3.3 Tailscale（可选）

若使用 Tailscale，可直接用 tailscale serve 终结 TLS，把 127.0.0.1:8000 暴露给 tailnet；不要绑定 0.0.0.0 到公网。

## 4. systemd（Linux）

创建 /etc/systemd/system/hotwave-server.service：

~~~ini
[Unit]
Description=HotWave Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hotwave
WorkingDirectory=/opt/hotwave_server
EnvironmentFile=/opt/hotwave_server/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
# 安全加固（按需调整）
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
~~~

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now hotwave-server
sudo systemctl status hotwave-server
journalctl -u hotwave-server -f
~~~

如果启用 HOTWAVE_SUPERVISOR_ENABLED=true，APP 会通过 systemctl --user 重启 hotwave；请确认运行用户与 unit 名匹配，或改用系统级 unit 并调整代码/环境变量。

## 5. launchd（macOS）

创建 ~/Library/LaunchAgents/com.hotwave.server.plist：

~~~xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hotwave.server</string>
  <key>WorkingDirectory</key>
  <string>/Users/you/Work/hotwave_server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npm</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BIND_HOST</key>
    <string>127.0.0.1</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hotwave-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hotwave-server.err.log</string>
</dict>
</plist>
~~~

~~~bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hotwave.server.plist
launchctl kickstart -k gui/$(id -u)/com.hotwave.server
launchctl bootout gui/$(id -u)/com.hotwave.server
~~~

注意 .env 由 Next.js 自动加载；launchd 只负责进程与工作目录。

## 6. Docker

~~~bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f

# 首次部署：建库 + 预置账号（也可在宿主机执行 npm run seed / create-user）
docker compose exec server npm run seed
docker compose exec server npm run create-user -- --phone=13800138000 --password=your-password
~~~

- 镜像基于 node:22-bookworm-slim，多阶段构建，以非 root 用户运行。
- 数据库挂载到宿主机 ./database，上传挂载到 ./public/uploads。
- Linux 宿主机首次挂载若报权限错误，先执行：sudo chown -R 1000:1000 database public/uploads（镜像内 node 用户 UID 为 1000）。
- 容器内 BIND_HOST/HOTWAVE_WS_HOST 设为 0.0.0.0；直接主机部署时保持 127.0.0.1。
- .dockerignore 已排除 .env、database、public/uploads，避免把本地数据打进镜像。

### 6.1 仅构建镜像

~~~bash
docker build -t hotwave-server .
docker run -d --name hotwave-server \
  --env-file .env \
  -p 127.0.0.1:8000:8000 \
  -p 127.0.0.1:18791:18791 \
  -v $(pwd)/database:/app/database \
  -v $(pwd)/public/uploads:/app/public/uploads \
  hotwave-server
~~~

## 7. 升级

~~~bash
git pull
npm ci
npm run build
# 重启进程（systemctl restart / launchctl kickstart -k / docker compose up -d --build）
~~~

- 数据库迁移在进程启动时自动执行，向后兼容旧库。
- 升级前先备份 database/ 与 public/uploads/。
- 若切换 Node 大版本，执行 npm rebuild better-sqlite3。

## 8. 备份与恢复

~~~bash
# 数据库在线备份
sqlite3 database/hotwave.db ".backup 'backup/hotwave-$(date +%Y%m%d).db'"

# 上传文件
tar -czf backup/uploads-$(date +%Y%m%d).tar.gz public/uploads
~~~

恢复：停服务 -> 覆盖 database/hotwave.db -> 删除 -wal/-shm -> 启动。

## 9. 安全检查清单

- [ ] SECRET_KEY 已设置且为随机长串，未提交到版本库
- [ ] HTTP/WS 只监听回环地址，或位于受信内网
- [ ] 反向代理已启用 TLS
- [ ] HOTWAVE_WS_HOST 未暴露公网（18791 仅本机或内网可达）
- [ ] HOTWAVE_SUPERVISOR_ENABLED 仅在需要时开启，并限制可访问用户
- [ ] database/、public/uploads/、.env 权限收紧（建议 600/700）
- [ ] 定期备份并验证可恢复
- [ ] 绑定 secret 泄露时立即吊销重建

## 10. 常见启动问题

| 问题 | 处理 |
|------|------|
| Could not locate the bindings file | npm rebuild better-sqlite3（Node 版本变化后必做） |
| EADDRINUSE 8000 / 18791 | 已有实例运行；用 lsof 找到并停止 |
| 启动成功但 APP 连不上 | 检查 BIND_HOST、反向代理、证书与 /api/health |
| hotwave 连不上 18791 | 检查 HOTWAVE_WS_HOST、防火墙、TRADE_API_WS_URL |
| 生产登录 500 | SECRET_KEY 未配置，查看日志 |
