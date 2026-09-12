# 服务端零 npm 依赖，镜像里就是官方 Node 运行时加一份源码。
# node:sqlite 是 Node 24 起才有的内置模块，基础镜像版本别往下改。
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src

# 数据库目录先建好并交给运行用户：named volume 首次挂载会沿用目录的属主，
# 不 chown 的话挂进来就是 root 所有，非 root 进程写不进去
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787

# 容器自带的存活探测，省得往镜像里塞 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GOK_PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/start.mjs"]
