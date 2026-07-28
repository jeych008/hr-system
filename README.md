# 在线简历收集系统

这是一个面向多职场招聘全流程跟踪的在线简历收集与招聘运营系统，覆盖候选人 H5 自助填报、HR 后台代填、项目权限、自动招聘统计、日报快照、招聘报表、PDF/Excel 导出和操作日志。

## 快速启动

```bash
npm install
python3 -m pip install -r requirements-pdf.txt
npm start
```

PDF 下载使用 ReportLab 和嵌入式中文字体生成。可通过 `PDF_PYTHON` 指定 Python 解释器，通过 `PDF_FONT_PATH` 指定可嵌入的中文 TTF/TTC 字体。

启动后访问：

- 后台管理：http://localhost:5177
- 候选人 H5：http://localhost:5177/h5.html?projectId=p_service_center

系统不再创建默认账号。已有开发数据库中的账号保持不变；新建 JSON 开发数据库时必须通过 `INITIAL_ADMIN_USERNAME` 和 `INITIAL_ADMIN_PASSWORD` 显式设置首个管理员。

## 技术实现

- 后端：Node.js 原生 HTTP API；简历 PDF 由 Python ReportLab 标准生成器输出。
- 前端：独立静态 HTML/CSS/JS，后台 PC 端与候选人移动 H5 分离。
- 数据库：开发环境可使用 `data/db.json`；生产环境使用 MySQL 8。第一阶段采用索引列与 JSON 完整业务载荷并存的迁移模型。
- 安全状态：生产环境使用 Redis 保存验证码和限流计数；开发环境可使用进程内后备。
- 鉴权：HS256 JWT，仅接受 `Authorization: Bearer`。生产环境强制要求稳定且不少于32字节的 `JWT_SECRET`。
- 密码：新密码使用 BCrypt；旧 `scrypt` 密码首次登录成功后自动升级为 BCrypt。

## 核心能力

- 项目级权限：管理员可看全部项目并管理配置，HR 仅能访问被分配项目，运营账号可只读查看全部项目招聘数据和统计。
- 运营账号：可查看全部候选人、日报快照、招聘统计，并下载简历 PDF/报表 Excel；不显示账号管理、项目配置等后台配置或写入功能。
- 项目管理：项目配置页集中展示项目状态、负责 HR、当月目标总人数、当前在岗、剩余缺口和独立填写链接；管理员可新增项目、编辑名称、指定 HR、维护月度目标、复制链接，并通过“删除/停用”关闭项目。
- 账号校验：创建 HR 账号时用户名、姓名、密码和负责项目必填，前端和后端都会校验。
- 账号管理：管理员可创建 HR 或运营账号，支持分配项目、修改密码、启用/禁用和删除账号，系统保护当前登录账号和最后一个管理员账号。
- 候选人手机号去重：同一项目内手机号唯一，编辑时排除自身。
- 身份证信息：后台和 H5 均采集身份证号码，前端/后端双重校验手机号和 18 位身份证号格式。
- 必填规则：候选人简历录入字段全部必填，包含邮箱、地点、婚姻/子女、上一份工作离职原因和至少一段完整工作经历。
- Excel 模板字段：简历录入已补充招聘渠道、应聘岗位、可到岗时间、毕业院校、专业、普通话等级、毕业时间、电话客服类行业经验和上一份工作的离职原因。
- Excel 导入：`scripts/import_resume_xlsx.py` 可按手机号去重导入 Excel 数据，当前已将用户提供的 `简历.xlsx` 导入默认项目。
- 简历扩展字段：支持当前居住地、期望工作地点的省份/地市两级下拉，婚姻状况（已婚/未婚）、子女情况（有/无）。
- 候选人编辑审计：创建、编辑、状态标记均记录前后 JSON 快照。
- 状态约束：未到面候选人标记通过时，前端弹出二次确认，后端也用 `confirmRequired` 强制校验。
- 自动统计：新增、到面、通过、入职、离职均根据候选人状态时间自动计算，无需 HR 每日录入。
- 月度人力：当前在岗按项目内“已入职”员工实时统计；剩余缺口 = 目标总人数 - 当前在岗。HR 仅需按月确认目标总人数。
- 日报管理：默认北京时间 19:00 自动生成当天的全项目及单项目锁定快照和 PDF；管理员可修改时间、配置企业微信群机器人并补生成缺失日期，已存在快照不可覆盖。
- 招聘统计：支持全部项目或单项目筛选，实时计算通过率和目标完成率；提供当月每日入职人数曲线、分布图和按项目统计表。
- 下载：候选人 PDF 与页面预览使用一致的字段结构和视觉层级，嵌入中文字体，支持长文本换行、工作经历分页和保密水印；累计/日报 Excel 均由后端生成。

## 目录

```text
backend/server.js       后端 API、鉴权、报表、导出、定时任务
backend/pdf_generator.py 标准简历 PDF 排版与字体嵌入
frontend/index.html     后台管理入口
frontend/h5.html        候选人移动端 H5
frontend/app.js         后台页面逻辑
frontend/styles.css     页面样式
data/db.json            首次启动自动生成
docs/database.md        数据库设计
docs/api.md             接口定义
```

## 生产化建议

第一阶段生产化配置、MySQL导入和Docker预发布步骤见 `docs/production-phase-1.md`。生产环境会拒绝使用 JSON 数据库、缺少 Redis、弱 JWT 密钥或非 HTTPS 的公开地址。

## CircleCI 自动化测试

仓库使用 `.circleci/config.yml` 和 CircleCI 官方 `circleci/node` Orb。每次推送和 Pull Request 会执行：

- JavaScript 语法检查及 Node 单元/安全测试。
- MySQL 8 + Redis 集成测试，覆盖登录、项目配置、候选人状态、招聘统计、日报快照、PDF 和 Excel。
- 生产 Docker 镜像构建、ReportLab 运行时和日报 PDF 烟雾测试。

在 CircleCI 中使用 GitHub App 连接 `jeych008/hr-system` 后即可运行，不需要配置生产数据库或 Webhook 密钥。CI 使用隔离的临时账号和数据库，不会访问生产数据。首次连接后，在 CircleCI 项目页面确认默认分支为 `main`，随后推送 `.circleci/config.yml` 即会触发流水线。
