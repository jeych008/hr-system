# GitHub 自动部署到阿里云

该方案使用仓库级自托管 Runner。Runner 从阿里云主动连接 GitHub，不需要向 GitHub 开放新的服务器端口，也不在 GitHub 保存 SSH 私钥、数据库密码或生产 `.env`。

## 安全边界

- Runner 使用独立账号 `hrdeploy`，不属于 `docker` 组，不能直接操作 Docker。
- 生产 `.env` 保持 `root:root`、权限 `0600`，Runner 无法读取。
- Runner 只能免密执行 root 所有的 `/usr/local/sbin/hr-resume-deploy`。
- 部署器只接受当前 `origin/main` 的完整 40 位提交 SHA，拒绝旧提交和任意分支。
- 仅 `main` 的 `push` 触发且整个 `CI` 工作流成功后才自动部署；PR 不接触生产 Runner。
- 部署前自动备份 MySQL、日报文件和 `.env`，备份目录仅 root 可读，默认保留 14 天。
- 新容器健康检查失败时自动恢复上一个提交，并保存失败日志。
- 生产数据导入包、HR 临时密码和候选人信息不会进入 GitHub Actions。

`/usr/local/sbin/hr-resume-deploy` 是 root 所有的受信任基础设施文件，不会被普通代码提交自动覆盖。将来若修改仓库中的 `deploy/hr-resume-deploy`，必须由管理员审查后重新运行一次安装脚本；应用代码的日常发布不需要该步骤。

## 一次性服务器设置

下面的设置只执行一次。以后向 `main` 推送并通过 CI 后会自动部署。

1. 在阿里云终端进入现有生产仓库，拉取包含本方案的提交：

```bash
cd /opt/hr-resume-system
git fetch origin main
git checkout main
git pull --ff-only origin main
sudo bash deploy/install-production-deployer.sh
```

2. 在 GitHub 仓库打开 `Settings -> Actions -> Runners -> New self-hosted runner`，选择 `Linux` 和服务器对应架构。复制 GitHub 页面生成的下载、校验和注册命令。

3. 在服务器使用专用目录安装。以下命令中的版本、压缩包、SHA-256 和短期 Token 必须使用 GitHub 页面当时给出的值，不要使用示例值：

```bash
sudo install -d -o hrdeploy -g hrdeploy -m 750 /opt/actions-runner
sudo -iu hrdeploy
cd /opt/actions-runner

# 在这里执行 GitHub 页面提供的 curl 和 sha256sum 校验命令
# 解压后注册，额外添加生产标签：
./config.sh \
  --url https://github.com/jeych008/hr-system \
  --token '<GitHub页面显示的短期Token>' \
  --name aliyun-production \
  --labels hr-production \
  --work _work \
  --unattended \
  --replace
exit

cd /opt/actions-runner
sudo ./svc.sh install hrdeploy
sudo ./svc.sh start
sudo ./svc.sh status
```

注册 Token 有效期很短，只用于首次注册，不写入仓库。Runner 后续使用自己的凭据出站连接 GitHub。

4. 回到 GitHub 的 Runners 页面，确认 `aliyun-production` 状态为 `Idle`，标签包含 `self-hosted`、`Linux`、`hr-production`。

## 自动触发规则

`.github/workflows/deploy-production.yml` 监听 `CI` 的完成事件：

1. 提交推送到 `main`。
2. 单元测试、MySQL/Redis 集成测试和生产镜像构建全部通过。
3. GitHub 把该次 CI 的精确提交 SHA 交给阿里云 Runner。
4. 服务器确认该 SHA 仍是最新 `origin/main`。
5. 自动备份、构建、更新应用和 Nginx、执行健康检查。
6. 成功后 Actions 显示部署摘要；失败时工作流为红色，服务器自动回滚。

同一时间只允许一个生产部署。连续快速推送时，旧提交因不再是最新 `origin/main` 会被安全拒绝，最新提交随后部署。

## 日常使用

日常只需正常提交并推送：

```bash
git push origin main
```

无需登录阿里云，也无需点击 `Promote production`。需要重新部署当前版本时，可以在 GitHub Actions 中手动运行 `Deploy production`。

## 查看状态与恢复

GitHub Actions 的 `Deploy production` 日志会显示备份路径、目标 SHA、健康检查和回滚结果。服务器状态文件位于：

```text
/var/lib/hr-resume-deploy/last-successful-sha
/var/lib/hr-resume-deploy/last-backup
```

备份位于 `/opt/hr-resume-system/backups/automatic/`。数据库备份包含敏感信息，不得上传 GitHub 或公开传输。
