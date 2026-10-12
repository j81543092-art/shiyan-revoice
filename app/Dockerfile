# 拾言 ReVoice —— 容器化部署
#
# 第 4 周硬里程碑：云上链接上线（不可顺延）。
#
# 依赖说明（重要）：任务 A / C 已引入 pg（RDS）与 ioredis（Redis）两个硬依赖，
# 镜像必须执行 npm ci 安装，否则容器内 import('pg') 会直接抛错、服务崩溃。
#
# 构建：docker build -t revoice:0.1.0 .
# 运行：docker run -p 8080:8080 -e PORT=8080 revoice:0.1.0

FROM node:22-alpine

WORKDIR /app

# 先复制依赖清单并安装（利用 Docker 层缓存，源码变更不触发重装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 只复制运行所需内容，减小镜像体积（评测/eval 只用于开发与 CI，不进生产镜像）
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/seed.js ./scripts/seed.js

# 数据目录（生产环境替换为 RDS；此处挂卷持久化兜底）
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

ENV PORT=8080
ENV NODE_ENV=production
# 未配置华为云凭证时自动走规则引擎，保证服务始终可启动
ENV MODEL_PROVIDER=""

EXPOSE 8080

# 非 root 用户运行（最小权限原则）
USER node

# 健康检查：评委点开链接前先确认服务活着
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
