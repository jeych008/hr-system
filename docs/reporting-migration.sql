CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(64) NOT NULL PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;

UPDATE app_metadata SET schema_version = 2 WHERE id = 1;
