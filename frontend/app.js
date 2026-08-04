const api = {
  token: sessionStorage.getItem("token") || "",
  async request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw Object.assign(new Error(err.error || "请求失败"), err);
    }
    return res.json();
  },
  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: "POST", body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: "PUT", body: JSON.stringify(body) }); }
};

const state = {
  user: null,
  projects: [],
  candidates: [],
  active: "candidates",
  candidateGroup: "candidates",
  candidateStatus: "",
  candidateKeyword: "",
  candidateProjectId: "",
  selectedIds: new Set(),
  captcha: null
};

const $ = sel => document.querySelector(sel);
const app = $("#app");
const today = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

function h(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function formatShanghaiDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function isDateOnly(value) {
  return window.isValidDateOnly(value);
}

function bindDateOnlyInputs(root = document) {
  root.querySelectorAll("[data-date-only], [data-month-only]").forEach(input => {
    input.onkeydown = e => e.preventDefault();
    input.onpaste = e => e.preventDefault();
    input.ondrop = e => e.preventDefault();
  });
}

const EDUCATION_OPTIONS = ["初中及以下", "高中", "中专或技校", "大专", "本科", "研究生", "博士"];
const MANDARIN_OPTIONS = ["未评级", "一甲", "一乙", "二甲", "二乙", "三甲", "三乙"];
const CHANNEL_OPTIONS = ["BOSS直聘", "58同城", "本地招聘网", "现场招聘会", "亲友介绍", "社区推荐", "其他"];
const CANDIDATE_GROUPS = [
  ["candidates", "候选人"],
  ["training", "培训人员"],
  ["onboard", "在职人员"],
  ["left", "离职人员"],
  ["abandoned", "放弃入职"]
];
const STATUS_LABELS = {
  PENDING: "待处理",
  ARRIVED: "已到面",
  PASSED: "已通过",
  FAILED: "未通过",
  PENDING_ONBOARD_CONFIRM: "待入职确认",
  TRAINING: "培训中",
  ACTIVE: "在职",
  LEFT: "已离职",
  ABANDONED: "放弃入职"
};
const STATUS_FILTERS = {
  candidates: ["PENDING", "ARRIVED", "PASSED", "FAILED", "PENDING_ONBOARD_CONFIRM"],
  training: ["TRAINING"],
  onboard: ["ACTIVE"],
  left: ["LEFT"],
  abandoned: ["ABANDONED"]
};

function normalizeEducationOption(value) {
  if (["中专", "高中/中专", "职高", "技校中专"].includes(value)) return "中专或技校";
  if (value === "硕士") return "研究生";
  return EDUCATION_OPTIONS.includes(value) ? value : "大专";
}

function normalizeMandarinOption(value) {
  const map = {
    一级甲等: "一甲",
    一级乙等: "一乙",
    二级甲等: "二甲",
    二级乙等: "二乙",
    三级甲等: "三甲",
    三级乙等: "三乙",
    无等级: "未评级",
    未评级: "未评级",
    无: "未评级"
  };
  return map[value] || (MANDARIN_OPTIONS.includes(value) ? value : "未评级");
}

function splitRecruitmentChannel(value = "") {
  const text = String(value || "").trim();
  if (text.startsWith("亲友介绍：")) return { channel: "亲友介绍", detail: text.slice(5) };
  if (text.startsWith("其他：")) return { channel: "其他", detail: text.slice(3) };
  if (CHANNEL_OPTIONS.includes(text)) return { channel: text, detail: "" };
  if (text.includes("朋友") || text.includes("亲友") || text.includes("介绍")) return { channel: "亲友介绍", detail: text };
  return text ? { channel: "其他", detail: text } : { channel: "BOSS直聘", detail: "" };
}

function projectName(id) {
  return state.projects.find(p => p.id === id)?.name || id || "-";
}

function roleLabel(role) {
  return ({ ADMIN: "超级管理员", HR: "HR", OPS: "运营账号" })[role] || role || "-";
}

function canWriteRecruitmentData() {
  return ["ADMIN", "HR"].includes(state.user?.role);
}

function resumeField(label, value) {
  return `<div class="resume-field"><span>${h(label)}</span><strong>${h(value || "-")}</strong></div>`;
}

function resumePreviewHtml(c) {
  const works = [...(c.workExperiences || [])].sort((a, b) => String(b.endDate || "").localeCompare(String(a.endDate || "")));
  const experience = (c.phoneCustomerServiceExperience ?? c.hasCustomerServiceExperience) ? "是" : "否";
  const expectedLocation = c.expectedLocation || [c.expectedProvince, c.expectedCity].filter(Boolean).join(" ");
  const source = c.source === "SELF" ? "候选人自助" : "HR录入";
  return `<article class="resume-paper">
    <header class="resume-head">
      <div class="resume-avatar">${h(Array.from(String(c.name || "简"))[0])}</div>
      <div>
        <h3>${h(c.name || "候选人")}</h3>
        <p>应聘简历 | ${h(c.education || "-")} | ${h(expectedLocation || "-")}</p>
      </div>
      <time>生成时间：${h(today())}</time>
    </header>
    <section class="resume-section">
      <h4>基础信息</h4>
      <div class="resume-grid">
        ${resumeField("姓名", c.name)}
        ${resumeField("性别", c.gender)}
        ${resumeField("出生日期", c.birthDate)}
        ${resumeField("学历", c.education)}
        ${resumeField("手机号", c.phone)}
        ${resumeField("邮箱", c.email)}
        ${resumeField("身份证号", c.idCard)}
        ${resumeField("电话客服经验", experience)}
        ${resumeField("婚姻状况", c.maritalStatus)}
        ${resumeField("子女情况", c.childrenStatus)}
        ${resumeField("毕业院校", c.graduationSchool)}
        ${resumeField("所学专业", c.major)}
        ${resumeField("普通话等级", c.mandarinLevel)}
        ${resumeField("毕业时间", c.graduationTime)}
      </div>
    </section>
    <section class="resume-section">
      <h4>地点与求职信息</h4>
      <div class="resume-grid">
        ${resumeField("当前居住地", c.currentResidence)}
        ${resumeField("期望工作地点", expectedLocation)}
        ${resumeField("招聘渠道", c.recruitmentChannel)}
        ${resumeField("应聘岗位", c.appliedPosition)}
        ${resumeField("可到岗时间", c.availableDate)}
        ${resumeField("资料来源", source)}
      </div>
      <div class="resume-note"><span>上一份工作离职原因</span><p>${h(c.lastLeaveReason || "-")}</p></div>
    </section>
    <section class="resume-section">
      <h4>工作经历</h4>
      ${works.map(work => `<div class="resume-work">
        <div>${resumeField("公司名称", work.companyName)}${resumeField("职位", work.position)}</div>
        <div>${resumeField("起止时间", `${work.startDate || "-"} 至 ${work.endDate || "-"}`)}</div>
        <div class="resume-note"><span>工作描述</span><p>${h(work.description || "-")}</p></div>
      </div>`).join("") || '<div class="empty">暂无工作经历</div>'}
    </section>
    <footer>内部保密资料</footer>
  </article>`;
}

function filenameFromDisposition(disposition) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || "download";
}

