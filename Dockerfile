# syntax=docker/dockerfile:1
# HotWave Server — 生产镜像（多阶段构建，非 root 运行）

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 在无预编译包时回退源码编译，需要构建工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    BIND_HOST=0.0.0.0 \
    PORT=8000

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public

# 运行期数据目录（数据库与上传文件应挂载卷，不要打进镜像）
RUN mkdir -p database public/uploads \
 && chown -R node:node /app
USER node

EXPOSE 8000 18791

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
