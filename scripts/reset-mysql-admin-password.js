#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

const rootDir = path.resolve(__dirname, "..");
const sourceFile = path.join(rootDir, "data", "db.json");
const password = process.env.ADMIN_NEW_PASSWORD || "";
const mysqlUrl = process.env.MYSQL_URL || "";
const rounds = Number(process.env.BCRYPT_ROUNDS || 12);

if (password.length < 10) throw new Error("管理员密码至少需要 10 个字符");
if (!mysqlUrl) throw new Error("MYSQL_URL is required");
if (!Number.isInteger(rounds) || rounds < 10 || rounds > 14) throw new Error("BCRYPT_ROUNDS must be between 10 and 14");

function connectionOptions(value) {
  const url = new URL(value);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL must use mysql://");
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    charset: "utf8mb4"
  };
}

function parsePayload(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function main() {
  const hash = bcrypt.hashSync(password, rounds);
  const connection = await mysql.createConnection(connectionOptions(mysqlUrl));
  let updatedUser;

  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT id, payload FROM users WHERE username = ? FOR UPDATE", ["admin"]);
    if (rows.length !== 1) throw new Error(`Expected one admin account in MySQL, found ${rows.length}`);

    updatedUser = parsePayload(rows[0].payload);
    if (updatedUser.role !== "ADMIN" || updatedUser.enabled === false) {
      throw new Error("MySQL admin account is disabled or has an invalid role");
    }
    updatedUser.passwordHash = hash;
    updatedUser.authVersion = Number(updatedUser.authVersion || 0) + 1;

    await connection.query("UPDATE users SET payload = ? WHERE id = ?", [JSON.stringify(updatedUser), rows[0].id]);
    await connection.query("UPDATE app_metadata SET data_version = data_version + 1 WHERE id = 1");
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    await connection.end();
  }

  const db = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const sourceAdmin = db.users.find(user => user.username === "admin");
  if (!sourceAdmin) throw new Error("The sanitized JSON source has no admin account");
  sourceAdmin.passwordHash = hash;
  sourceAdmin.authVersion = updatedUser.authVersion;

  const temporaryFile = `${sourceFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, sourceFile);
  fs.chmodSync(sourceFile, 0o600);

  console.log("Admin password hash updated in MySQL and the sanitized JSON source.");
  console.log("Existing admin JWTs were invalidated.");
}

main().catch(error => {
  console.error(`Admin password reset failed: ${error.message}`);
  process.exit(1);
});