async function download(url) {
  try {
    const res = await fetch(url, {
      headers: api.token ? { authorization: `Bearer ${api.token}` } : {}
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "下载失败");
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filenameFromDisposition(res.headers.get("content-disposition"));
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch (err) {
    alert(err.message);
  }
}

async function loadCaptcha() {
  state.captcha = await api.post("/api/auth/captcha", {});
  const img = $("#captcha-img");
  if (img) img.src = state.captcha.image;
}

async function loginPage() {
  app.innerHTML = `
    <main class="login">
      <section class="login-card">
        <h1>在线简历收集系统</h1>
        <p>请使用管理员分配的账号登录</p>
        <label>用户名<input id="username" autocomplete="username"></label><br>
        <label>密码<input id="password" type="password" autocomplete="current-password"></label><br>
        <div class="captcha-row">
          <label>验证码<input id="captcha" placeholder="输入计算结果"></label>
          <img id="captcha-img" alt="验证码" title="点击刷新验证码">
        </div><br>
        <button class="primary" id="login-btn">登录</button>
      </section>
    </main>`;
  await loadCaptcha();
  $("#captcha-img").onclick = loadCaptcha;
  $("#login-btn").onclick = async () => {
    try {
      const data = await api.post("/api/auth/login", {
        username: $("#username").value,
        password: $("#password").value,
        captchaId: state.captcha.captchaId,
        captcha: $("#captcha").value
      });
      api.token = data.token;
      sessionStorage.setItem("token", data.token);
      state.user = data.user;
      await boot();
    } catch (err) {
      alert(err.message);
      loadCaptcha();
    }
  };
}

async function boot() {
  if (!api.token) return loginPage();
  try {
    state.user = (await api.get("/api/me")).user;
    state.projects = (await api.get("/api/projects")).items;
    renderShell();
    await renderActive();
  } catch {
    sessionStorage.removeItem("token");
    api.token = "";
    loginPage();
  }
}

function navItems() {
  const items = [
    ["candidates", "员工管理"],
    ["cumulative", "招聘统计"],
    ["daily", "日报管理"]
  ];
  if (["ADMIN", "HR"].includes(state.user?.role)) items.push(["projects", "项目配置"]);
  if (state.user?.role === "ADMIN") items.push(["users", "账号管理"], ["logs", "操作日志"]);
  return items;
}

function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">简历收集运营平台</div>
        <div class="nav">${navItems().map(([key, label]) => `<button data-nav="${key}">${label}</button>`).join("")}</div>
      </aside>
      <main class="main">
        <div class="topbar">
          <h2 id="page-title"></h2>
          <div>${h(state.user.displayName)} · ${h(roleLabel(state.user.role))} <button id="logout">退出</button></div>
        </div>
        <div id="view"></div>
      </main>
    </div>
    <div class="modal" id="modal"><div class="modal-body" id="modal-body"></div></div>`;
  document.querySelectorAll("[data-nav]").forEach(btn => btn.onclick = async () => {
    state.active = btn.dataset.nav;
    await renderActive();
  });
  $("#logout").onclick = () => {
    sessionStorage.removeItem("token");
    api.token = "";
    loginPage();
  };
}

async function renderActive() {
  if (!navItems().some(([key]) => key === state.active)) state.active = navItems()[0]?.[0] || "candidates";
  document.querySelectorAll("[data-nav]").forEach(btn => btn.classList.toggle("active", btn.dataset.nav === state.active));
  const item = navItems().find(([key]) => key === state.active);
  $("#page-title").textContent = item?.[1] || "";
  if (state.active === "candidates") return renderCandidates();
  if (state.active === "cumulative") return renderCumulative();
  if (state.active === "daily") return renderDaily();
  if (state.active === "projects") return renderProjects();
  if (state.active === "users") return renderUsers();
  if (state.active === "logs") return renderLogs();
}

function projectSelect(id = "project-filter", includeAll = false) {
  return `<select id="${id}">${includeAll ? '<option value="">全部项目</option>' : ""}${state.projects.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join("")}</select>`;
}

function projectCheckboxes(name, selectedIds = []) {
  const selected = new Set(selectedIds);
  return `<div class="checkbox-grid">${state.projects.map(p => `
    <label class="check-option">
      <input type="checkbox" name="${h(name)}" value="${h(p.id)}" ${selected.has(p.id) ? "checked" : ""}>
      <span>${h(p.name)}</span>
    </label>`).join("") || '<div class="empty">暂无可分配项目</div>'}</div>`;
}

function checkedProjectIds(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
}

function locationProvinceOptions() {
  return (window.CHINA_LOCATIONS || []).map(([province]) => `<option value="${h(province)}">${h(province)}</option>`).join("");
}

function setCityOptions(provinceId, cityId, selectedCity = "") {
  const province = $(`#${provinceId}`)?.value;
  const cities = (window.CHINA_LOCATIONS || []).find(([p]) => p === province)?.[1] || [];
  const city = $(`#${cityId}`);
  if (!city) return;
  city.innerHTML = cities.map(c => `<option value="${h(c)}">${h(c)}</option>`).join("");
  if (selectedCity && cities.includes(selectedCity)) city.value = selectedCity;
}

function splitExpectedLocation(candidate = {}) {
  if (candidate.expectedProvince || candidate.expectedCity) {
    return { province: candidate.expectedProvince || "", city: candidate.expectedCity || "" };
  }
  const text = candidate.expectedLocation || "";
  for (const [province, cities] of (window.CHINA_LOCATIONS || [])) {
    const city = cities.find(c => text.includes(c) || c.includes(text));
    if (text.includes(province) || city) return { province, city: city || cities[0] || "" };
  }
  const first = (window.CHINA_LOCATIONS || [])[0] || ["", [""]];
  return { province: first[0], city: first[1][0] };
}

function splitCurrentResidence(candidate = {}) {
  if (candidate.currentResidenceProvince || candidate.currentResidenceCity) {
    return { province: candidate.currentResidenceProvince || "", city: candidate.currentResidenceCity || "" };
  }
  const text = candidate.currentResidence || "";
  for (const [province, cities] of (window.CHINA_LOCATIONS || [])) {
    const city = cities.find(c => text.includes(c) || c.includes(text));
    if (text.includes(province) || city) return { province, city: city || cities[0] || "" };
  }
  const first = (window.CHINA_LOCATIONS || [])[0] || ["", [""]];
  return { province: first[0], city: first[1][0] };
}

async function renderCandidates() {
  const writable = canWriteRecruitmentData();
  const includeAll = ["ADMIN", "OPS"].includes(state.user?.role);
  let projectId = $("#project-filter")?.value ?? state.candidateProjectId ?? (includeAll ? "" : state.projects[0]?.id || "");
  if (!includeAll && !projectId) projectId = state.projects[0]?.id || "";
  const keyword = $("#keyword")?.value?.trim() ?? state.candidateKeyword ?? "";
  const group = state.candidateGroup || "candidates";
  const status = state.candidateStatus || "";
  state.candidateProjectId = projectId;
  state.candidateKeyword = keyword;
  const query = new URLSearchParams({ projectId, keyword, group, status });
  const [list, dashboard] = await Promise.all([
    api.get(`/api/candidates?${query.toString()}`),
    api.get(`/api/candidate-metrics?projectId=${encodeURIComponent(projectId)}`)
  ]);
  state.candidates = list.items;
  $("#view").innerHTML = `
    <section class="panel">
      ${renderCandidateDashboard(dashboard)}
    </section>
    <section class="panel">
      <div class="toolbar">
        <label>项目${projectSelect("project-filter", includeAll)}</label>
        <label>关键词<input id="keyword" placeholder="姓名 / 手机 / 身份证 / 邮箱 / 岗位" value="${h(keyword)}"></label>
        <label>状态<select id="candidate-status-filter"><option value="">全部状态</option>${(STATUS_FILTERS[group] || []).map(code => `<option value="${h(code)}">${h(STATUS_LABELS[code])}</option>`).join("")}</select></label>
        <button id="search">查询</button>
        ${writable ? '<button class="primary" id="new-candidate">新增候选人</button>' : ""}
        <button id="download-pdf">批量下载简历</button>
      </div>
      <div class="tabs">
        ${CANDIDATE_GROUPS.map(([key, label]) => `<button data-candidate-group="${key}" class="${group === key ? "active" : ""}">${label}</button>`).join("")}
      </div>
      <table>
        <thead><tr><th><input type="checkbox" id="check-all"></th><th>姓名</th><th>项目</th><th>手机</th><th>身份证</th><th>学历</th><th>岗位</th><th>状态</th><th>关键日期/原因</th><th>操作</th></tr></thead>
        <tbody>${state.candidates.map(c => `
          <tr>
            <td><input type="checkbox" data-id="${h(c.id)}"></td>
            <td>${h(c.name)}</td><td>${h(projectName(c.projectId))}</td><td>${h(c.phone)}</td><td>${h(c.idCard || "-")}</td><td>${h(c.education)}</td><td>${h(c.appliedPosition || "-")}</td>
            <td>${statusBadge(c.statusCode)}</td>
            <td>${renderCandidateStatusDetail(c)}</td>
            <td><div class="row-actions">
              ${renderCandidateActions(c, writable, group)}
              <button data-preview="${h(c.id)}">预览</button>
              <button data-pdf="${h(c.id)}">下载简历</button>
            </div></td>
          </tr>`).join("") || `<tr><td colspan="10" class="empty">暂无数据</td></tr>`}
        </tbody>
      </table>
    </section>`;
  $("#project-filter").value = projectId;
  $("#candidate-status-filter").value = status;
  $("#project-filter").onchange = () => {
    state.candidateProjectId = $("#project-filter").value;
    renderCandidates();
  };
  $("#candidate-status-filter").onchange = () => {
    state.candidateStatus = $("#candidate-status-filter").value;
    renderCandidates();
  };
  $("#search").onclick = () => {
    state.candidateKeyword = $("#keyword").value.trim();
    renderCandidates();
  };
  document.querySelectorAll("[data-candidate-group]").forEach(btn => btn.onclick = () => {
    state.candidateGroup = btn.dataset.candidateGroup;
    state.candidateStatus = "";
    renderCandidates();
  });
  if ($("#new-candidate")) $("#new-candidate").onclick = () => openCandidateForm();
  $("#check-all").onchange = e => document.querySelectorAll("[data-id]").forEach(cb => cb.checked = e.target.checked);
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = async () => openCandidateForm(await api.get(`/api/candidates/${b.dataset.edit}`)));
  document.querySelectorAll("[data-status-action]").forEach(select => select.onchange = () => {
    const action = select.value;
    select.value = "";
    if (action) openStatusDialog(select.dataset.statusAction, action);
  });
  document.querySelectorAll("[data-confirm-onboard]").forEach(b => b.onclick = () => openStatusDialog(b.dataset.confirmOnboard, "onboard"));
  document.querySelectorAll("[data-abandon]").forEach(b => b.onclick = () => openStatusDialog(b.dataset.abandon, "abandon"));
  document.querySelectorAll("[data-reschedule]").forEach(b => b.onclick = () => openStatusDialog(b.dataset.reschedule, "reschedule"));
  document.querySelectorAll("[data-left-employee]").forEach(b => b.onclick = () => openStatusDialog(b.dataset.leftEmployee, "left"));
  document.querySelectorAll("[data-activate]").forEach(b => b.onclick = () => openStatusDialog(b.dataset.activate, "activate"));
  document.querySelectorAll("[data-preview]").forEach(b => b.onclick = () => openResumePreview(b.dataset.preview));
  document.querySelectorAll("[data-pdf]").forEach(b => b.onclick = () => download(`/api/export/candidates.pdf?ids=${b.dataset.pdf}`));
  $("#download-pdf").onclick = () => {
    const ids = [...document.querySelectorAll("[data-id]:checked")].map(x => x.dataset.id);
    if (!ids.length) return alert("请先勾选候选人");
    download(`/api/export/candidates.pdf?ids=${ids.join(",")}`);
  };
}

