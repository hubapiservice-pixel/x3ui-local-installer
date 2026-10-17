const form = document.querySelector("#install-form");
const button = document.querySelector("#install-button");
const recoverButton = document.querySelector("#recover-button");
const removeButton = document.querySelector("#remove-button");
const resumeButton = document.querySelector("#resume-button");
const status = document.querySelector("#status");
const logs = document.querySelector("#logs");
const title = document.querySelector("#status-title");
const result = document.querySelector("#result");
const clientFeedback = document.querySelector("#client-feedback");
const shell = document.querySelector(".app-shell");
const emptyOutput = document.querySelector("#empty-output");
const outputBadge = document.querySelector("#output-badge");
const logDetails = document.querySelector("#log-details");
const clientDialog = document.querySelector("#client-dialog");
const removeDialog = document.querySelector("#remove-dialog");
const probeDialog = document.querySelector("#probe-dialog");
const createAdminUser = form.elements.namedItem("createAdminUser");
const grantSudo = form.elements.namedItem("grantSudo");
const disableRootSsh = form.elements.namedItem("disableRootSsh");
const adminUsername = form.elements.namedItem("adminUsername");
const adminPassword = form.elements.namedItem("adminPassword");
let accessCode = "";
let currentMode = "install";
let isOffline = false;
const lastJobKey = "x3ui-last-job";

fetch("api/edition", { cache: "no-store" }).then((response) => response.json()).then((data) => {
  if (data.edition !== "offline") return;
  isOffline = true;
  document.querySelector("#open-probe").classList.remove("hidden");
  document.title = "X3-UI 本地安装器";
  document.querySelector("#edition-badge").textContent = "本地版";
  document.querySelector("#online-auth").classList.add("hidden");
  document.querySelector("#offline-note").classList.remove("hidden");
  document.querySelector("#ios-offline-note").classList.remove("hidden");
  button.textContent = "上传并安装 3X-UI";
}).catch(() => {});

function updateSecurityControls() {
  grantSudo.disabled = !createAdminUser.checked;
  if (grantSudo.disabled) grantSudo.checked = false;
  disableRootSsh.disabled = !grantSudo.checked;
  if (disableRootSsh.disabled) disableRootSsh.checked = false;
  adminUsername.disabled = !createAdminUser.checked;
  adminPassword.disabled = !createAdminUser.checked;
  adminUsername.required = createAdminUser.checked;
  adminPassword.required = createAdminUser.checked;
}
createAdminUser.addEventListener("change", updateSecurityControls);
grantSudo.addEventListener("change", updateSecurityControls);
updateSecurityControls();

function showView(view) {
  shell.dataset.mobileView = view;
  document.querySelectorAll(".mobile-nav button").forEach((tab) => {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
}

document.querySelectorAll(".mobile-nav button").forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});
document.querySelector("#open-clients").addEventListener("click", () => clientDialog.showModal());
document.querySelector("#close-clients").addEventListener("click", () => clientDialog.close());

function savedJob() {
  try {
    const job = JSON.parse(sessionStorage.getItem(lastJobKey) || "null");
    if (job && /^[a-f0-9-]{36}$/.test(job.id) && Date.now() - job.createdAt < 30 * 60 * 1000) return job;
    sessionStorage.removeItem(lastJobKey);
  } catch {}
  return null;
}

resumeButton.classList.toggle("hidden", !savedJob());

function fill(id, value) {
  document.querySelector(id).textContent = value || "未返回";
}

