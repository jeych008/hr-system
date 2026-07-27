# 数据库设计

演示版使用 `data/db.json` 持久化；生产版推荐 MySQL 8。以下为建议表结构。

## users

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 用户 ID |
| username | varchar(64) unique | 登录名 |
| display_name | varchar(64) | 显示名 |
| password_hash | varchar(255) | BCrypt 密码哈希 |
| role | enum('ADMIN','HR','OPS') | 角色。OPS 为运营账号，可只读查看全部招聘数据和统计 |
| enabled | tinyint | 是否启用 |
| created_at / updated_at | datetime | 时间 |

## projects

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 项目 ID |
| name | varchar(128) | 项目名称 |
| short_code | varchar(64) unique | H5 短链码 |
| enabled | tinyint | 是否启用 |
| created_at / updated_at | datetime | 时间 |

## user_projects

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| user_id | varchar(32) | HR 用户 |
| project_id | varchar(32) | 项目 |

联合唯一索引：`uk_user_project(user_id, project_id)`。

## project_monthly_configs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 配置 ID |
| project_id | varchar(32) | 项目 |
| month | char(7) | `YYYY-MM` |
| target_hc | int | 目标总人数 |
| updated_by | varchar(32) | 操作人 |
| updated_at | datetime | 更新时间 |

联合唯一索引：`uk_project_month(project_id, month)`。

## candidates

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 候选人 ID |
| project_id | varchar(32) | 所属项目 |
| source | enum('SELF','HR') | 来源 |
| created_by | varchar(32) null | 录入人 |
| name | varchar(64) | 姓名 |
| gender | varchar(16) | 性别 |
| birth_date | date | 出生日期 |
| education | enum('初中及以下','高中','中专或技校','大专','本科','研究生','博士') | 学历 |
| phone | varchar(20) | 手机号 |
| id_card | char(18) | 18 位身份证号码 |
| email | varchar(128) | 邮箱 |
| recruitment_channel | varchar(128) | 获知招聘信息渠道。固定项：BOSS直聘、58同城、本地招聘网、现场招聘会、社区推荐；亲友介绍和其他需带具体补充信息 |
| applied_position | varchar(128) | 应聘岗位 |
| available_date | varchar(32) | 可到岗时间 |
| graduation_school | varchar(128) | 毕业院校 |
| major | varchar(128) | 所学专业 |
| mandarin_level | enum('未评级','一甲','一乙','二甲','二乙','三甲','三乙') | 普通话水平等级 |
| graduation_time | varchar(64) | 毕业时间 |
| phone_customer_service_experience | tinyint | 是否有电话客服类行业经验 |
| current_residence_province | varchar(64) | 当前居住省份 |
| current_residence_city | varchar(64) | 当前居住地市 |
| current_residence | varchar(128) | 当前居住地，具体到地市 |
| marital_status | enum('已婚','未婚') | 婚姻状况 |
| children_status | enum('有','无') | 子女情况 |
| expected_province | varchar(64) | 期望工作省份 |
| expected_city | varchar(64) | 期望工作地市 |
| expected_location | varchar(128) | 期望地点 |
| last_leave_reason | text | 离职原因 |
| arrived / passed | tinyint | 到面/通过标记 |
| arrived_at / passed_at | datetime null | 标记时间 |
| arrived_by / passed_by | varchar(32) null | 操作人 |
| created_at / updated_at | datetime | 时间 |

联合唯一索引：`uk_project_phone(project_id, phone)`。查询索引：`idx_project_created(project_id, created_at)`、`idx_arrived_at(arrived_at)`、`idx_passed_at(passed_at)`。列表接口需对身份证号、手机号、邮箱脱敏。

## work_experiences

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 经历 ID |
| candidate_id | varchar(32) | 候选人 |
| company_name | varchar(128) | 公司 |
| position | varchar(128) | 职位 |
| start_date | char(7) | 开始月份 |
| end_date | char(7) | 结束月份 |
| description | text | 描述 |

## operation_data

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 记录 ID |
| project_id | varchar(32) | 项目 |
| date | date | 业务日期 |
| new_candidate_count | int | 今日新增 |
| arrived_count | int | 今日到面 |
| passed_count | int | 今日通过 |
| joined_count | int | 今日入职 |
| left_count | int | 今日离职 |
| ending_onboard_count | int | 下班后在岗 |
| submitted_by | varchar(32) | 提交人 |
| submitted_at | datetime | 提交时间 |

联合唯一索引：`uk_project_date(project_id, date)`。

## daily_reports

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | varchar(32) PK | 快照 ID |
| project_id | varchar(32) | 项目 |
| date | date | 快照日期 |
| metrics_json | json | 指标快照 |
| distributions_json | json | 图表数据快照 |
| locked | tinyint | 永久锁定 |
| generated_at | datetime | 生成时间 |

联合唯一索引：`uk_daily_report(project_id, date)`。生产版可加触发器禁止 `UPDATE/DELETE`。

## audit_logs / violation_logs

操作日志保留候选人创建、编辑、状态标记的前后快照；违规日志记录 18:30 后未提交或补交情况。建议按月分区或归档，保留至少 6 个月。