function renderCandidateDashboard(data) {
  const metrics = data.metrics || {};
  const cards = [
    ["在职员工数量", metrics.onboardCount || 0],
    ["培训中", metrics.trainingCount || 0],
    ["今日新增", metrics.todayNew || 0],
    ["已到面", metrics.arrivedCount || 0],
    ["已通过", metrics.passedCount || 0],
    ["累计入职", metrics.joinedCount || 0],
    ["已离职", metrics.leftCount || 0]
  ];
  const messages = (data.messages || []).map(msg => `<div class="notice">${h(msg.message)}</div>`).join("");
  return `${messages}<div class="grid compact-grid">${cards.map(([label, value]) => `<div class="metric"><span>${h(label)}</span><strong>${h(value)}</strong></div>`).join("")}</div>`;
}

function statusBadge(code) {
  const label = STATUS_LABELS[code] || "待处理";
  const cls = code === "ACTIVE" || code === "ARRIVED" || code === "PASSED" ? "ok" : code === "FAILED" || code === "LEFT" || code === "ABANDONED" ? "danger" : ["PENDING_ONBOARD_CONFIRM", "TRAINING"].includes(code) ? "warn" : "";
  return `<span class="badge ${cls}">${h(label)}</span>`;
}

function renderCandidateStatusDetail(c) {
  if (c.statusCode === "PASSED" || c.statusCode === "PENDING_ONBOARD_CONFIRM") return `计划入职：${h(c.plannedJoinDate || "-")}`;
  if (c.statusCode === "TRAINING") return `实际入职：${h(dateOnly(c.joinedAt) || "-")}<br>培训开始：${h(dateOnly(c.trainingStartedAt) || "-")}`;
  if (c.statusCode === "ACTIVE") return `实际入职：${h(dateOnly(c.joinedAt) || "-")}<br>转在职：${h(dateOnly(c.activeAt) || "-")}`;
  if (c.statusCode === "FAILED") return `未通过原因：${h(c.failedReason || "-")}`;
  if (c.statusCode === "LEFT") return `离职日期：${h(dateOnly(c.leftAt) || "-")}<br>${h(c.leftReason || "")}`;
  if (c.statusCode === "ABANDONED") return `放弃原因：${h(c.abandonReason || "-")}`;
  return "-";
}

function renderCandidateActions(c, writable, group) {
  if (!writable) return "";
  if (group === "candidates") {
    return `<button data-edit="${h(c.id)}">编辑</button>
      <select class="action-select" data-status-action="${h(c.id)}">
        <option value="">状态操作</option>
        <option value="arrived">到面</option>
        <option value="passed">通过</option>
        <option value="failed">不通过</option>
        <option value="onboard">入职</option>
      </select>
      ${c.statusCode === "PENDING_ONBOARD_CONFIRM" ? `
        <button data-confirm-onboard="${h(c.id)}">确认入职</button>
        <button data-abandon="${h(c.id)}">放弃入职</button>
        <button data-reschedule="${h(c.id)}">更改入职时间</button>` : ""}`;
  }
  if (group === "training") return `<button data-activate="${h(c.id)}">转为在职</button><button class="danger" data-left-employee="${h(c.id)}">离职</button>`;
  if (group === "onboard") return `<button class="danger" data-left-employee="${h(c.id)}">离职</button>`;
  return "";
}

async function openResumePreview(id) {
  try {
    const candidate = await api.get(`/api/candidates/${id}`);
    const modal = $("#modal");
    modal.classList.add("open", "drawer-open");
    modal.querySelector("#modal-body").innerHTML = `
      <div class="modal-head"><h3>简历预览</h3><button id="close-modal">关闭</button></div>
      ${resumePreviewHtml(candidate)}
      <div class="drawer-actions"><button class="primary" id="preview-download">下载简历</button></div>`;
    $("#close-modal").onclick = () => modal.classList.remove("open", "drawer-open");
    $("#preview-download").onclick = () => download(`/api/export/candidates.pdf?ids=${candidate.id}`);
  } catch (err) {
    alert(err.message);
  }
}

async function postCandidateStatus(id, payload) {
  try {
    await api.post(`/api/candidates/${id}/status`, payload);
    $("#modal")?.classList.remove("open", "drawer-open");
    renderCandidates();
  } catch (err) {
    if (err.confirmRequired && confirm(err.message)) {
      await api.post(`/api/candidates/${id}/status`, { ...payload, force: true });
      $("#modal")?.classList.remove("open", "drawer-open");
      return renderCandidates();
    }
    alert(err.message);
  }
}

function openStatusDialog(id, type) {
  if (type === "arrived") {
    if (!confirm("确认标记该候选人已到面吗？")) return;
    return postCandidateStatus(id, { type });
  }
  if (type === "onboard") {
    if (!confirm("确认入职并进入培训吗？系统将自动记录今天为实际入职和培训开始日期。")) return;
    return postCandidateStatus(id, { type });
  }
  const modal = $("#modal");
  modal.classList.remove("drawer-open");
  const configs = {
    passed: { title: "标记通过", label: "入职时间", control: "date", payloadKey: "plannedJoinDate", submit: "确认通过" },
    failed: { title: "标记不通过", label: "未通过原因", control: "textarea", payloadKey: "reason", submit: "确认不通过" },
    activate: { title: "培训结束并转为在职", label: "培训结束日期", control: "date", payloadKey: "trainingEndDate", submit: "确认转为在职" },
    abandon: { title: "放弃入职", label: "放弃原因", control: "textarea", payloadKey: "reason", submit: "确认放弃" },
    reschedule: { title: "更改入职时间", label: "新的入职时间", control: "date", payloadKey: "plannedJoinDate", submit: "保存" }
  };
  const cfg = configs[type];
  if (type === "left") {
    modal.querySelector("#modal-body").innerHTML = `
      <div class="modal-head"><h3>办理离职</h3><button id="close-modal">关闭</button></div>
      <div class="form-grid">
        <label>离职日期<input id="status-left-date" type="date" data-date-only value="${today()}" required></label>
        <label class="form-wide">离职原因<textarea id="status-value" maxlength="200" required></textarea><span class="counter" id="status-count">0/200</span></label>
      </div><br>
      <button class="primary" id="submit-status">确认离职</button>`;
    modal.classList.add("open");
    $("#close-modal").onclick = () => modal.classList.remove("open");
    bindDateOnlyInputs(modal);
    $("#status-value").oninput = () => { $("#status-count").textContent = `${$("#status-value").value.length}/200`; };
    $("#submit-status").onclick = () => {
      const reason = $("#status-value").value.trim();
      const leftDate = $("#status-left-date").value;
      if (!isDateOnly(leftDate)) return alert("离职日期为必填");
      if (!reason) return alert("离职原因为必填");
      if (reason.length > 200) return alert("离职原因最多200字");
      postCandidateStatus(id, { type, reason, leftDate });
    };
    return;
  }
  if (!cfg) return alert("状态类型错误");
  modal.querySelector("#modal-body").innerHTML = `
    <div class="modal-head"><h3>${h(cfg.title)}</h3><button id="close-modal">关闭</button></div>
    <div class="form-grid">
      ${cfg.control === "date"
        ? `<label class="form-wide">${h(cfg.label)}<input id="status-value" type="date" data-date-only required></label>`
        : `<label class="form-wide">${h(cfg.label)}<textarea id="status-value" maxlength="200" required></textarea><span class="counter" id="status-count">0/200</span></label>`}
    </div><br>
    <button class="primary" id="submit-status">${h(cfg.submit)}</button>`;
  modal.classList.add("open");
  $("#close-modal").onclick = () => modal.classList.remove("open");
  bindDateOnlyInputs(modal);
  if ($("#status-count")) {
    $("#status-value").oninput = () => { $("#status-count").textContent = `${$("#status-value").value.length}/200`; };
  }
  $("#submit-status").onclick = () => {
    const value = $("#status-value").value.trim();
    if (!value) return alert(`${cfg.label}为必填`);
    if (cfg.control === "textarea" && value.length > 200) return alert(`${cfg.label}最多200字`);
    if (cfg.control === "date" && !isDateOnly(value)) return alert("请选择完整日期");
    postCandidateStatus(id, { type, [cfg.payloadKey]: value });
  };
}

