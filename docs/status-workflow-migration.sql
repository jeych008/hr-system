-- 候选人/在职/离职一体化状态流转字段
-- SQLite 可直接执行；MySQL 可将 DATETIME 文本字段保持为 DATETIME 类型。

ALTER TABLE candidates ADD COLUMN employment_status VARCHAR(20) NOT NULL DEFAULT 'CANDIDATE';
ALTER TABLE candidates ADD COLUMN planned_join_date DATE NULL;
ALTER TABLE candidates ADD COLUMN planned_join_set_at DATETIME NULL;
ALTER TABLE candidates ADD COLUMN planned_join_set_by VARCHAR(64) NULL;
ALTER TABLE candidates ADD COLUMN failed_at DATETIME NULL;
ALTER TABLE candidates ADD COLUMN failed_by VARCHAR(64) NULL;
ALTER TABLE candidates ADD COLUMN failed_reason VARCHAR(200) NULL;
ALTER TABLE candidates ADD COLUMN joined_at DATETIME NULL;
ALTER TABLE candidates ADD COLUMN joined_by VARCHAR(64) NULL;
ALTER TABLE candidates ADD COLUMN left_at DATETIME NULL;
ALTER TABLE candidates ADD COLUMN left_by VARCHAR(64) NULL;
ALTER TABLE candidates ADD COLUMN left_reason VARCHAR(200) NULL;
ALTER TABLE candidates ADD COLUMN abandon_at DATETIME NULL;
ALTER TABLE candidates ADD COLUMN abandon_by VARCHAR(64) NULL;
ALTER TABLE candidates ADD COLUMN abandon_reason VARCHAR(200) NULL;
ALTER TABLE candidates ADD COLUMN last_reminder_date DATE NULL;

CREATE TABLE system_messages (
  id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(40) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NULL,
  message_date DATE NOT NULL,
  message VARCHAR(500) NOT NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL
);

CREATE INDEX idx_candidates_project_employment_status ON candidates(project_id, employment_status);
CREATE INDEX idx_candidates_planned_join_date ON candidates(planned_join_date);
CREATE INDEX idx_candidates_failed_at ON candidates(failed_at);
CREATE INDEX idx_system_messages_user_date ON system_messages(user_id, message_date);
CREATE INDEX idx_system_messages_candidate_type_date ON system_messages(candidate_id, type, message_date);
