#!/usr/bin/env node
const assert = require("node:assert/strict");

const baseUrl = String(process.env.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const adminPassword = process.env.ADMIN_PASSWORD || "";

if (!adminPassword) {
  console.error("ADMIN_PASSWORD is required");
  process.exit(1);
}

function passed(name, detail = "") {
  console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const healthResponse = await request("/health/ready");
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).status, "ready");
  passed("服务健康检查");

  const homeResponse = await request("/");
  assert.equal(homeResponse.status, 200);
  assert.equal(homeResponse.headers.get("x-content-type-options"), "nosniff");
  assert.ok(homeResponse.headers.get("content-security-policy"));
  passed("安全响应头");

  const unauthorizedResponse = await request("/api/projects");
  assert.equal(unauthorizedResponse.status, 401);
  passed("未授权访问拦截");

  const captcha = await json(await request("/api/auth/captcha", { method: "POST", body: "{}" }));
  const svg = Buffer.from(captcha.image.split(",")[1], "base64").toString("utf8");
  const operands = svg.match(/(\d+) \+ (\d+)/);
  assert.ok(operands, "Unable to parse the test captcha");

  const login = await json(await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "admin",
      password: adminPassword,
      captchaId: captcha.captchaId,
      captcha: String(Number(operands[1]) + Number(operands[2]))
    })
  }));
  assert.equal(login.user.username, "admin");
  assert.equal(login.user.role, "ADMIN");
  passed("管理员登录");

  const headers = { authorization: `Bearer ${login.token}` };
  const users = await json(await request("/api/users", { headers }));
  assert.equal(users.items.length, 1);
  assert.equal(users.items[0].username, "admin");
  passed("账号清理", "仅保留 admin");

  const projects = await json(await request("/api/projects", { headers }));
  assert.equal(projects.items.length, 4);
  passed("项目迁移", "4 个项目");

  for (const project of projects.items) {
    for (const group of ["candidates", "onboard", "left", "abandoned"]) {
      const result = await json(await request(`/api/candidates?projectId=${encodeURIComponent(project.id)}&group=${group}`, { headers }));
      assert.equal(result.items.length, 0, `${project.name}/${group} should be empty`);
    }
  }
  passed("简历数据清理", "候选人、在职、离职、放弃入职均为 0");

  const report = await json(await request("/api/reports/cumulative", { headers }));
  for (const key of ["candidateCount", "arrivedCount", "passedCount", "joinedCount", "leftCount", "onboardCount"]) {
    assert.equal(report.metrics[key], 0, `${key} should be zero`);
  }
  assert.equal(report.byProject.length, 4);
  passed("招聘统计", "全局与按项目统计正常");

  const exportResponse = await request("/api/export/report.xlsx?kind=cumulative", { headers });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-type") || "", /spreadsheetml/);
  const exportBuffer = Buffer.from(await exportResponse.arrayBuffer());
  assert.equal(exportBuffer.subarray(0, 2).toString("ascii"), "PK");
  passed("Excel 导出", `${exportBuffer.length} bytes`);

  console.log("\nLocal staging verification passed.");
}

main().catch(error => {
  console.error(`\nVerification failed: ${error.message}`);
  process.exit(1);
});
