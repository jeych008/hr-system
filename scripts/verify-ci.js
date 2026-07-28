#!/usr/bin/env node
const assert = require("node:assert/strict");

const baseUrl = String(process.env.BASE_URL || "http://127.0.0.1:5177").replace(/\/$/, "");
const adminPassword = String(process.env.CI_ADMIN_PASSWORD || "");

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
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

async function waitForReady() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await request("/health/ready");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Application did not become ready");
}

function chinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function assertPdf(response, name) {
  assert.equal(response.status, 200, `${name} status`);
  assert.match(response.headers.get("content-type") || "", /application\/pdf/);
  const file = Buffer.from(await response.arrayBuffer());
  assert.equal(file.subarray(0, 5).toString("ascii"), "%PDF-");
}

async function main() {
  await waitForReady();
  assert.equal((await request("/api/projects")).status, 401);

  const captcha = await json(await request("/api/auth/captcha", { method: "POST", body: "{}" }));
  const svg = Buffer.from(captcha.image.split(",")[1], "base64").toString("utf8");
  const operands = svg.match(/(\d+) \+ (\d+)/);
  assert.ok(operands);
  const login = await json(await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: "admin",
      password: adminPassword,
      captchaId: captcha.captchaId,
      captcha: String(Number(operands[1]) + Number(operands[2]))
    })
  }));
  const headers = { authorization: `Bearer ${login.token}` };

  const settings = await json(await request("/api/settings/report-delivery", { headers }));
  assert.equal(settings.sendTime, "19:00");
  const updatedSettings = await json(await request("/api/settings/report-delivery", {
    method: "PUT", headers, body: JSON.stringify({ sendTime: "18:30", deliveryEnabled: false })
  }));
  assert.equal(updatedSettings.sendTime, "18:30");

  const project = await json(await request("/api/projects", {
    method: "POST", headers, body: JSON.stringify({ name: "CircleCI 招聘项目" })
  }));
  const date = chinaDate();
  await json(await request(`/api/projects/${project.id}/month-config`, {
    method: "POST", headers, body: JSON.stringify({ month: date.slice(0, 7), targetHc: 3 })
  }));

  const candidate = await json(await request("/api/candidates", {
    method: "POST", headers, body: JSON.stringify({
      projectId: project.id,
      name: "自动化测试候选人",
      gender: "女",
      education: "本科",
      phone: "13800138000",
      idCard: "11010519491231002X",
      email: "ci-candidate@example.com",
      recruitmentChannel: "BOSS直聘",
      appliedPosition: "客服专员",
      availableDate: date,
      graduationSchool: "测试大学",
      major: "测试专业",
      mandarinLevel: "二甲",
      graduationTime: "1970-07-01",
      phoneCustomerServiceExperience: true,
      currentResidenceProvince: "浙江省",
      currentResidenceCity: "杭州市",
      maritalStatus: "未婚",
      childrenStatus: "无",
      expectedProvince: "浙江省",
      expectedCity: "杭州市",
      lastLeaveReason: "职业发展",
      workExperiences: [{
        companyName: "测试公司", position: "客服", startDate: "2020-01-01", endDate: "2024-01-01", description: "处理客户咨询"
      }]
    })
  }));
  await json(await request(`/api/candidates/${candidate.id}/status`, {
    method: "POST", headers, body: JSON.stringify({ type: "arrived" })
  }));
  await json(await request(`/api/candidates/${candidate.id}/status`, {
    method: "POST", headers, body: JSON.stringify({ type: "passed", plannedJoinDate: date })
  }));
  await json(await request(`/api/candidates/${candidate.id}/status`, {
    method: "POST", headers, body: JSON.stringify({ type: "onboard" })
  }));

  const report = await json(await request(`/api/reports/cumulative?projectId=${project.id}`, { headers }));
  assert.equal(report.metrics.candidateCount, 1);
  assert.equal(report.metrics.joinedCount, 1);
  assert.equal(report.metrics.onboardCount, 1);

  const generated = await json(await request("/api/reports/daily/generate", {
    method: "POST", headers, body: JSON.stringify({ date, projectId: project.id })
  }));
  assert.equal(generated.createdCount, 1);
  const dates = await json(await request(`/api/reports/daily/dates?projectId=${project.id}&month=${date.slice(0, 7)}`, { headers }));
  assert.deepEqual(dates.dates, [date]);

  await assertPdf(await request(`/api/export/candidates.pdf?ids=${candidate.id}`, { headers }), "Candidate PDF");
  await assertPdf(await request(`/api/reports/daily.pdf?projectId=${project.id}&date=${date}`, { headers }), "Daily report PDF");
  const excel = await request(`/api/export/report.xlsx?kind=daily&projectId=${project.id}&date=${date}`, { headers });
  assert.equal(excel.status, 200);
  const excelFile = Buffer.from(await excel.arrayBuffer());
  assert.equal(excelFile.subarray(0, 2).toString("ascii"), "PK");

  console.log("CircleCI integration verification passed");
}

main().catch(error => {
  console.error(`CircleCI integration verification failed: ${error.message}`);
  process.exit(1);
});
