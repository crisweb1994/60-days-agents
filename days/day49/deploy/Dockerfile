# 第 48 天：研究助手的镜像。在仓库根目录构建：
#   docker build -f days/day49/deploy/Dockerfile -t research-assistant .
# 默认打包参考答案；部署你自己的练习：--build-arg APP_DIR=days/day49/exercise
# 两个阶段：deps 只装生产依赖（package*.json 不变时这一层走缓存），runtime 只拷贝运行需要的东西。
# Node 22.18 起可以直接运行 .ts 文件，不需要编译这一步。

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev：不装 typescript、vitest 这些开发依赖；--ignore-scripts：不执行依赖包的安装脚本（第 38 天说过的供应链风险）
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-slim AS runtime
ARG APP_DIR=days/day49/solution
ENV NODE_ENV=production \
    PORT=8080 \
    OBJECT_DIR=/data/objects
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY ${APP_DIR} ./app
COPY days/day49/data ./data
# 上传的文件和工作目录放在 /data，挂一个卷；镜像本身只读
RUN mkdir -p /data/objects /data/workspace && chown -R node:node /data
# 不用 root 运行：官方镜像自带 node 用户
USER node
EXPOSE 8080
# 平台用它判断容器活着没有。/healthz 不检查依赖，数据库挂了不会让容器被反复重启
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 直接用 node 启动（不经过 npm 或者 sh -c），SIGTERM 才能送到 Node 进程，优雅退出才会生效
CMD ["node", "app/server-main.ts"]