async function poll(id, failures = 0) {
  let response;
  try {
    response = await fetch(`api/jobs/${id}`, {
      cache: "no-store",
      headers: accessCode ? { "x-x3ui-access": accessCode } : {}
    });
  } catch (error) {
    if (failures >= 18) throw error;
    title.textContent = "连接暂时中断，正在重试";
    setTimeout(() => poll(id, failures + 1).catch(showError), Math.min(2000 + failures * 1000, 10000));
    return;
  }
  const job = await response.json();
  if (!response.ok) {
    if (response.status === 404) {
      sessionStorage.removeItem(lastJobKey);
      resumeButton.classList.add("hidden");
    }
    throw new Error(job.error || "读取任务状态失败。");
  }
  logs.textContent = job.logs.join("\n");
  logs.scrollTop = logs.scrollHeight;
  if (job.state === "running") {
    setTimeout(() => poll(id).catch(showError), 1200);
    return;
  }
  button.disabled = false;
  recoverButton.disabled = false;
  removeButton.disabled = false;
  currentMode = job.kind || "install";
  if (job.state === "failed") return showError(new Error(job.error));
  if (job.kind === "remove") {
    if (!job.result?.removed) throw new Error("移除结果尚未返回，请读取任务日志。");
    document.querySelector("#status-dot").style.background = "#2f8a53";
    title.textContent = "3X-UI 已移除";
    outputBadge.textContent = "已移除";
    logDetails.open = false;
    document.querySelector("#remove-result").classList.remove("hidden");
    fill("#removed-service", job.result.service);
    fill("#removed-sha", job.result.backupSha256);
    fill("#removed-backup", job.result.backupPath);
    showView("output");
    return;
  }
  if (!job.result?.panel) throw new Error("安装结果尚未返回，请使用找回安装结果。");
  document.querySelector("#status-dot").style.background = job.state === "partial" ? "#e2a82e" : "#2f8a53";
  title.textContent = job.state === "partial" ? "安装部分完成，请检查回执" : "服务端安装完成";
  outputBadge.textContent = job.state === "partial" ? "部分完成" : "已完成";
  logDetails.open = false;
  result.classList.remove("hidden");
  fill("#service-state", job.result.service);
  const release = job.result.panel.releaseVersion;
  const core = job.result.panel.coreVersion;
  fill("#installed-version", release && core ? `3X-UI ${release} / Xray ${core}` : "已有实例，版本未记录");
  const panel = document.querySelector("#panel-url");
  panel.textContent = job.result.panel.panelUrl || "未返回，请在服务器执行 x-ui 查看";
  panel.href = job.result.panel.panelUrl || "#";
  document.querySelector("#panel-security-note").textContent = job.result.panel.tls === "self-signed"
    ? "面板已强制 HTTPS（自签名证书）。首次打开会有浏览器证书警告；核对目标 IP 和证书后再继续。若需无警告访问，请为目标服务器配置受信任证书。"
    : panel.href.startsWith("https://")
      ? "面板使用 HTTPS。节点是否能从本机连通仍需单独测试。"
      : "此实例原先使用 HTTP。输入面板密码前，请先在面板配置 HTTPS 或通过 SSH 隧道访问。";
  fill("#panel-user", job.result.panel.username);
  fill("#panel-password", job.result.panel.password);
  fill("#inbounds", job.result.inbounds);
  const securityResult = document.querySelector("#security-result");
  securityResult.classList.toggle("hidden", !job.result.security);
  if (job.result.security) {
    fill("#security-user", job.result.security.username);
    fill("#security-login", job.result.security.login);
    fill("#security-sudo", job.result.security.sudo);
    fill("#security-root", job.result.security.rootSsh);
  }
  const nodeResult = document.querySelector("#node-result");
  nodeResult.classList.toggle("hidden", !job.result.node?.link);
  if (job.result.node?.link) {
    fill("#node-link", job.result.node.link);
    document.querySelector("#node-link").title = job.result.node.link;
    clientFeedback.textContent = "";
  }
  if (job.state === "partial") logs.textContent += `\n\n${job.error}`;
  showView("output");
}

document.querySelector("#copy-node").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.querySelector("#node-link").textContent);
  clientFeedback.textContent = "节点链接已复制。";
});

document.querySelector("#open-probe").addEventListener("click", () => {
  document.querySelector("#probe-link").value = document.querySelector("#node-link").textContent || "";
  document.querySelector("#probe-feedback").textContent = "";
  probeDialog.showModal();
});
document.querySelector("#close-probe").addEventListener("click", () => probeDialog.close());
document.querySelector("#probe-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const run = document.querySelector("#run-probe");
  const feedback = document.querySelector("#probe-feedback");
  run.disabled = true;
  feedback.textContent = "正在从本机建立连接并请求测试页面…";
  try {
    const response = await fetch("api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        link: document.querySelector("#probe-link").value.trim(),
        networkInterface: document.querySelector("#probe-interface").value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "本机测试失败。");
    feedback.textContent = `端到端请求通过 · HTTP ${data.httpStatus} · 出口 ${data.egressIp || "未返回"} · ${data.networkInterface} · ${data.durationMs} ms`;
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    run.disabled = false;
  }
});

function buildClashConfig(link) {
  const node = new URL(link);
  const port = Number(node.port);
  const query = node.searchParams;
  if (node.protocol !== "vless:" || !/^[a-f0-9-]{36}$/i.test(node.username) ||
      !node.hostname || !Number.isInteger(port) || port < 1 || port > 65535 ||
      query.get("security") !== "reality" || query.get("type") !== "tcp" ||
      !query.get("sni") || !query.get("pbk") || !query.get("fp")) {
    throw new Error("节点不是可转换的 VLESS + REALITY TCP 链接。");
  }
  const name = `X3UI ${node.hostname}`;
  const value = (text) => JSON.stringify(text);
  return [
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: warning",
    "proxies:",
    `  - name: ${value(name)}`,
    "    type: vless",
    `    server: ${value(node.hostname)}`,
    `    port: ${port}`,
    `    uuid: ${value(node.username)}`,
    "    network: tcp",
    "    tls: true",
    "    udp: true",
    "    encryption: \"\"",
    `    servername: ${value(query.get("sni"))}`,
    `    client-fingerprint: ${value(query.get("fp"))}`,
    "    reality-opts:",
    `      public-key: ${value(query.get("pbk"))}`,
    `      short-id: ${value(query.get("sid") || "")}`,
    ...(query.get("flow") ? [`    flow: ${value(query.get("flow"))}`] : []),
    "proxy-groups:",
    "  - name: Proxy",
    "    type: select",
    "    proxies:",
    `      - ${value(name)}`,
    "      - DIRECT",
    "rules:",
    "  - MATCH,Proxy",
    ""
  ].join("\n");
}

