# 安全测试报告

## 2026-07-26 第一阶段整改状态

- 已移除登录页、README和启动日志中的默认账号提示；新建数据库不再自动创建默认弱口令账号。
- 现有开发数据库账号不会被自动删除，正式迁移命令要求显式确认所有账号已经完成改密。
- 已移除URL查询参数JWT，只接受 `Authorization: Bearer`。
- 前端令牌从 `localStorage` 改为当前标签会话的 `sessionStorage`；HttpOnly Cookie迁移列入下一阶段。
- 新密码使用BCrypt，旧scrypt密码在安装BCrypt依赖后首次成功登录自动升级。
- 生产启动强制要求MySQL、Redis、HTTPS公开地址和不少于32字节的JWT密钥。
- 已增加CSP、禁止页面嵌入、权限策略、请求体限制、健康检查和优雅退出。
- `data/db.json` 仍保留在本地工作区用于迁移，没有删除候选人数据；Docker和Git忽略规则已排除新打包。若该文件曾被Git跟踪，还需从版本索引和历史分发包中移除。正式环境仍必须执行加密备份、账号改密和受控迁移。

测试日期：2026-07-25

扫描方式：使用 `codex-security@openai-api-curated` 标准扫描，范围为 `work/hr-resume-system`。正式扫描产物已生成在 Codex Security 工作台中，包含 `report.md`、`findings.json`、`coverage.json`、`scan-manifest.json` 和 SARIF。

## 测试范围

- 后端 API：`backend/server.js`
- 后台前端：`frontend/app.js`
- 候选人 H5：`frontend/h5.html`
- 前端校验与地区数据：`frontend/validators.js`、`frontend/locations.js`
- 本地数据：`data/db.json`
- 文档与打包物：`README.md`、`docs/api.md`、`outputs/hr-resume-system.zip`

## 已执行检查

- JavaScript 语法检查：`node --check backend/server.js`、`node --check frontend/app.js`
- 静态规则检索：默认凭据、JWT、URL token、`localStorage`、`innerHTML`、危险 API、路径解析、验证码和限流
- 认证与授权审计：登录、JWT 校验、角色权限、项目权限、OPS 只读边界
- 公开接口审计：H5 项目读取、候选人提交、验证码、手机号/身份证/邮箱校验
- 导出与静态文件审计：PDF/Excel 鉴权、项目过滤、静态路径穿越防护
- 敏感数据审计：`data/db.json` 中 PII/密码哈希统计、zip 包内容检查

## 动态复测结果

本轮在用户确认允许识别验证码后，已通过真实浏览器页面和 `curl -I -X GET` 重新补充动态验证：

| 测试项 | 结果 |
| --- | --- |
| 默认管理员登录 | 通过真实登录页填写验证码后，`admin/admin123` 登录成功，页面显示超级管理员菜单 |
| 默认 HR 登录 | `hr01/hr123456` 登录成功；项目下拉仅显示 `客服中心招聘项目`，未显示账号管理和操作日志 |
| 默认 OPS 登录 | `ops01/ops123456` 登录成功；可见候选人、累计报表、日报快照，不显示运营提交、项目配置、账号管理、操作日志 |
| 未授权候选人 API | `GET /api/candidates` 返回 `401 Unauthorized` |
| 公开项目 API | `GET /api/public/projects/service-center` 返回 `200 OK` |
| H5 项目链接 | `/h5.html?code=service-center` 正常展示 `客服中心招聘项目 简历填写`、验证码和必填字段 |
| 静态数据文件直接访问 | `GET /data/db.json` 返回 `404 Not Found` |
| 编码路径穿越探测 | `GET /..%2Fdata%2Fdb.json` 返回 `404 Not Found` |
| 响应安全头 | 静态页和 API 响应包含 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` |

限制说明：当前沙箱仍阻止 Node HTTP 客户端和普通 `curl POST` 直连本机端口，因此无法用脚本直接重放带 `Authorization` 头的 POST/GET 全套接口；带登录态的验证已改用真实浏览器 UI 完成。`?token=` JWT 风险仍由源码确认，未读取浏览器 `localStorage` 中的 token 做运行时复现。

## 发现的问题

| 严重度 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| 高 | 登录页公开默认账号，且本地默认密码仍有效 | `frontend/app.js:127-129` 显示 `admin/admin123`、`hr01/hr123456`、`ops01/ops123456`；`backend/server.js:126-128` 会创建这些默认账号；本地 hash 校验确认当前 `data/db.json` 仍匹配这些默认密码 | 移除页面、README、启动日志中的默认账号提示；首次启动使用环境变量或一次性初始化密码；生产部署前强制改密并禁用演示账号 |
| 高 | 简历数据库和导出包包含大量候选人敏感信息 | `data/db.json` 包含 1009 条手机号、身份证号、邮箱和 5 个密码哈希；`outputs/hr-resume-system.zip` 包含 `hr-resume-system/data/db.json` | 不要把真实数据放进代码仓库或分发 zip；打包排除 `data/db.json`；仅保留脱敏 seed；生产迁移到受控数据库并加密备份 |
| 中 | 后端仍接受 URL 查询参数里的 JWT | `backend/server.js:244-248` 中 `getUser` 读取 `?token=` 并当作 bearer token 使用 | 移除 `queryToken` 兼容，只允许 `Authorization: Bearer <JWT>`；如需迁移，短期记录使用量并在生产禁用 |

## 已确认较好的控制

- JWT 解析有异常捕获，签名比较使用 `crypto.timingSafeEqual`。
- 密码采用 `scrypt` 哈希，密码比较使用定时安全比较。
- 登录、验证码和公开候选人提交已有基础 IP 级内存限流。
- 验证码一次性消费，失败后不可复用同一验证码。
- 候选人后端校验包含必填、手机号、18 位身份证校验、邮箱和同项目手机号去重。
- HR 项目权限、OPS 只读权限、管理员配置权限均有后端校验。
- PDF/Excel 导出接口需要鉴权，并按项目权限过滤数据。
- 静态文件服务使用 `path.resolve` 并校验必须位于前端目录内。
- 未发现 `eval`、`child_process`、`document.cookie` 使用。
- 主要动态 `innerHTML` 模板变量已通过 `h()` 转义或使用 `textContent`。

## 生产加固建议

- 将 JWT 存储从 `localStorage` 评估迁移到 HttpOnly Cookie，或至少增加 CSP，降低 XSS 后 token 被读取的影响。
- 内存限流仅适合单进程演示，生产应使用 Redis、网关或 WAF 统一限流。
- 当前算术验证码适合演示，不适合高对抗公网环境；生产建议接入更强验证码或行为风控。
- 文件数据库不适合生产审计和并发写入，生产建议 MySQL/InnoDB、集中日志、定期备份和磁盘/备份加密。
- 为打包流程增加 PII/secret 扫描，阻止身份证号、手机号、默认密码和 `data/db.json` 进入分发包。
