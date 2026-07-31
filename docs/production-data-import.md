# 生产数据一次性导入

该流程用于清理测试业务数据并导入审核后的生产数据。导入会保留唯一启用的 `admin` 账号以及日报发送时间、Webhook、启用状态，清空日报运行游标，并替换其余账号、项目、候选人、日报、日志和消息。

已确认的源职场名称会统一归属到正式项目：

- `南京六合职场` -> `南京降档`
- `美毓临汾职场`、`美毓通信临汾职场` -> `美毓-广西`
- `无锡新业务事业部` -> `无锡邮政`

## 本地准备

生产 Excel 不得提交到 Git。首次使用时创建独立 Python 环境：

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-import.txt
```

生成并校验导入包：

```bash
python3 scripts/prepare-production-import.py source.xlsx outputs/production-import
node scripts/apply-production-import.js outputs/production-import/production-import.json --dry-run
```

输出包含：

- `production-import.json`：服务器导入包。
- `已清洗可导入数据.xlsx`：校验通过且已标准化的数据。
- `待修正数据.xlsx`：身份证、手机号或重复规则未通过的数据。
- `HR临时账号.xlsx`：一次性账号和临时密码。
- `导入汇总.xlsx`：数量核验。

这些文件权限为 `0600`，包含敏感数据，不得提交仓库或通过公开渠道传输。

历史源表没有邮箱字段，因此导入值保持为空，不生成虚假邮箱；今后编辑该人员时由 HR 补全。工作经历仅在结构明确时拆分公司、职位和日期，无法可靠识别的内容保留原文，缺失内容不猜测。

## 生产执行

1. 停止应用写入并完成 MySQL、日报文件卷的可恢复备份。
2. 部署包含导入工具的新应用镜像。
3. 将 `production-import.json` 安全上传到服务器并复制到应用容器 `/tmp`。
4. 先执行 `--dry-run`，再显式执行替换：

```bash
docker compose exec -T app node scripts/apply-production-import.js /tmp/production-import.json --dry-run
docker compose exec -T app node scripts/apply-production-import.js /tmp/production-import.json --confirm-replace-business-data
```

5. 删除容器和服务器上的导入包，清理旧日报 PDF 文件但不删除 Docker 数据卷。
6. 验证仅保留 `admin` 与新 HR、项目和人员数量一致，然后逐个验证 HR 项目权限。

数据库替换和九张业务表的数量核验在同一事务内完成，任何一步失败都会回滚。禁止使用 `docker compose down -v`。
