const fs = require("fs");
const path = require("path");

const SCHEMA_FILE = path.join(__dirname, "mysql-schema.sql");
const SCHEMA_VERSION = 2;
const COUNT_TABLES = new Set([
  "users", "projects", "monthly_configs", "candidates", "daily_reports",
  "audit_logs", "violation_logs", "system_messages", "system_settings"
]);

function mysqlOptions(config) {
  const url = new URL(config.mysqlUrl);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL must start with mysql://");
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    waitForConnections: true,
    connectionLimit: config.mysqlPoolSize,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    multipleStatements: true,
    ...(config.mysqlSsl ? { ssl: { rejectUnauthorized: true } } : {})
  };
}

function payload(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  return typeof value === "string" ? JSON.parse(value) : value;
}

function mysqlDate(value, fallback = "1970-01-01T00:00:00.000Z") {
  const date = new Date(value || fallback);
  if (Number.isNaN(date.getTime())) return "1970-01-01 00:00:00.000";
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function nullableDate(value) {
  return value ? mysqlDate(value) : null;
}

function createMysqlStore(config) {
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool(mysqlOptions(config));

  async function init(options = {}) {
    if (options.migrate || config.mysqlAutoMigrate) {
      const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
      await pool.query(schema);
    } else {
      const [[metadata]] = await pool.query("SELECT schema_version FROM app_metadata WHERE id = 1");
      if (Number(metadata?.schema_version) !== SCHEMA_VERSION) throw new Error("Unsupported or missing MySQL schema; run the migration command first");
    }
  }

  async function tablePayloads(table, order = "") {
    const [rows] = await pool.query(`SELECT payload FROM ${table}${order ? ` ORDER BY ${order}` : ""}`);
    return rows.map(row => payload(row.payload));
  }

  async function read() {
    const [[meta], users, projects, monthlyConfigs, candidates, dailyReports, auditLogs, violationLogs, systemMessages, settings] = await Promise.all([
      pool.query("SELECT data_version FROM app_metadata WHERE id = 1").then(([rows]) => rows),
      tablePayloads("users", "username"),
      tablePayloads("projects", "id"),
      tablePayloads("monthly_configs", "config_month, project_id"),
      tablePayloads("candidates", "created_at"),
      tablePayloads("daily_reports", "report_date"),
      tablePayloads("audit_logs", "created_at DESC"),
      tablePayloads("violation_logs", "created_at DESC"),
      tablePayloads("system_messages", "created_at DESC"),
      tablePayloads("system_settings", "setting_key")
    ]);
    const systemSettings = settings.find(item => item?.id === "report_delivery") || null;
    const db = { users, projects, monthlyConfigs, candidates, dailyReports, auditLogs, violationLogs, systemMessages, systemSettings, captchas: [] };
    Object.defineProperty(db, "__storageVersion", { value: Number(meta?.data_version || 0), writable: true, enumerable: false });
    return db;
  }

  async function insertBatches(connection, sqlPrefix, rows, rowWidth, batchSize = 200) {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => `(${Array(rowWidth).fill("?").join(",")})`).join(",");
      await connection.query(`${sqlPrefix} VALUES ${placeholders}`, batch.flat());
    }
  }

  async function replace(connection, table, sqlPrefix, rows, rowWidth) {
    await connection.query(`DELETE FROM ${table}`);
    if (rows.length) await insertBatches(connection, sqlPrefix, rows, rowWidth);
  }

  async function append(connection, sqlPrefix, rows, rowWidth) {
    if (rows.length) await insertBatches(connection, sqlPrefix, rows, rowWidth);
  }

  async function write(db, options = {}) {
    const connection = await pool.getConnection();
    let namedLock = false;
    try {
      const [[lock]] = await connection.query("SELECT GET_LOCK('hr_resume_store_write', 15) AS acquired");
      namedLock = Number(lock.acquired) === 1;
      if (!namedLock) throw new Error("Timed out waiting for database write lock");
      await connection.beginTransaction();
      const [[meta]] = await connection.query("SELECT data_version FROM app_metadata WHERE id = 1 FOR UPDATE");
      const currentVersion = Number(meta.data_version || 0);
      if (db.__storageVersion !== undefined && Number(db.__storageVersion) !== currentVersion) {
        const conflict = new Error("Data changed concurrently; reload and retry");
        conflict.code = "STORE_CONFLICT";
        throw conflict;
      }

      await replace(connection, "users", "INSERT INTO users (id,username,role,enabled,payload)",
        (db.users || []).map(item => [item.id, item.username, item.role, item.enabled !== false ? 1 : 0, JSON.stringify(item)]), 5);
      await replace(connection, "projects", "INSERT INTO projects (id,short_code,enabled,payload)",
        (db.projects || []).map(item => [item.id, item.shortCode, item.enabled !== false ? 1 : 0, JSON.stringify(item)]), 4);
      await replace(connection, "monthly_configs", "INSERT INTO monthly_configs (id,project_id,config_month,target_hc,payload)",
        (db.monthlyConfigs || []).map(item => [item.id, item.projectId, item.month, Number(item.targetHc || 0), JSON.stringify(item)]), 5);
      await replace(connection, "candidates", "INSERT INTO candidates (id,project_id,phone,employment_status,created_at,updated_at,arrived_at,passed_at,joined_at,left_at,payload)",
        (db.candidates || []).map(item => [item.id, item.projectId, item.phone, item.employmentStatus || "CANDIDATE", mysqlDate(item.createdAt), mysqlDate(item.updatedAt || item.createdAt), nullableDate(item.arrivedAt), nullableDate(item.passedAt), nullableDate(item.joinedAt), nullableDate(item.leftAt), JSON.stringify(item)]), 11);
      await replace(connection, "system_messages", "INSERT INTO system_messages (id,user_id,project_id,message_type,created_at,read_at,payload)",
        (db.systemMessages || []).map(item => [item.id, item.userId || null, item.projectId || null, item.type || "SYSTEM", mysqlDate(item.createdAt), nullableDate(item.readAt), JSON.stringify(item)]), 7);
      await replace(connection, "system_settings", "INSERT INTO system_settings (setting_key,payload)",
        db.systemSettings ? [["report_delivery", JSON.stringify(db.systemSettings)]] : [], 2);

      const writeHistory = (table, sqlPrefix, rows, rowWidth) => options.replaceHistory === true
        ? replace(connection, table, sqlPrefix, rows, rowWidth)
        : append(connection, sqlPrefix, rows, rowWidth);
      await writeHistory("daily_reports", "INSERT IGNORE INTO daily_reports (id,project_id,report_date,locked,generated_at,payload)",
        (db.dailyReports || []).map(item => [item.id, item.projectId, item.date, 1, mysqlDate(item.generatedAt), JSON.stringify(item)]), 6);
      await writeHistory("audit_logs", "INSERT IGNORE INTO audit_logs (id,actor_id,entity_type,entity_id,action,created_at,payload)",
        (db.auditLogs || []).map(item => [item.id, item.actorId || null, item.entityType || "CANDIDATE", item.entityId || "", item.action || "UNKNOWN", mysqlDate(item.createdAt), JSON.stringify(item)]), 7);
      await writeHistory("violation_logs", "INSERT IGNORE INTO violation_logs (id,project_id,created_at,payload)",
        (db.violationLogs || []).map(item => [item.id, item.projectId || null, mysqlDate(item.createdAt), JSON.stringify(item)]), 4);

      for (const [table, expected] of Object.entries(options.expectedCounts || {})) {
        if (!COUNT_TABLES.has(table) || !Number.isSafeInteger(expected) || expected < 0) {
          throw new Error(`Invalid expected row count for ${table}`);
        }
        const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM ${table}`);
        if (Number(row.count) !== expected) {
          throw new Error(`Row count verification failed for ${table}: ${row.count}, expected ${expected}`);
        }
      }

      await connection.query("UPDATE app_metadata SET data_version = data_version + 1, schema_version = ? WHERE id = 1", [SCHEMA_VERSION]);
      await connection.commit();
      db.__storageVersion = currentVersion + 1;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      if (namedLock) await connection.query("SELECT RELEASE_LOCK('hr_resume_store_write')").catch(() => {});
      connection.release();
    }
  }

  async function counts() {
    const names = [...COUNT_TABLES];
    const values = await Promise.all(names.map(async name => {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${name}`);
      return [name, Number(row.count)];
    }));
    return Object.fromEntries(values);
  }

  async function clear() {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const table of ["system_settings", "system_messages", "violation_logs", "audit_logs", "daily_reports", "candidates", "monthly_configs", "projects", "users"]) {
        await connection.query(`DELETE FROM ${table}`);
      }
      await connection.query("UPDATE app_metadata SET data_version = data_version + 1 WHERE id = 1");
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function close() {
    await pool.end();
  }

  return { init, read, write, counts, clear, close };
}

module.exports = { createMysqlStore };