function workBlock(w = {}, i = 0) {
  return `<div class="work-item" data-work>
    <div class="form-grid">
      <label>公司名称<input data-w="companyName" value="${h(w.companyName)}" required></label>
      <label>职位<input data-w="position" value="${h(w.position)}" required></label>
      <label>开始时间<input data-w="startDate" type="text" inputmode="numeric" maxlength="10" placeholder="yyyy-mm-dd" data-manual-date value="${h(dateOnly(w.startDate))}" required></label>
      <label>结束时间<input data-w="endDate" type="text" inputmode="numeric" maxlength="10" placeholder="yyyy-mm-dd" data-manual-date value="${h(dateOnly(w.endDate))}" required></label>
    </div><br>
    <label>工作描述<textarea data-w="description" required>${h(w.description)}</textarea></label><br>
    <button class="danger" data-remove-work="${i}">删除经历</button>
  </div>`;
}

function collectCandidateForm(existing) {
  const channel = $("#c-channel").value;
  const channelDetail = $("#c-channel-detail")?.value.trim() || "";
  return {
    projectId: existing?.projectId || $("#candidate-project").value,
    name: $("#c-name").value,
    gender: $("#c-gender").value,
    birthDate: $("#c-birth").value,
    education: $("#c-edu").value,
    phone: $("#c-phone").value,
    idCard: $("#c-id-card").value.trim().toUpperCase(),
    email: $("#c-email").value,
    recruitmentChannel: ["亲友介绍", "其他"].includes(channel) ? `${channel}：${channelDetail}` : channel,
    appliedPosition: $("#c-position").value,
    availableDate: $("#c-available-date").value,
    graduationSchool: $("#c-school").value,
    major: $("#c-major").value,
    mandarinLevel: $("#c-mandarin").value,
    graduationTime: $("#c-graduation-time").value,
    phoneCustomerServiceExperience: $("#c-phone-exp").value === "true",
    currentResidenceProvince: $("#c-residence-province").value,
    currentResidenceCity: $("#c-residence-city").value,
    currentResidence: [$("#c-residence-province").value, $("#c-residence-city").value].filter(Boolean).join(" "),
    maritalStatus: $("#c-marital").value,
    childrenStatus: $("#c-children").value,
    expectedProvince: $("#c-expected-province").value,
    expectedCity: $("#c-expected-city").value,
    expectedLocation: [$("#c-expected-province").value, $("#c-expected-city").value].filter(Boolean).join(" "),
    lastLeaveReason: $("#c-leave").value,
    workExperiences: [...document.querySelectorAll("[data-work]")].map(block => Object.fromEntries([...block.querySelectorAll("[data-w]")].map(input => [input.dataset.w, input.value])))
  };
}

function validateCandidateFormData(data) {
  const requiredLabels = {
    name: "姓名",
    gender: "性别",
    birthDate: "出生日期",
    education: "学历",
    phone: "手机号",
    idCard: "身份证号码",
    email: "邮箱",
    recruitmentChannel: "获知招聘信息渠道",
    appliedPosition: "应聘岗位",
    availableDate: "可到岗时间",
    graduationSchool: "毕业院校",
    major: "所学专业",
    mandarinLevel: "普通话水平等级",
    graduationTime: "毕业时间",
    currentResidenceProvince: "当前居住省份",
    currentResidenceCity: "当前居住地市",
    maritalStatus: "婚姻状况",
    childrenStatus: "子女情况",
    expectedProvince: "期望工作省份",
    expectedCity: "期望工作地市",
    lastLeaveReason: "上一份工作离职原因"
  };
  for (const [key, label] of Object.entries(requiredLabels)) {
    if (!String(data[key] || "").trim()) return `${label}为必填`;
  }
  if (!window.validatePhoneNumber(data.phone)) return "手机号格式不正确，请输入 11 位中国大陆手机号";
  if (!window.validateIdCardNumber(data.idCard)) return "身份证号码格式不正确，请输入 18 位身份证号并检查出生日期和校验位";
  if (data.recruitmentChannel === "亲友介绍：" || data.recruitmentChannel === "其他：") return "请补充获知招聘信息渠道的具体信息";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return "邮箱格式不正确";
  for (const [key, label] of [["birthDate", "出生日期"], ["availableDate", "可到岗时间"], ["graduationTime", "毕业时间"]]) {
    if (!isDateOnly(data[key])) return `${label}格式应为 yyyy-mm-dd`;
  }
  if (data.graduationTime < data.birthDate) return "毕业时间不能早于出生日期";
  if (data.lastLeaveReason.length > 500) return "上一份工作离职原因最多500字";
  if (!data.workExperiences.length) return "至少填写一段工作经历";
  for (const work of data.workExperiences) {
    if (!work.companyName || !work.position || !work.startDate || !work.endDate || !work.description) return "工作经历每一项均为必填";
    if (!isDateOnly(work.startDate) || !isDateOnly(work.endDate)) return "工作经历开始/结束时间请选择完整日期";
    if (work.endDate < work.startDate) return "工作经历的结束时间不能早于开始时间";
  }
  return "";
}

function openCandidateForm(existing = null) {
  const modal = $("#modal");
  const works = existing?.workExperiences?.length ? existing.workExperiences : [{}];
  const residence = splitCurrentResidence(existing || {});
  const expected = splitExpectedLocation(existing || {});
  modal.classList.remove("drawer-open");
  $("#modal-body").innerHTML = `
    <div class="modal-head"><h3>${existing ? "编辑候选人" : "新增候选人"}</h3><button id="close-modal">关闭</button></div>
    <div class="form-grid">
      <label>项目<select id="candidate-project" ${existing ? "disabled" : ""}>${state.projects.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join("")}</select></label>
      <label>姓名<input id="c-name" value="${h(existing?.name)}" required></label>
      <label>性别<select id="c-gender" required><option>男</option><option>女</option><option>其他</option></select></label>
      <label>出生日期（身份证自动提取）<input id="c-birth" value="${h(dateOnly(existing?.birthDate))}" readonly required></label>
      <label>学历<select id="c-edu" required>${EDUCATION_OPTIONS.map(x => `<option>${x}</option>`).join("")}</select></label>
      <label>手机号<input id="c-phone" value="${h(existing?.phone)}" required></label>
      <label>身份证号码<input id="c-id-card" value="${h(existing?.idCard)}" maxlength="18" minlength="18" placeholder="18位身份证号" required></label>
      <label>邮箱<input id="c-email" type="email" value="${h(existing?.email)}" required></label>
      <label>获知招聘信息渠道<select id="c-channel" required>${CHANNEL_OPTIONS.map(x => `<option>${x}</option>`).join("")}</select></label>
      <label id="c-channel-detail-wrap" style="display:none">渠道补充信息<input id="c-channel-detail" placeholder="如选择其他，请输入具体渠道；如选择亲友介绍，请输入介绍人"></label>
      <label>应聘岗位<input id="c-position" value="${h(existing?.appliedPosition)}" required></label>
      <label>可到岗时间<input id="c-available-date" type="text" inputmode="numeric" maxlength="10" placeholder="yyyy-mm-dd" data-manual-date value="${h(dateOnly(existing?.availableDate))}" required></label>
      <label>毕业院校<input id="c-school" value="${h(existing?.graduationSchool)}" required></label>
      <label>所学专业<input id="c-major" value="${h(existing?.major)}" required></label>
      <label>普通话水平等级<select id="c-mandarin" required>${MANDARIN_OPTIONS.map(x => `<option>${x}</option>`).join("")}</select></label>
      <label>毕业时间<input id="c-graduation-time" type="text" inputmode="numeric" maxlength="10" placeholder="yyyy-mm-dd" data-manual-date value="${h(dateOnly(existing?.graduationTime))}" required></label>
      <label>电话客服类行业经验<select id="c-phone-exp" required><option value="true">是</option><option value="false">否</option></select></label>
      <label>当前居住省份<select id="c-residence-province" required>${locationProvinceOptions()}</select></label>
      <label>当前居住地市<select id="c-residence-city" required></select></label>
      <label>婚姻状况<select id="c-marital" required><option>未婚</option><option>已婚</option></select></label>
      <label>子女情况<select id="c-children" required><option>无</option><option>有</option></select></label>
      <label>期望工作省份<select id="c-expected-province" required>${locationProvinceOptions()}</select></label>
      <label>期望工作地市<select id="c-expected-city" required></select></label>
      <label class="form-wide">上一份工作离职原因<textarea id="c-leave" maxlength="500" required>${h(existing?.lastLeaveReason)}</textarea><span class="counter" id="c-leave-count">0/500</span></label>
    </div>
    <h4>工作经历</h4>
    <div id="work-list">${works.map(workBlock).join("")}</div>
    <button id="add-work">增加经历</button>
    <button class="primary" id="save-candidate">保存</button>`;
  modal.classList.add("open");
  $("#close-modal").onclick = () => modal.classList.remove("open");
  if (existing) {
    $("#candidate-project").value = existing.projectId;
    $("#c-gender").value = existing.gender;
    $("#c-edu").value = normalizeEducationOption(existing.education);
    $("#c-phone-exp").value = String(Boolean(existing.phoneCustomerServiceExperience ?? existing.hasCustomerServiceExperience));
    $("#c-mandarin").value = normalizeMandarinOption(existing.mandarinLevel);
    $("#c-marital").value = existing.maritalStatus || "未婚";
    $("#c-children").value = existing.childrenStatus || "无";
  }
  $("#c-residence-province").value = residence.province;
  setCityOptions("c-residence-province", "c-residence-city", residence.city);
  $("#c-residence-province").onchange = () => setCityOptions("c-residence-province", "c-residence-city");
  $("#c-expected-province").value = expected.province;
  setCityOptions("c-expected-province", "c-expected-city", expected.city);
  $("#c-expected-province").onchange = () => setCityOptions("c-expected-province", "c-expected-city");
  const channelParts = splitRecruitmentChannel(existing?.recruitmentChannel);
  $("#c-channel").value = channelParts.channel;
  $("#c-channel-detail").value = channelParts.detail;
  const toggleChannelDetail = () => {
    const needsDetail = ["亲友介绍", "其他"].includes($("#c-channel").value);
    $("#c-channel-detail-wrap").style.display = needsDetail ? "grid" : "none";
    $("#c-channel-detail").required = needsDetail;
    $("#c-channel-detail").placeholder = $("#c-channel").value === "亲友介绍" ? "请输入介绍人" : "请输入具体渠道";
  };
  $("#c-channel").onchange = toggleChannelDetail;
  toggleChannelDetail();
  $("#add-work").onclick = () => {
    $("#work-list").insertAdjacentHTML("beforeend", workBlock());
    window.bindManualDateInputs(modal);
    bindWorkRemove();
  };
  window.bindManualDateInputs(modal);
  const syncBirthDate = () => {
    $("#c-id-card").value = $("#c-id-card").value.toUpperCase();
    $("#c-birth").value = window.validateIdCardNumber($("#c-id-card").value)
      ? window.extractBirthDateFromIdCard($("#c-id-card").value)
      : "";
  };
  $("#c-id-card").addEventListener("input", syncBirthDate);
  syncBirthDate();
  const leaveCounter = () => { $("#c-leave-count").textContent = `${$("#c-leave").value.length}/500`; };
  $("#c-leave").oninput = leaveCounter;
  leaveCounter();
  bindWorkRemove();
  $("#save-candidate").onclick = async () => {
    try {
      const data = collectCandidateForm(existing);
      const message = validateCandidateFormData(data);
      if (message) return alert(message);
      existing ? await api.put(`/api/candidates/${existing.id}`, data) : await api.post("/api/candidates", data);
      modal.classList.remove("open");
      renderCandidates();
    } catch (err) { alert(err.message); }
  };
}

