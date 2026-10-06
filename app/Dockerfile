# 拾言 ReVoice —— 容器化部署
#
# 第 4 周硬里程碑：云上链接上线（不可顺延）。
# 镜像零外部依赖，不需要 npm install。
#
# 构建：docker build -t revoice:latest .
# 运行：docker run -p 8080:8080 -e PORT=8080 revoice:latest

FROM node:22-alpine

WORKDIR /app

# 只复制运行所需内容，减小镜像体积
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
COPY eval/ ./eval/
COPY scripts/ ./scripts/

# 数据目录（生产环境替换为 RDS；此处挂卷持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080
ENV NODE_ENV=production
# 未配置华为云凭证时自动走规则引擎，保证服务始终可启动
ENV MODEL_PROVIDER=""

EXPOSE 8080

# 健康检查：评委点开链接前先确认服务活着
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