document.querySelector("#download-clash").addEventListener("click", () => {
  try {
    const link = document.querySelector("#node-link").textContent;
    const yaml = buildClashConfig(link);
    const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `x3ui-clash-${new URL(link).hostname}.yaml`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    clientFeedback.textContent = "Clash 配置已在本机生成。";
  } catch (error) {
    clientFeedback.textContent = error.message;
  }
});

function showError(error) {
  button.disabled = false;
  recoverButton.disabled = false;
  removeButton.disabled = false;
  emptyOutput.classList.add("hidden");
  status.classList.remove("hidden");
  logDetails.open = true;
  document.querySelector("#status-dot").style.background = "#d84646";
  title.textContent = currentMode === "remove" ? "移除未完成" : "安装未完成";
  outputBadge.textContent = "需处理";
  logs.textContent += `\n\n错误：${error.message}`;
  showView("output");
}

async function start(mode) {
  const actionInput = form.elements.namedItem("actionCode");
  actionInput.required = !isOffline && (mode === "remove" || createAdminUser.checked);
  if (mode === "remove") {
    for (const name of ["accessCode", "actionCode", "host", "port", "username", "password"]) {
      if (!form.elements.namedItem(name).reportValidity()) return;
    }
  } else if (!form.reportValidity()) return;
  currentMode = mode;
  button.disabled = true;
  recoverButton.disabled = true;
  removeButton.disabled = true;
  emptyOutput.classList.add("hidden");
  status.classList.remove("hidden");
  result.classList.add("hidden");
  document.querySelector("#remove-result").classList.add("hidden");
  document.querySelector("#security-result").classList.add("hidden");
  logDetails.open = true;
  document.querySelector("#status-dot").style.background = "#e2a82e";
  outputBadge.textContent = "进行中";
  logs.textContent = "正在创建受控安装任务。";
  title.textContent = mode === "remove" ? "正在备份并移除" : mode === "recover" ? "正在补建节点" : "正在安装";
  showView("output");
  try {
    const payload = Object.fromEntries(new FormData(form));
    if (mode === "remove") {
      delete payload.createAdminUser;
      delete payload.grantSudo;
      delete payload.disableRootSsh;
      delete payload.adminUsername;
      delete payload.adminPassword;
      payload.confirmAction = "remove-managed-x3ui";
      payload.confirmHost = payload.host.trim();
    }
    accessCode = payload.accessCode || "";
    const response = await fetch(`api/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法创建安装任务。");
    try {
      sessionStorage.setItem(lastJobKey, JSON.stringify({ id: data.id, createdAt: Date.now() }));
      resumeButton.classList.remove("hidden");
    } catch {}
    form.elements.namedItem("accessCode").value = "";
    actionInput.value = "";
    form.elements.namedItem("password").value = "";
    adminPassword.value = "";
    await poll(data.id);
  } catch (error) {
    showError(error);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void start("install");
});
recoverButton.addEventListener("click", () => { void start("recover"); });
removeButton.addEventListener("click", () => {
  form.elements.namedItem("actionCode").required = !isOffline;
  for (const name of ["accessCode", "actionCode", "host", "port", "username", "password"]) {
    if (!form.elements.namedItem(name).reportValidity()) return;
  }
  document.querySelector("#remove-target").textContent = form.elements.namedItem("host").value.trim();
  removeDialog.showModal();
});
document.querySelector("#cancel-remove").addEventListener("click", () => removeDialog.close());
document.querySelector("#confirm-remove").addEventListener("click", () => {
  removeDialog.close();
  void start("remove");
});
resumeButton.addEventListener("click", () => {
  const job = savedJob();
  if (!job) {
    resumeButton.classList.add("hidden");
    return showError(new Error("上次任务已过期，请使用找回安装结果。"));
  }
  const accessInput = form.elements.namedItem("accessCode");
  accessCode = accessInput.value;
  accessInput.value = "";
  emptyOutput.classList.add("hidden");
  status.classList.remove("hidden");
  result.classList.add("hidden");
  document.querySelector("#remove-result").classList.add("hidden");
  document.querySelector("#security-result").classList.add("hidden");
  logDetails.open = true;
  logs.textContent = "正在读取上次任务。";
  title.textContent = "正在读取结果";
  outputBadge.textContent = "读取中";
  button.disabled = true;
  recoverButton.disabled = true;
  removeButton.disabled = true;
  showView("output");
  void poll(job.id).catch(showError);
});
