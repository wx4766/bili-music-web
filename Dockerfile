# 零依赖镜像：仅用 Node 标准库，无需 npm install
FROM node:20-alpine

WORKDIR /app

# 仅复制运行所需文件
COPY server.js package.json ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# 收藏数据挂载到 /data 卷
ENV DATA_DIR=/data
RUN mkdir -p /data

# node 版健康检查（避免 slim/alpine 镜像里没有 wget/curl 的坑）
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
