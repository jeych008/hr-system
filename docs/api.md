# 接口定义

统一前缀：`/api`。除公开 H5 接口和验证码/登录外，均需 `Authorization: Bearer <JWT>`。

## 认证

`POST /auth/captcha`

返回图形验证码：

```json
{ "captchaId": "cap_xxx", "image": "data:image/svg+xml;base64,..." }
```

`POST /auth/login`

```json
{ "username": "assigned-user", "password": "assigned-password", "captchaId": "cap_xxx", "captcha": "12" }
```

返回 JWT 与用户信息。

系统角色：

- `ADMIN`：超级管理员，拥有全部数据与后台配置权限。
- `HR`：HR 账号，仅能访问被分配项目，并可录入候选人、维护候选人状态和月度目标人数。
- `OPS`：运营账号，可只读查看全部项目候选人、日报、招聘统计和导出数据，无账号管理、项目配置或候选人写入权限。

## 项目

- `GET /projects`：按权限返回项目。
- `POST /projects`：管理员创建项目，只需填写项目名称；服务端自动生成唯一 `shortCode`。
- `PUT /projects/{projectId}`：管理员编辑项目名称、启用/停用状态。
- `DELETE /projects/{projectId}`：管理员删除/停用项目。为保证历史候选人、日报和报表可追溯，接口采用软停用，项目链接将不能继续提交。
- `GET /projects/{projectId}/month-config?month=2026-07`：读取月度配置。
- `POST /projects/{projectId}/month-config`：保存指定月份的目标总人数，月份格式为 `yyyy-MM`。
- `GET /public/projects/{projectId或shortCode}`：H5 公开读取项目名称。

候选人独立填写链接格式：

```text
/h5.html?code=<项目shortCode>
```

## 候选人

- `GET /candidates?projectId=&keyword=`：候选人列表，手机号、身份证号和邮箱脱敏。`ADMIN` 和 `OPS` 可不传 `projectId` 查看全部项目。
- `POST /candidates`：HR 后台代填，简历字段全部必填，校验手机号、邮箱和18位身份证号格式。
- `GET /candidates/{id}`：详情，返回完整手机号、身份证号、邮箱。
- `PUT /candidates/{id}`：编辑，项目和来源不可改。
- `POST /candidates/{id}/status`：标记到面或通过。
- `POST /public/projects/{projectId}/candidates`：候选人自助提交，需验证码。

简历录入字段全部必填，包含基础信息、当前居住地、期望工作地点、上一份工作离职原因，以及至少一段完整工作经历；不再接受附件上传。

候选人创建/编辑字段包含：

```json
{
  "name": "张三",
  "gender": "男",
  "birthDate": "1998-01-01",
  "education": "本科",
  "phone": "13800001234",
  "idCard": "110101199805120017",
  "email": "zhangsan@example.com",
  "recruitmentChannel": "BOSS直聘",
  "appliedPosition": "客服",
  "availableDate": "2026-07-23",
  "graduationSchool": "某某大学",
  "major": "电子商务",
  "mandarinLevel": "二甲",
  "graduationTime": "2024年10月",
  "phoneCustomerServiceExperience": true,
  "currentResidenceProvince": "上海市",
  "currentResidenceCity": "上海市",
  "currentResidence": "上海市 上海市",
  "maritalStatus": "未婚",
  "childrenStatus": "无",
  "expectedProvince": "浙江省",
  "expectedCity": "杭州市",
  "expectedLocation": "浙江省 杭州市",
  "lastLeaveReason": "个人发展",
  "workExperiences": [
    {
      "companyName": "某公司",
      "position": "客服专员",
      "startDate": "2022-01",
      "endDate": "2025-01",
      "description": "负责客户咨询、工单处理和服务质量跟进。"
    }
  ]
}
```

状态标记请求：

```json
{ "type": "passed", "force": false }
```

若未到面直接通过，后端返回 `409`：

```json
{ "error": "该候选人尚未标记到面，确认通过吗？", "confirmRequired": true }
```

## 报表

- `GET /reports/daily?projectId=&date=`：读取 19:00 固化日报快照，不存在则返回 404。
- `GET /reports/cumulative?projectId=&from=&to=&month=2026-07`：实时招聘统计。所有指标根据候选人的创建、到面、通过、入职和离职时间自动计算；返回 `dailyJoinTrend` 作为指定月份每日入职人数曲线数据，并返回 `byProject` 按项目统计。
- `GET /export/report.xlsx?kind=cumulative&projectId=&from=&to=`：导出累计报表。
- `GET /export/report.xlsx?kind=daily&projectId=&date=`：导出日报。

报表导出的分布数据包含类别、数量和占比，并包含按项目统计表；累计报表页面中性别分布、电话客服经验分布以环状饼图呈现。

## 简历 PDF

`GET /export/candidates.pdf?ids=id1,id2`

返回单个或批量简历 PDF。PDF 包含页眉、头像占位、基础信息表格、地点与求职信息、工作经历块和“内部保密资料”水印。前端下载使用 `Authorization` 请求头获取文件 Blob，避免把 JWT 暴露在 URL、浏览器历史或访问日志中；后端仍保留查询参数鉴权兼容旧链接。

## 用户与日志

- `GET /users`：管理员查看账号。
- `POST /users`：管理员创建 HR 或运营账号。用户名、姓名、密码必填；HR 必须分配至少一个负责项目，运营账号无需分配项目且默认只读查看全部项目数据；用户名需为3-32位字母、数字或下划线，密码至少6位。
- `PUT /users/{id}`：管理员编辑、启用/禁用账号、修改密码、分配项目。账号管理前端以复选框选择项目，项目配置页也可按项目反向指定负责 HR。修改密码时传 `{ "password": "newpass123" }`，密码至少6位。
- `DELETE /users/{id}`：管理员删除账号。不能删除当前登录账号，且至少保留一个管理员。
- `GET /logs`：管理员查看审计日志和违规日志。

## Excel 导入

仓库内提供脚本：

```bash
python3 scripts/import_resume_xlsx.py /path/to/简历.xlsx p_service_center
```

脚本按 Excel 表头映射候选人字段，并按项目内手机号去重。Excel 中没有邮箱时，会生成 `手机号@import.local` 的占位邮箱。