function bindWorkRemove() {
  document.querySelectorAll("[data-remove-work]").forEach(b => b.onclick = () => b.closest("[data-work]").remove());
}

function renderMetrics(metrics, keys = null) {
  const labels = {
    candidateCount: "累计候选人",
    newCandidateCount: "今日新增候选人",
    arrivedCount: "到面人数",
    passedCount: "通过人数",
    joinedCount: "入职人数",
    leftCount: "离职人数",
    trainingCount: "当前培训中人数",
    onboardCount: "当前在岗人数",
    remainingGap: "当前剩余缺口",
    passRate: "总通过率",
    hcCompletionRate: "目标完成率"
  };
  const value = (key, val) => ["passRate", "hcCompletionRate"].includes(key) ? `${val}%` : val;
  const entries = Object.entries(metrics).filter(([key]) => !keys || keys.includes(key));
  return `<div class="grid">${entries.map(([k, v]) => `<div class="metric"><span>${h(labels[k] || k)}</span><strong>${h(value(k, v))}</strong></div>`).join("")}</div>`;
}

function renderRecruitmentComparison(todayMetrics = {}, cumulativeMetrics = {}) {
  const items = [
    ["新增候选人", "candidateCount"],
    ["到面人数", "arrivedCount"],
    ["通过人数", "passedCount"],
    ["入职人数", "joinedCount"],
    ["离职人数", "leftCount"]
  ];
  return `<div class="comparison-grid">${items.map(([label, key]) => `
    <div class="comparison-card">
      <h4>${h(label)}</h4>
      <div class="comparison-value today-value"><span>今日</span><strong>${h(todayMetrics[key] || 0)}</strong></div>
      <div class="comparison-value cumulative-value"><span>累计</span><strong>${h(cumulativeMetrics[key] || 0)}</strong></div>
    </div>`).join("")}</div>`;
}

