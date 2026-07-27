# 第一阶段生产化说明

## 已完成范围

- MySQL 8 存储适配和可重复执行的建表脚本。
- `db.json` 到 MySQL 的一次性导入及数量核验。
- Redis 验证码和登录/H5提交限流。
- BCrypt 新密码和旧 scrypt 密码登录后升级。
- 生产环境配置门禁、JWT强化、安全响应头、请求大小限制、健康检查和优雅退出。
- Docker Compose 预发布基线，部署上下文排除真实数据库和导出包。

当前MySQL模型使用结构化索引列保存项目、手机号、状态和业务时间，同时使用JSON列保存完整业务对象，以保持现有接口行为。该模型适合第一阶段迁移验证；10万级报表性能优化和多API实例拆分属于下一阶段。

## 1. 安装依赖

```bash
npm install
python3 -m pip install -r requirements-pdf.txt
```

提交或构建镜像前必须生成并提交 `package-lock.json`，CI使用 `npm ci`。

## 2. 准备环境变量

```bash
cp .env.example .env
```

必须修改：

- `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`：仅供Docker Compose插值，不提交Git。
- `MYSQL_URL`：MySQL应用账号连接串。
- `JWT_SECRET`：至少32字节的密码学随机值。
- `PUBLIC_BASE_URL`：正式HTTPS地址。

可生成JWT密钥：

```bash
openssl rand -hex 32
```

## 3. 启动MySQL和Redis

```bash
docker compose up -d mysql redis
docker compose ps
```

## 4. 迁移前校验

只解析源文件，不连接数据库：

```bash
MYSQL_URL='mysql://hr_app:密码@127.0.0.1:3307/hr_resume' npm run db:migrate -- --dry-run data/db.json
```

迁移前应加密备份 `data/db.json`，记录 SHA-256，并确认目标库为空。还必须在原系统中修改所有现存账号密码并验证旧密码失效。

## 5. 导入MySQL

```bash
STORAGE_DRIVER=mysql \
MYSQL_URL='mysql://hr_app:密码@127.0.0.1:3307/hr_resume' \
npm run db:migrate -- data/db.json --confirm-credentials-rotated
```

目标库非空时命令会退出。`--force` 会清空目标业务表，仅可在已验证备份并明确需要全量重导时使用。

生产应用设置 `MYSQL_AUTO_MIGRATE=false`，启动账号只需业务表读写权限。建表和结构升级应使用单独的迁移账号执行迁移命令。

## 6. 启动预发布栈

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/health/ready
```

首次在本机启动时，也可以使用整合脚本完成Docker检查、基础设施启动、JSON数据迁移、镜像构建和健康检查：

```bash
./scripts/bootstrap-local-staging.sh
```

该脚本不会覆盖非空MySQL数据库。如果迁移曾经成功执行，请直接使用`docker compose up -d --build --wait`重启服务，不要使用迁移脚本的`--force`参数。

Compose中的Nginx仅绑定本机 `127.0.0.1:8080`。对公网提供服务时，应由宿主机Nginx、云负载均衡或WAF终止HTTPS，再反向代理到该地址。

## 7. 必做验收

本地预发布环境可先运行只读自动验收脚本。管理员密码采用隐藏输入，不会写入文件或命令历史：

```bash
./scripts/verify-local-staging.sh
```

如果迁移后的MySQL管理员密码与清理源不一致，可运行一次性修复脚本。脚本会更新MySQL和本地清理源中的BCrypt哈希、递增认证版本使旧JWT失效，并自动执行完整验收：

```bash
./scripts/reset-mysql-admin-password.sh
```

1. 管理员、HR、运营账号登录和菜单权限。
2. HR无法访问未分配项目，运营账号无法写入。
3. H5验证码一次性消费、重复手机号返回409。
4. 候选人状态完整流转和审计日志。
5. 项目目标、在职人数、离职和放弃入职统计。
6. PDF中文排版与Excel导出。
7. 服务重启后JWT、MySQL数据和Redis状态符合预期。
8. MySQL备份恢复演练。

## 当前限制

- 第一阶段只允许一个API实例执行 `RUN_BACKGROUND_JOBS=true`，避免日报任务并发；多实例和独立Worker在下一阶段实现。
- 当前前端Token改为 `sessionStorage`，尚未迁移到HttpOnly Cookie。部署前必须保持严格CSP并继续进行XSS复测。
- 报表仍在应用层加载并统计完整业务集合，10万数据性能门槛需在下一阶段改为SQL聚合后重新压测。
