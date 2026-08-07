# AGENTS.md — Claude Relay Service

面向 AI Agent 与本仓库协作的约定，重点是**生产上线**（`master-cc-on` 分支）。

项目日常开发说明见 [CLAUDE.md](./CLAUDE.md)。

## 分支与仓库

| 分支 | 用途 |
|------|------|
| `master-cc-on` | **线上 CC 生产**（`niubi.cc-flyer.com/cc/`），默认上线用这个 |
| `cc-master` | 另一套 CC 分支，勿与 `master-cc-on` 混用 |
| `main` | 上游同步主线，不等于当前生产 |

远程：`https://github.com/lov-team/claude-relay-service.git`

## 生产环境拓扑

| 项 | 值 |
|----|-----|
| 服务器 | `ubuntu@47.128.78.22` |
| 部署目录 | `/opt/claude-relay-service-old`（符号链接 → `/mnt/data50/claude-relay-service-old`） |
| 容器 | `claude-relay-service-old-claude-relay-1` |
| 监听 | `127.0.0.1:3007` → 容器 `3000` |
| Redis | 同 compose：`claude-relay-service-old-redis-1` |
| 公网入口 | Nginx → `https://niubi.cc-flyer.com/cc/` |
| 管理后台 | `https://niubi.cc-flyer.com/cc/admin-next/` |
| 健康检查 | `https://niubi.cc-flyer.com/cc/health` |

**重要**：服务器目录是**静态代码副本**，不是 git 仓库。上线用本地 `rsync`，不要用 `git pull`。

生产密钥在服务器 `/mnt/data50/claude-relay-service-old/.env`（`rsync` 时必须排除，禁止覆盖）。

## 生产 `.env` 要点

以下键由运维维护，Agent 不要写入仓库、不要打印明文：

```bash
BIND_HOST=127.0.0.1
PORT=3007
VITE_APP_BASE_URL=/cc/admin-next/
WEB_LOGO_URL=/cc/assets/logo.png
JWT_SECRET=...
ENCRYPTION_KEY=...
ADMIN_USERNAME=...
ADMIN_PASSWORD=...
```

`VITE_APP_BASE_URL` 必须在 **Docker 构建前端** 时生效，否则静态资源会指向 `/admin-next/` 导致 404。

## 标准上线流程（`master-cc-on`）

在**本地**已切到 `master-cc-on` 且与 `origin` 同步后执行。

### 1. 同步代码到服务器

```bash
# 本地项目根目录
rsync -az \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'web/admin-spa/node_modules' \
  --exclude '.env' \
  --exclude 'data' \
  --exclude 'logs' \
  --exclude 'temp' \
  --exclude 'redis_data' \
  ./ \
  ubuntu@47.128.78.22:/mnt/data50/claude-relay-service-old/
```

注意：

- **不要用** `rsync --delete`，会误删 `redis_data/`、`docker-compose.override.yml` 等运行态文件。
- 不要同步本地 `.env` 覆盖生产配置。

### 2. 确保 Dockerfile 支持前端 base path

`frontend-builder` 阶段需有（没有则补上）：

```dockerfile
ARG VITE_APP_BASE_URL=/admin-next/
ENV VITE_APP_BASE_URL=$VITE_APP_BASE_URL
```

位置：在 `COPY web/admin-spa/ ./` 之后、`RUN npm run build` 之前。

### 3. 构建镜像

```bash
ssh ubuntu@47.128.78.22 'cd /mnt/data50/claude-relay-service-old && \
  sudo docker build \
    --build-arg VITE_APP_BASE_URL=/cc/admin-next/ \
    -t claude-relay-service-old:master-cc-on .'
```

构建较久（约 2–5 分钟），需等待 `naming to docker.io/library/claude-relay-service-old:master-cc-on` 完成。

### 4. 指定镜像并重启（仅 claude-relay，不动 Redis）

服务器需存在 `docker-compose.override.yml`：

```yaml
services:
  claude-relay:
    image: claude-relay-service-old:master-cc-on
```

```bash
ssh ubuntu@47.128.78.22 'cd /mnt/data50/claude-relay-service-old && \
  sudo docker compose -f docker-compose.yml -f docker-compose.override.yml up -d claude-relay'
```

### 5. 验证

```bash
# 本机健康
ssh ubuntu@47.128.78.22 'curl -s http://127.0.0.1:3007/health'

# 容器状态
ssh ubuntu@47.128.78.22 'cd /mnt/data50/claude-relay-service-old && \
  sudo docker compose -f docker-compose.yml -f docker-compose.override.yml ps'

# 前端资源前缀应为 /cc/admin-next/
ssh ubuntu@47.128.78.22 'sudo docker run --rm --entrypoint sh claude-relay-service-old:master-cc-on \
  -c "grep -oE \"(src|href)=\\\"[^\\\"]+\\\"\" /app/web/admin-spa/dist/index.html | head -3"'

# 公网
curl -s -o /dev/null -w "%{http_code}\n" https://niubi.cc-flyer.com/cc/health
```

期望：容器 `healthy`，健康检查 JSON 中 `status` 为 `healthy`，公网返回 `200`。

## 上线后人工抽查（养号相关）

1. 打开 `https://niubi.cc-flyer.com/cc/admin-next/` → 账户列表
2. 养号账户应显示「养号 Dn / 常驻」标签；有阻断时列表显示「养号阻断：…」
3. 全号养号挡路时，new-api 渠道应收到 **403**（非 500），以便自动禁用

## 常见问题

| 现象 | 处理 |
|------|------|
| 管理后台 JS/CSS 404 | 未用 `/cc/admin-next/` 重建镜像；按步骤 2–3 重新 build |
| `rsync --delete` 后 compose 起不来 | 重建 `docker-compose.override.yml`（见步骤 4） |
| 养号仍像 10% 额度 | 确认镜像内存在 `calcSevenDaySteadyPaceLimit`（`master-cc-on` 新逻辑） |
| Redis 数据丢失 | 永远不要 delete `redis_data/` |

## Agent 约束

- 默认生产上线分支：**`master-cc-on`**
- **代码必须先 push 到 GitHub 再部署**：禁止把仅存在于本地的改动直接 rsync 到服务器；未推送的改动会被其他人从仓库代码的部署覆盖丢失
- 上线必须 Agent 自己 SSH 执行，不要只给用户命令
- 禁止在日志、回复、提交中输出生产 `JWT_SECRET` / `ENCRYPTION_KEY` / 管理员密码
- 修改上线流程时同步更新本文件