function renderJoinTrend(points = [], month = "") {
  if (!points.length) return "";
  const width = 760;
  const height = 250;
  const padX = 42;
  const padY = 28;
  const max = Math.max(1, ...points.map(point => Number(point.count || 0)));
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;
  const x = index => padX + (points.length === 1 ? usableWidth / 2 : index * usableWidth / (points.length - 1));
  const y = count => height - padY - Number(count || 0) / max * usableHeight;
  const linePoints = points.map((point, index) => `${x(index).toFixed(1)},${y(point.count).toFixed(1)}`).join(" ");
  const labels = points.map((point, index) => {
    if (index !== 0 && index !== points.length - 1 && index % 5 !== 0) return "";
    return `<text x="${x(index).toFixed(1)}" y="${height - 7}" text-anchor="middle">${h(point.date.slice(5))}</text>`;
  }).join("");
  const dots = points.map((point, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(point.count).toFixed(1)}" r="3.5"><title>${h(point.date)}：${h(point.count)}人</title></circle>`).join("");
  return `<section class="report-section trend-panel">
    <div class="section-heading"><div><h3>当月每日入职人数</h3><p>${h(month)}，数据来源：候选人“已入职”状态及实际入职时间</p></div></div>
    <div class="line-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${h(month)}每日入职人数曲线">
        <line class="chart-axis" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"></line>
        <line class="chart-gridline" x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}"></line>
        <text class="chart-y-label" x="${padX - 10}" y="${padY + 4}" text-anchor="end">${max}</text>
        <text class="chart-y-label" x="${padX - 10}" y="${height - padY + 4}" text-anchor="end">0</text>
        <polyline class="join-line" points="${linePoints}"></polyline>
        <g class="join-dots">${dots}</g>
        <g class="chart-x-labels">${labels}</g>
      </svg>
    </div>
  </section>`;
}

function renderDonut(group, data) {
  const palette = ["#155eef", "#0f8a5f", "#f79009", "#c4320a", "#7a5af8", "#0891b2"];
  const entries = Object.entries(data || {});
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  if (!total) return `<div class="empty">暂无数据</div>`;
  let cursor = 0;
  const gradient = entries.map(([label, value], index) => {
    const start = cursor;
    const percent = Number(value || 0) / total * 100;
    cursor += percent;
    return `${palette[index % palette.length]} ${start}% ${cursor}%`;
  }).join(", ");
  return `
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${gradient});">
        <div><strong>${total}</strong><span>总数</span></div>
      </div>
      <div class="legend">
        ${entries.map(([label, value], index) => {
          const percent = total ? (Number(value || 0) / total * 100).toFixed(1) : "0.0";
          return `<div><i style="background:${palette[index % palette.length]}"></i><span>${h(label)}</span><b>${value}</b><em>${percent}%</em></div>`;
        }).join("")}
      </div>
    </div>`;
}

function renderCharts(distributions, options = {}) {
  const groupLabels = {
    education: "学历分布",
    gender: "性别分布",
    experience: "电话客服经验分布",
    age: "年龄段分布"
  };
  const donutGroups = new Set(options.donutGroups || []);
  return `<div class="chart-grid">${Object.entries(distributions || {}).map(([group, data]) => {
    const max = Math.max(1, ...Object.values(data));
    const chart = donutGroups.has(group)
      ? renderDonut(group, data)
      : Object.entries(data).map(([k, v]) => `<div class="bar"><span>${h(k)}</span><div><i style="width:${v / max * 100}%"></i></div><b>${v}</b></div>`).join("") || "暂无数据";
    return `<section class="panel"><h3>${h(groupLabels[group] || group)}</h3>${chart}</section>`;
  }).join("")}</div>`;
}

function renderProjectStats(items = []) {
  if (!items.length) return "";
  return `
    <section class="panel">
      <h3>按项目统计</h3>
      <table>
        <thead><tr><th>项目</th><th>累计候选人</th><th>到面人数</th><th>通过人数</th><th>入职人数</th><th>离职人数</th><th>培训中</th><th>当前在岗</th><th>剩余缺口</th><th>总通过率</th><th>目标完成率</th></tr></thead>
        <tbody>${items.map(item => `
          <tr>
            <td>${h(item.projectName)}</td>
            <td>${h(item.candidateCount)}</td>
            <td>${h(item.arrivedCount)}</td>
            <td>${h(item.passedCount)}</td>
            <td>${h(item.joinedCount)}</td>
            <td>${h(item.leftCount)}</td>
            <td>${h(item.trainingCount || 0)}</td>
            <td>${h(item.onboardCount)}</td>
            <td>${h(item.remainingGap)}</td>
            <td>${h(item.passRate)}%</td>
            <td>${h(item.hcCompletionRate)}%</td>
          </tr>`).join("")}</tbody>
      </table>
    </section>`;
}

function renderTodayProjectStats(items = []) {
  if (!items.length) return "";
  const max = Math.max(1, ...items.map(item => Number(item.joinedCount || 0)));
  return `
    <section class="panel project-today-panel">
      <h3>当日各项目入职对比</h3>
      <div class="project-today-chart" role="img" aria-label="当日各项目入职人数柱状图">
        ${items.map(item => {
          const count = Number(item.joinedCount || 0);
          const height = count ? Math.max(8, count / max * 160) : 2;
          return `<div class="project-column">
            <strong>${h(count)}</strong>
            <div class="project-bar-track"><i class="project-bar" style="height:${height}px" title="${h(item.projectName)}：${h(count)}人"></i></div>
            <span>${h(item.projectName)}</span>
          </div>`;
        }).join("")}
      </div>
      <h3 class="project-today-table-title">当日各项目招聘数据</h3>
      <table>
        <thead><tr><th>项目</th><th>日期</th><th>当日新增</th><th>当日到面</th><th>当日通过</th><th>当日入职</th><th>当日离职</th><th>培训中</th><th>当前在职</th></tr></thead>
        <tbody>${items.map(item => `<tr>
          <td>${h(item.projectName)}</td>
          <td>${h(item.date)}</td>
          <td>${h(item.newCandidateCount)}</td>
          <td>${h(item.arrivedCount)}</td>
          <td>${h(item.passedCount)}</td>
          <td>${h(item.joinedCount)}</td>
          <td>${h(item.leftCount)}</td>
          <td>${h(item.trainingCount || 0)}</td>
          <td>${h(item.onboardCount)}</td>
        </tr>`).join("")}</tbody>
      </table>
    </section>`;
}

function renderRecruitmentReport(report = {}) {
  const current = report.currentDayMetrics || {};
  const currentDayMetrics = {
    ...current,
    candidateCount: current.candidateCount ?? current.newCandidateCount ?? 0
  };
  const metrics = report.metrics || {};
  const secondaryMetrics = ["trainingCount", "onboardCount", "remainingGap", "passRate", "hcCompletionRate"];
  return renderRecruitmentComparison(currentDayMetrics, metrics) +
    "<br>" + renderMetrics(metrics, secondaryMetrics) +
    renderJoinTrend(report.dailyJoinTrend || [], report.reportMonth || "") +
    "<br>" + renderCharts(report.distributions || {}, { donutGroups: ["gender", "experience"] }) +
    "<br>" + renderProjectStats(report.byProject || []) +
    renderTodayProjectStats(report.todayByProject || []);
}

async function renderCumulative() {
  $("#view").innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div><h3>招聘统计</h3><p>同一方格对比今日数据与所选范围的累计数据</p></div>
      </div>
      <div class="toolbar">
        <label>项目<select id="report-project"><option value="">全部项目</option>${state.projects.map(p => `<option value="${h(p.id)}">${h(p.name)}</option>`).join("")}</select></label>
        <label>开始日期<input id="from" type="date" data-date-only></label>
        <label>结束日期<input id="to" type="date" data-date-only></label>
        <label>统计月份<input id="report-month" type="month" data-month-only value="${today().slice(0, 7)}"></label>
        <button id="load-report">查询累计数据</button>
        <button id="export-report">导出 Excel</button>
      </div>
      <div id="report-box"></div>
    </section>`;
  bindDateOnlyInputs($("#view"));
  $("#load-report").onclick = loadCumulative;
  $("#export-report").onclick = () => download(`/api/export/report.xlsx?kind=cumulative&projectId=${$("#report-project").value}&from=${$("#from").value}&to=${$("#to").value}`);
  $("#report-month").onchange = loadCumulative;
  await loadCumulative();
}

async function loadCumulative() {
  const projectId = $("#report-project").value;
  const month = $("#report-month").value;
  const reportQuery = new URLSearchParams({ projectId, from: $("#from").value, to: $("#to").value, month });
  const todayQuery = new URLSearchParams({ projectId, from: today(), to: today(), month, summaryOnly: "true" });
  const [cumulative, currentDay] = await Promise.all([
    api.get(`/api/reports/cumulative?${reportQuery.toString()}`),
    api.get(`/api/reports/cumulative?${todayQuery.toString()}`)
  ]);
  $("#report-box").innerHTML = renderRecruitmentReport({
    ...cumulative,
    currentDayMetrics: currentDay.metrics,
    reportMonth: month
  });
}

function reportCalendarHtml(month, dates, selectedDate) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const dayCount = new Date(year, monthNumber, 0).getDate();
  const existing = new Set(dates);
  const cells = Array.from({ length: firstWeekday }, () => '<span class="calendar-day calendar-empty"></span>');
  for (let day = 1; day <= dayCount; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    cells.push(`<button class="calendar-day ${existing.has(date) ? "has-report" : ""} ${selectedDate === date ? "selected" : ""}" data-report-date="${date}" aria-label="${date}${existing.has(date) ? "，已有日报" : "，暂无日报"}">${day}</button>`);
  }
  return `<div class="report-calendar">
    <div class="calendar-weekdays">${["日", "一", "二", "三", "四", "五", "六"].map(day => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-days">${cells.join("")}</div>
  </div>`;
}

async function renderDaily() {
  const canViewAll = ["ADMIN", "OPS"].includes(state.user?.role);
  const projectOptions = `${canViewAll ? '<option value="">全部项目</option>' : ""}${state.projects.map(project => `<option value="${h(project.id)}">${h(project.name)}</option>`).join("")}`;
  const settings = state.user?.role === "ADMIN" ? await api.get("/api/settings/report-delivery") : null;
  $("#view").innerHTML = `
    <section class="panel">
      <div class="section-heading">
        <div><h3>日报历史</h3><p>红色圆圈表示该日已有锁定快照，点击日期查看完整日报。</p></div>
      </div>
      <div class="toolbar">
        <label>项目<select id="daily-project">${projectOptions}</select></label>
        <label>月份<input id="daily-month" type="text" value="${today().slice(0, 7)}" aria-label="日报月份" autocomplete="off"></label>
        <button id="export-daily-pdf" disabled>下载 PDF</button>
        <button id="export-daily" disabled>导出 Excel</button>
      </div>
      <div id="daily-calendar"></div>
      <div id="daily-box" class="empty">请选择日期查看日报。</div>
    </section>
    ${settings ? `<section class="panel">
      <div class="section-heading">
        <div><h3>日报生成与发送</h3><p>保存后定时任务将在下一分钟读取新配置；仅支持企业微信群机器人 Webhook。</p></div>
      </div>
      <div class="form-grid">
        <label>每日生成并发送时间<input id="report-send-time" type="time" value="${h(settings.sendTime)}"></label>
        <label>企业微信机器人 Webhook<input id="report-webhook" type="password" autocomplete="off" placeholder="${h(settings.webhookHint)}"></label>
        <label class="check-option"><input id="report-delivery-enabled" type="checkbox" ${settings.deliveryEnabled ? "checked" : ""}><span>启用自动发送</span></label>
        <label class="check-option"><input id="report-clear-webhook" type="checkbox"><span>清除已保存的 Webhook</span></label>
      </div>
      <div class="report-setting-status">最近生成：${h(settings.lastGeneratedDate || "-")}　最近发送：${h(settings.lastSentDate || "-")}　${settings.lastSendError ? `<span class="danger-text">发送错误：${h(settings.lastSendError)}</span>` : ""}</div>
      <div class="section-actions"><button class="primary" id="save-report-settings">保存设置</button></div>
      <div class="manual-report-row">
        <label>补生成日期<input id="manual-report-date" type="date" data-date-only value="${today()}"></label>
        <button id="manual-generate-report">手动生成当前项目日报</button>
      </div>
      <div class="readonly-note">已存在的日报不会被覆盖；选择“全部项目”时会补齐全项目和各项目快照。</div>
    </section>` : ""}`;
  bindDateOnlyInputs($("#view"));

  let reportDates = [];
  let selectedDate = "";

  const paintCalendar = () => {
    $("#daily-calendar").innerHTML = reportCalendarHtml($("#daily-month").value, reportDates, selectedDate);
    document.querySelectorAll("[data-report-date]").forEach(button => {
      button.onclick = () => loadDailyDate(button.dataset.reportDate);
    });
  };

  const loadDailyDate = async date => {
    selectedDate = date;
    paintCalendar();
    const hasReport = reportDates.includes(date);
    $("#export-daily-pdf").disabled = !hasReport;
    $("#export-daily").disabled = !hasReport;
    if (!hasReport) {
      $("#daily-box").innerHTML = '<div class="empty">暂无日报</div>';
      return;
    }
    try {
      const query = new URLSearchParams({ projectId: $("#daily-project").value, date });
      const report = await api.get(`/api/reports/daily?${query.toString()}`);
      $("#daily-box").innerHTML = `<div class="snapshot-heading"><h3>${h(report.projectName || "招聘")}招聘日报</h3><span>${h(report.date)} 固化快照 · ${h(formatShanghaiDateTime(report.generatedAt))}</span></div>${renderRecruitmentReport(report)}`;
    } catch (err) { $("#daily-box").innerHTML = `<div class="notice">${h(err.message)}</div>`; }
  };

  const loadDailyMonth = async () => {
    selectedDate = "";
    const query = new URLSearchParams({ projectId: $("#daily-project").value, month: $("#daily-month").value });
    const result = await api.get(`/api/reports/daily/dates?${query.toString()}`);
    reportDates = result.dates || [];
    paintCalendar();
    const preferred = reportDates.includes(today()) ? today() : reportDates[reportDates.length - 1];
    if (preferred) await loadDailyDate(preferred);
    else {
      $("#daily-box").innerHTML = '<div class="empty">本月暂无日报</div>';
      $("#export-daily-pdf").disabled = true;
      $("#export-daily").disabled = true;
    }
  };

  let dailyMonthPicker = null;
  if (typeof window.flatpickr === "function" && typeof window.monthSelectPlugin === "function") {
    dailyMonthPicker = window.flatpickr($("#daily-month"), {
      locale: "zh",
      defaultDate: today().slice(0, 7),
      altInput: true,
      altFormat: "Y年m月",
      allowInput: false,
      plugins: [new window.monthSelectPlugin({ shorthand: true, dateFormat: "Y-m", altFormat: "Y年m月" })],
      onChange: loadDailyMonth
    });
  } else {
    $("#daily-month").type = "month";
    $("#daily-month").onchange = loadDailyMonth;
  }

  $("#daily-project").onchange = loadDailyMonth;
  $("#export-daily-pdf").onclick = () => download(`/api/reports/daily.pdf?${new URLSearchParams({ projectId: $("#daily-project").value, date: selectedDate }).toString()}`);
  $("#export-daily").onclick = () => download(`/api/export/report.xlsx?${new URLSearchParams({ kind: "daily", projectId: $("#daily-project").value, date: selectedDate }).toString()}`);

  if (settings) {
    $("#save-report-settings").onclick = async () => {
      try {
        const webhookUrl = $("#report-webhook").value.trim();
        const body = {
          sendTime: $("#report-send-time").value,
          deliveryEnabled: $("#report-delivery-enabled").checked,
          clearWebhook: $("#report-clear-webhook").checked
        };
        if (webhookUrl) body.webhookUrl = webhookUrl;
        await api.put("/api/settings/report-delivery", body);
        alert("日报设置已保存并即时生效");
        await renderDaily();
      } catch (error) { alert(error.message); }
    };
    $("#manual-generate-report").onclick = async () => {
      try {
        const date = $("#manual-report-date").value;
        await api.post("/api/reports/daily/generate", { date, projectId: $("#daily-project").value });
        if (dailyMonthPicker) dailyMonthPicker.setDate(date.slice(0, 7), false);
        else $("#daily-month").value = date.slice(0, 7);
        await loadDailyMonth();
        alert("日报快照和 PDF 已生成");
      } catch (error) { alert(error.message); }
    };
  }

  await loadDailyMonth();
}

async function renderProjects() {
  const users = state.user?.role === "ADMIN" ? (await api.get("/api/users")).items : [];
  const hrs = users.filter(u => u.role === "HR");
  const month = today().slice(0, 7);
  const rows = await Promise.all(state.projects.map(async project => {
    const cfg = await api.get(`/api/projects/${project.id}/month-config?month=${month}`);
    const report = await api.get(`/api/reports/cumulative?projectId=${project.id}`);
    const hrNames = state.user?.role === "ADMIN"
      ? hrs.filter(hr => (hr.projectIds || []).includes(project.id)).map(hr => hr.displayName || hr.username)
      : [state.user.displayName || state.user.username];
    return { project, cfg, report, hrNames };
  }));
  $("#view").innerHTML = `
    ${state.user?.role === "ADMIN" ? `
    <section class="panel">
      <h3>新增项目</h3>
      <div class="form-grid">
        <label>项目名称<input id="new-project-name" placeholder="例如：华东客服招聘项目"></label>
        <label>配置月份（年/月）<input id="new-project-month" type="month" data-month-only value="${h(month)}" aria-label="配置月份"></label>
        <label>目标总人数<input id="new-target" type="number" min="0" step="1" value="0"></label>
      </div><br>
      <label>指定HR${hrCheckboxes("create-project-hrs", hrs)}</label><br>
      <button class="primary" id="create-project">创建项目</button>
    </section>` : ""}
    <section class="panel">
      <h3>项目信息</h3>
      <table>
        <thead><tr><th>项目</th><th>状态</th><th>负责HR</th><th>目标总人数</th><th>当前在岗</th><th>剩余缺口</th><th>填写链接</th><th>操作</th></tr></thead>
        <tbody>${rows.map(({ project, cfg, report, hrNames }) => {
          const link = `${location.origin}/h5.html?code=${encodeURIComponent(project.shortCode || project.id)}`;
          return `<tr>
            <td>${h(project.name)}<br><span class="badge">${h(project.shortCode || project.id)}</span></td>
            <td>${project.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge warn">停用</span>'}</td>
            <td>${h(hrNames.join("，") || "未指定")}</td>
            <td>${h(cfg.targetHc || 0)}</td>
            <td>${h(report.metrics.onboardCount || 0)}</td>
            <td>${h(report.metrics.remainingGap || 0)}</td>
            <td><a href="${h(link)}" target="_blank">打开</a> <button data-copy-link="${h(link)}">复制</button></td>
            <td><div class="row-actions"><button data-edit-project="${h(project.id)}">编辑</button>${state.user?.role === "ADMIN" ? `<button class="${project.enabled ? "danger" : ""}" data-toggle-project="${h(project.id)}">${project.enabled ? "删除/停用" : "启用"}</button>` : ""}</div></td>
          </tr>`;
          }).join("") || '<tr><td colspan="8" class="empty">暂无项目</td></tr>'}</tbody>
        </table>
      </section>`;
  bindDateOnlyInputs($("#view"));
  if ($("#create-project")) {
    $("#create-project").onclick = async () => {
      try {
        const name = $("#new-project-name").value.trim();
        if (!name) return alert("请填写项目名称");
        if (!$("#new-project-month").value) return alert("请选择月份");
        if (!Number.isInteger(Number($("#new-target").value)) || Number($("#new-target").value) < 0) return alert("目标总人数必须为非负整数");
        const project = await api.post("/api/projects", { name });
        await api.post(`/api/projects/${project.id}/month-config`, {
          month: $("#new-project-month").value,
          targetHc: $("#new-target").value
        });
        const selected = new Set(checkedProjectIds("create-project-hrs"));
        await Promise.all(hrs.filter(hr => selected.has(hr.id)).map(hr => {
          const next = new Set(hr.projectIds || []);
          next.add(project.id);
          return api.put(`/api/users/${hr.id}`, { projectIds: [...next] });
        }));
        state.projects = (await api.get("/api/projects")).items;
        alert(`项目已创建，填写链接已自动生成：${location.origin}/h5.html?code=${project.shortCode}`);
        renderProjects();
      } catch (err) { alert(err.message); }
    };
  }
  document.querySelectorAll("[data-copy-link]").forEach(btn => btn.onclick = async () => {
    await navigator.clipboard?.writeText(btn.dataset.copyLink);
    alert("链接已复制");
  });
  document.querySelectorAll("[data-edit-project]").forEach(btn => {
    btn.onclick = () => openProjectModal(rows.find(row => row.project.id === btn.dataset.editProject), hrs);
  });
  document.querySelectorAll("[data-toggle-project]").forEach(btn => {
    btn.onclick = async () => {
      const row = rows.find(item => item.project.id === btn.dataset.toggleProject);
      const nextEnabled = !row.project.enabled;
      if (!nextEnabled && !confirm(`确认停用项目「${row.project.name}」吗？停用后候选人无法通过该项目链接提交。`)) return;
      try {
        nextEnabled ? await api.put(`/api/projects/${row.project.id}`, { enabled: true }) : await api.request(`/api/projects/${row.project.id}`, { method: "DELETE" });
        state.projects = (await api.get("/api/projects")).items;
        renderProjects();
      } catch (err) { alert(err.message); }
    };
  });
}

function hrCheckboxes(name, hrs, selectedIds = []) {
  const selected = new Set(selectedIds);
  return `<div class="checkbox-grid">${hrs.map(hr => `
    <label class="check-option">
      <input type="checkbox" name="${h(name)}" value="${h(hr.id)}" ${selected.has(hr.id) ? "checked" : ""}>
      <span>${h(hr.displayName)}（${h(hr.username)}）</span>
    </label>`).join("") || '<div class="empty">暂无HR账号</div>'}</div>`;
}

function openProjectModal(row, hrs) {
  const { project, cfg, report } = row;
  const modal = $("#modal");
  const link = `${location.origin}/h5.html?code=${encodeURIComponent(project.shortCode || project.id)}`;
  const selectedHrIds = hrs.filter(hr => (hr.projectIds || []).includes(project.id)).map(hr => hr.id);
  modal.classList.add("open");
  modal.querySelector("#modal-body").innerHTML = `
    <div class="modal-head"><h3>编辑项目：${h(project.name)}</h3><button id="close-modal">关闭</button></div>
    <div class="form-grid">
      <label>项目名称<input id="edit-project-name" value="${h(project.name)}" ${state.user?.role === "ADMIN" ? "" : "disabled"}></label>
      <label>状态<select id="edit-project-enabled" ${state.user?.role === "ADMIN" ? "" : "disabled"}><option value="true">启用</option><option value="false">停用</option></select></label>
      <label>配置月份（年/月）<input id="edit-project-month" type="month" data-month-only value="${h(cfg.month || today().slice(0, 7))}" aria-label="配置月份"></label>
      <label>目标总人数<input id="edit-target" type="number" min="0" step="1" value="${h(cfg.targetHc || 0)}"></label>
      <label>当前在岗人数<input value="${h(report.metrics.onboardCount || 0)}" disabled></label>
      <label>当前剩余缺口<input value="${h(report.metrics.remainingGap || 0)}" disabled></label>
    </div><br>
    <label>项目填写链接<div class="link-line"><a href="${h(link)}" target="_blank">${h(link)}</a><button id="copy-project-link">复制</button></div></label>
    ${state.user?.role === "ADMIN" ? `<br><label>指定HR${hrCheckboxes("edit-project-hrs", hrs, selectedHrIds)}</label>` : ""}
    <br><button class="primary" id="save-project">保存项目</button>`;
  $("#edit-project-enabled").value = String(Boolean(project.enabled));
  $("#edit-project-month").onchange = async () => {
    try {
      const selectedMonth = $("#edit-project-month").value;
      if (!selectedMonth) return;
      const selectedConfig = await api.get(`/api/projects/${project.id}/month-config?month=${encodeURIComponent(selectedMonth)}`);
      $("#edit-target").value = selectedConfig.targetHc || 0;
    } catch (err) {
      alert(err.message);
    }
  };
  bindDateOnlyInputs(modal);
  $("#close-modal").onclick = () => modal.classList.remove("open");
  $("#copy-project-link").onclick = async () => {
    await navigator.clipboard?.writeText(link);
    alert("链接已复制");
  };
  $("#save-project").onclick = async () => {
    try {
      if (!$("#edit-project-month").value) return alert("请选择月份");
      if (!Number.isInteger(Number($("#edit-target").value)) || Number($("#edit-target").value) < 0) return alert("目标总人数必须为非负整数");
      if (state.user?.role === "ADMIN") {
        const name = $("#edit-project-name").value.trim();
        if (!name) return alert("请填写项目名称");
        await api.put(`/api/projects/${project.id}`, { name, enabled: $("#edit-project-enabled").value === "true" });
        const selected = new Set(checkedProjectIds("edit-project-hrs"));
        await Promise.all(hrs.map(hr => {
          const next = new Set(hr.projectIds || []);
          selected.has(hr.id) ? next.add(project.id) : next.delete(project.id);
          return api.put(`/api/users/${hr.id}`, { projectIds: [...next] });
        }));
      }
      await api.post(`/api/projects/${project.id}/month-config`, {
        month: $("#edit-project-month").value,
        targetHc: $("#edit-target").value
      });
      state.projects = (await api.get("/api/projects")).items;
      modal.classList.remove("open");
      alert("项目已保存");
      renderProjects();
    } catch (err) { alert(err.message); }
  };
}

async function renderUsers() {
  const users = (await api.get("/api/users")).items;
  $("#view").innerHTML = `
    <section class="panel">
      <h3>创建账号</h3>
      <div class="form-grid">
        <label>用户名<input id="u-name" required maxlength="32" pattern="[A-Za-z0-9_]{3,32}" placeholder="3-32位字母、数字或下划线"></label>
        <label>姓名<input id="u-display" required></label>
        <label>密码<input id="u-pass" required minlength="6" value="123456"></label>
        <label>角色<select id="u-role"><option value="HR">HR</option><option value="OPS">运营账号</option></select></label>
        <label>分配项目${projectCheckboxes("create-user-projects")}</label>
      </div><br>
      <button class="primary" id="create-user">创建</button>
    </section>
    <section class="panel">
      <table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>项目</th><th>操作</th></tr></thead>
      <tbody>${users.map(u => `<tr><td>${h(u.username)}</td><td>${h(u.displayName)}</td><td>${h(roleLabel(u.role))}</td><td>${u.enabled ? "启用" : "禁用"}</td><td>${u.role === "OPS" ? "全部项目（只读）" : h((u.projectIds || []).map(projectName).join("，"))}</td><td><div class="row-actions">${u.role === "HR" ? `<button data-edit-user="${h(u.id)}">分配项目</button>` : ""}<button data-password-user="${h(u.id)}">修改密码</button><button data-toggle="${h(u.id)}">${u.enabled ? "禁用" : "启用"}</button>${u.id !== state.user.id ? `<button class="danger" data-delete-user="${h(u.id)}">删除</button>` : ""}</div></td></tr>`).join("")}</tbody></table>
    </section>`;
  const syncProjectAssignment = () => {
    const disabled = $("#u-role").value === "OPS";
    document.querySelectorAll('input[name="create-user-projects"]').forEach(input => {
      input.disabled = disabled;
      if (disabled) input.checked = false;
    });
  };
  $("#u-role").onchange = syncProjectAssignment;
  syncProjectAssignment();
  $("#create-user").onclick = async () => {
    const payload = {
      username: $("#u-name").value.trim(),
      displayName: $("#u-display").value.trim(),
      password: $("#u-pass").value,
      role: $("#u-role").value,
      projectIds: $("#u-role").value === "HR" ? checkedProjectIds("create-user-projects") : []
    };
    const message = validateCreateUserForm(payload);
    if (message) return alert(message);
    try {
      await api.post("/api/users", payload);
      alert("账号已创建");
      renderUsers();
    } catch (err) {
      alert(err.message);
    }
  };
  document.querySelectorAll("[data-toggle]").forEach(btn => btn.onclick = async () => {
    const u = users.find(x => x.id === btn.dataset.toggle);
    await api.put(`/api/users/${u.id}`, { enabled: !u.enabled });
    renderUsers();
  });
  document.querySelectorAll("[data-edit-user]").forEach(btn => btn.onclick = () => openUserProjectModal(users.find(x => x.id === btn.dataset.editUser)));
  document.querySelectorAll("[data-password-user]").forEach(btn => btn.onclick = () => openPasswordModal(users.find(x => x.id === btn.dataset.passwordUser)));
  document.querySelectorAll("[data-delete-user]").forEach(btn => btn.onclick = async () => {
    const target = users.find(x => x.id === btn.dataset.deleteUser);
    if (!confirm(`确认删除账号「${target.displayName}」吗？删除后该账号将无法登录。`)) return;
    try {
      await api.request(`/api/users/${target.id}`, { method: "DELETE" });
      alert("账号已删除");
      renderUsers();
    } catch (err) {
      alert(err.message);
    }
  });
}

function openPasswordModal(user) {
  const modal = $("#modal");
  modal.classList.add("open");
  modal.querySelector("#modal-body").innerHTML = `
    <div class="modal-head"><h3>修改密码：${h(user.displayName)}</h3><button id="close-modal">关闭</button></div>
    <div class="form-grid">
      <label>新密码<input id="new-password" type="password" minlength="6" placeholder="至少6位" required></label>
      <label>确认密码<input id="confirm-password" type="password" minlength="6" placeholder="再次输入新密码" required></label>
    </div><br>
    <button class="primary" id="save-password">保存密码</button>`;
  $("#close-modal").onclick = () => modal.classList.remove("open");
  $("#save-password").onclick = async () => {
    const password = $("#new-password").value;
    const confirmPassword = $("#confirm-password").value;
    if (!password) return alert("请填写新密码");
    if (password.length < 6) return alert("密码至少6位");
    if (password !== confirmPassword) return alert("两次输入的密码不一致");
    try {
      await api.put(`/api/users/${user.id}`, { password });
      modal.classList.remove("open");
      alert("密码已修改");
      renderUsers();
    } catch (err) {
      alert(err.message);
    }
  };
}

function openUserProjectModal(user) {
  const modal = $("#modal");
  modal.classList.add("open");
  modal.querySelector("#modal-body").innerHTML = `
    <div class="modal-head"><h3>分配项目：${h(user.displayName)}</h3><button id="close-modal">关闭</button></div>
    <label>负责项目${projectCheckboxes("edit-user-projects", user.projectIds || [])}</label><br>
    <button class="primary" id="save-user-projects">保存</button>`;
  $("#close-modal").onclick = () => modal.classList.remove("open");
  $("#save-user-projects").onclick = async () => {
    try {
      await api.put(`/api/users/${user.id}`, { projectIds: checkedProjectIds("edit-user-projects") });
      modal.classList.remove("open");
      renderUsers();
    } catch (err) {
      alert(err.message);
    }
  };
}

function validateCreateUserForm(data) {
  if (!data.username) return "请填写用户名";
  if (!/^[A-Za-z0-9_]{3,32}$/.test(data.username)) return "用户名需为3-32位字母、数字或下划线";
  if (!data.displayName) return "请填写姓名";
  if (!data.password) return "请填写密码";
  if (data.password.length < 6) return "密码至少6位";
  if (!["HR", "OPS"].includes(data.role)) return "请选择正确的角色";
  if (data.role === "HR" && !data.projectIds.length) return "创建HR账号至少分配一个项目";
  return "";
}

async function renderLogs() {
  const logs = await api.get("/api/logs");
  $("#view").innerHTML = `<section class="panel"><h3>审计日志</h3><pre>${h(JSON.stringify(logs, null, 2))}</pre></section>`;
}

boot();
