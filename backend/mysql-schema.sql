CREATE TABLE IF NOT EXISTS app_metadata (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  schema_version INT UNSIGNED NOT NULL,
  data_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

INSERT IGNORE INTO app_metadata (id, schema_version, data_version) VALUES (1, 1, 0);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  role ENUM('ADMIN', 'HR', 'OPS') NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  payload JSON NOT NULL,
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_role_enabled (role, enabled)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  short_code VARCHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  payload JSON NOT NULL,
  UNIQUE KEY uk_projects_short_code (short_code),
  KEY idx_projects_enabled (enabled)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS monthly_configs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  config_month CHAR(7) NOT NULL,
  target_hc INT UNSIGNED NOT NULL DEFAULT 0,
  payload JSON NOT NULL,
  UNIQUE KEY uk_monthly_project_month (project_id, config_month),
  KEY idx_monthly_month (config_month)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS candidates (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  employment_status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  arrived_at DATETIME(3) NULL,
  passed_at DATETIME(3) NULL,
  joined_at DATETIME(3) NULL,
  left_at DATETIME(3) NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uk_candidates_project_phone (project_id, phone),
  KEY idx_candidates_project_created (project_id, created_at),
  KEY idx_candidates_project_status (project_id, employment_status),
  KEY idx_candidates_arrived_at (arrived_at),
  KEY idx_candidates_passed_at (passed_at),
  KEY idx_candidates_joined_at (joined_at),
  KEY idx_candidates_left_at (left_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS daily_reports (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  report_date DATE NOT NULL,
  locked TINYINT(1) NOT NULL DEFAULT 1,
  generated_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uk_daily_project_date (project_id, report_date),
  CONSTRAINT chk_daily_locked CHECK (locked = 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(64) NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY idx_audit_entity (entity_type, entity_id, created_at),
  KEY idx_audit_actor_created (actor_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS violation_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  project_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY idx_violation_project_created (project_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_messages (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NULL,
  project_id VARCHAR(64) NULL,
  message_type VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  read_at DATETIME(3) NULL,
  payload JSON NOT NULL,
  KEY idx_messages_user_read (user_id, read_at, created_at),
  KEY idx_messages_project_created (project_id, created_at)
) ENGINE=InnoDB;
