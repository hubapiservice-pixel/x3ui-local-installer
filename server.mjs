import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Client } from "ssh2";
import { applySecurity, securityInput } from "./security.mjs";
import { REMOVE_SCRIPT, parseRemoveResult } from "./remove.mjs";
import { parseProbeInput, probeVlessReality, PROBE_XRAY_SHA256 } from "./probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const jobs = new Map();
const sudoConnections = new WeakMap();
const MAX_LOG_LINES = 240;
const MIRROR_BASE_URL = process.env.X3UI_MIRROR_BASE_URL || "http://193.134.210.145:18086/v3.9.0-xray-26.3.27";
const OFFLINE_MODE = process.env.X3UI_OFFLINE === "1";
const APP_INSTANCE = process.env.X3UI_APP_INSTANCE || "";
const OFFLINE_RELEASE_DIR = path.join(__dirname, "offline-assets", "release");
const OFFLINE_BOOTSTRAP = path.join(__dirname, "release", "offline-v3.9.0-xray-26.3.27", "bootstrap.sh");
const ONLINE_BOOTSTRAP = path.join(__dirname, "release", "v3.9.0-xray-26.3.27", "bootstrap.sh");
const PROBE_XRAY_BIN = path.join(__dirname, "offline-assets", "tools", "xray-macos-arm64");
const OFFLINE_FILES = {
  x86_64: [
    ["x-ui-linux-amd64.tar.gz", "d7cbe0bf6358ee0d2117c24fd2efb483502e411d38e2ea59bd0bf5e7a3e39390"],
    ["xray-linux-amd64", "8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed"]
  ],
  aarch64: [
    ["x-ui-linux-arm64.tar.gz", "9a2e43c976a2e71618a30d8f38b52476b25ed363c6989599e2f625cc52f51a81"],
    ["xray-linux-arm64", "c2d20a7045250497083afea0d79db0672f6c89a25aaaf37c92de034d6b764b04"]
  ]
};
const ACCESS_PASSWORD = process.env.X3UI_WEB_ACCESS_PASSWORD || "";
const ADMIN_ACTION_PASSWORD = process.env.X3UI_ADMIN_ACTION_PASSWORD || "";
const MAX_ACTIVE_JOBS = 2;
let probeRunning = false;

if (process.env.X3UI_REQUIRE_ACCESS === "1" && !ACCESS_PASSWORD) {
  throw new Error("X3UI_REQUIRE_ACCESS=1 时必须设置 X3UI_WEB_ACCESS_PASSWORD。");
}

app.disable("x-powered-by");
if (OFFLINE_MODE) app.use((req, res, next) => {
  if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.get("host") || "")) {
    return res.status(403).end();
  }
  next();
});
app.use(express.json({ limit: "16kb" }));
if (OFFLINE_MODE) app.use("/downloads", express.static(path.join(__dirname, "offline-assets", "clients")));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function hasAccess(req) {
  if (!ACCESS_PASSWORD) return true;
  const supplied = String(req.get("x-x3ui-access") || req.body?.accessCode || "");
  const expected = Buffer.from(ACCESS_PASSWORD);
  const received = Buffer.from(supplied);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function requireAccess(req, res, next) {
  if (hasAccess(req)) return next();
  return res.status(401).json({ error: "页面访问密码不正确。" });
}

function hasAdminAction(req) {
  if (ADMIN_ACTION_PASSWORD.length < 16) return false;
  const expected = Buffer.from(ADMIN_ACTION_PASSWORD);
  const received = Buffer.from(String(req.body?.actionCode || ""));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function safeHost(value) {
  const host = String(value || "").trim();
  if (net.isIP(host) !== 4) throw new Error("请输入服务器的公网 IPv4 地址。");
  const [a, b, c] = host.split(".").map(Number);
  const reserved = a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
  if (reserved) throw new Error("仅支持公网 IPv4 服务器。");
  return host;
}

function installInput(body) {
  const host = safeHost(body.host);
  const port = Number(body.port || 22);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 端口必须在 1 到 65535 之间。");
  if (!username || /[\s/$`\\]/.test(username)) throw new Error("SSH 用户名格式不正确。");
  if (!password) throw new Error("请输入 SSH 密码。");
  return { host, port, username, password };
}

function pushLog(job, line) {
  const clean = String(line || "")
    .replace(/(password|passwd|token|secret)\s*[:=]\s*\S+/gi, "$1=[已隐藏]")
    .trim();
  if (!clean) return;
  job.logs.push(clean);
  if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadOfflineRelease(conn, job) {
  const arch = await execRemote(conn, "uname -m");
  const machine = arch.stdout.trim();
  const files = OFFLINE_FILES[machine === "amd64" ? "x86_64" : machine === "arm64" ? "aarch64" : machine];
  if (arch.code !== 0 || !files) throw new Error(`不支持的目标架构：${machine || "未知"}。`);
  const localFiles = [["bootstrap.sh", OFFLINE_BOOTSTRAP, await fileSha256(OFFLINE_BOOTSTRAP)], ...files.map(([name, sha]) => [name, path.join(OFFLINE_RELEASE_DIR, name), sha])];
  for (const [name, file, expected] of localFiles) {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || await fileSha256(file) !== expected) {
      throw new Error(`本地发行包缺失或校验失败：${name}。`);
    }
  }

  const staging = await execRemote(conn, "mktemp -d /tmp/x3ui-offline.XXXXXXXX");
  const remoteDir = staging.stdout.trim();
  if (staging.code !== 0 || !/^\/tmp\/x3ui-offline\.[A-Za-z0-9]+$/.test(remoteDir)) {
    throw new Error("无法在目标机创建安全的临时上传目录。");
  }
  pushLog(job, `目标架构 ${machine}；正在上传固定发行包。`);
  try {
    const sftp = await new Promise((resolve, reject) => conn.sftp((error, session) => error ? reject(error) : resolve(session)));
    try {
      for (const [name, file, expected] of localFiles) {
        const remote = `${remoteDir}/${name}`;
        await new Promise((resolve, reject) => sftp.fastPut(file, remote, (error) => error ? reject(error) : resolve()));
        const verify = await execRemote(conn, `printf '%s  %s\\n' ${shellQuote(expected)} ${shellQuote(remote)} | sha256sum -c -`);
        if (verify.code !== 0) throw new Error(`目标机上传校验失败：${name}。`);
        pushLog(job, `已上传并校验 ${name}。`);
      }
    } finally {
      sftp.end();
    }
    return remoteDir;
  } catch (error) {
    pushLog(job, "上传未完成，目标机临时文件已保留以供检查；没有执行安装。");
    throw error;
  }
}

async function uploadOnlineBootstrap(conn, job) {
  const expected = await fileSha256(ONLINE_BOOTSTRAP);
  const staging = await execRemote(conn, "mktemp -d /tmp/x3ui-online.XXXXXXXX");
  const remoteDir = staging.stdout.trim();
  if (staging.code !== 0 || !/^\/tmp\/x3ui-online\.[A-Za-z0-9]+$/.test(remoteDir)) {
    throw new Error("无法在目标机创建安全的临时上传目录。");
  }
  const remote = `${remoteDir}/bootstrap.sh`;
  const sftp = await new Promise((resolve, reject) => conn.sftp((error, session) => error ? reject(error) : resolve(session)));
  try {
    await new Promise((resolve, reject) => sftp.fastPut(ONLINE_BOOTSTRAP, remote, (error) => error ? reject(error) : resolve()));
  } finally {
    sftp.end();
  }
  const verify = await execRemote(conn, `printf '%s  %s\\n' ${shellQuote(expected)} ${shellQuote(remote)} | sha256sum -c -`);
  if (verify.code !== 0) throw new Error("在线安装脚本上传校验失败；没有执行安装。");
  pushLog(job, "已上传并校验当前在线安装脚本。");
  return remoteDir;
}

function connectSsh(input, expectedHostKey) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on("ready", () => {
      settled = true;
      resolve(conn);
    });
    conn.on("error", (error) => {
      if (!settled) reject(error);
    });
    conn.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      hostVerifier: (key) => {
        const received = Buffer.from(key);
        if (expectedHostKey && (received.length !== expectedHostKey.length || !crypto.timingSafeEqual(received, expectedHostKey))) return false;
        conn.x3uiHostKey = received;
        return true;
      }
    });
  });
}

function runSsh(input, onReady) {
  return connectSsh(input).then((conn) => new Promise((resolve, reject) => onReady(conn, resolve, reject)));
}

function execRemote(conn, command, onData = () => {}, stdin = null) {
  const sudoPassword = sudoConnections.get(conn);
  if (sudoPassword) {
    command = `sudo -k -S -p '' -i sh -c ${shellQuote(command)}`;
    stdin = `${sudoPassword}\n`;
  }
  return new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        onData(text);
      });
      stream.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        onData(text);
      });
      stream.on("close", (code) => resolve({ code, stdout, stderr }));
      if (stdin !== null) stream.end(stdin);
    });
  });
}

function parseInstallResult(output, host) {
  const allow = new Set([
    "PANEL_URL", "PANEL_PORT", "PANEL_PATH", "PANEL_USERNAME", "PANEL_PASSWORD",
    "XUI_PORT", "XUI_WEBBASEPATH", "XUI_USERNAME", "XUI_PASSWORD", "USERNAME", "PASSWORD",
    "X3UI_RELEASE_VERSION", "X3UI_CORE_VERSION", "PANEL_TLS"
  ]);
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allow.has(match[1])) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  const port = values.PANEL_PORT || values.XUI_PORT;
  const webPath = values.PANEL_PATH || values.XUI_WEBBASEPATH || "";
  const normalizedPath = webPath ? `/${webPath.replace(/^\/+|\/+$/g, "")}` : "";
  return {
    panelUrl: values.PANEL_URL || (port ? `http://${host}:${port}${normalizedPath}` : null),
    username: values.PANEL_USERNAME || values.XUI_USERNAME || values.USERNAME || null,
    password: values.PANEL_PASSWORD || values.XUI_PASSWORD || values.PASSWORD || null,
    tls: values.PANEL_TLS || (values.PANEL_URL?.startsWith("https://") ? "configured" : "none"),
    releaseVersion: values.X3UI_RELEASE_VERSION || null,
    coreVersion: values.X3UI_CORE_VERSION || null
  };
}

async function panelRequest(conn, panel, route, { method = "GET", body, cookie, csrf } = {}) {
  const address = new URL(panel.panelUrl);
  const url = `${address.origin}${address.pathname.replace(/\/+$/, "")}${route}`;
  const args = ["curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "15", "--dump-header", "-", "--write-out", "\\n__HTTP_STATUS__=%{http_code}", "--request", method];
  args.push("--resolve", `${address.hostname}:${address.port || (address.protocol === "https:" ? 443 : 80)}:127.0.0.1`);
  if (address.protocol === "https:" && panel.tls === "self-signed") args.push("--cacert", "/etc/x-ui/panel.crt");
  if (body) args.push("--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  if (cookie) args.push("--header", `Cookie: ${cookie}`);
  if (csrf) args.push("--header", `X-CSRF-Token: ${csrf}`);
  args.push(url);
  const response = await execRemote(conn, args.map(shellQuote).join(" "));
  if (response.code !== 0) throw new Error("面板本机 API 连接失败。");
  const match = response.stdout.match(/\n__HTTP_STATUS__=(\d{3})\s*$/);
  if (!match) throw new Error("面板 API 未返回 HTTP 状态。");
  const raw = response.stdout.slice(0, match.index);
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("面板 API 响应格式不正确。");
  const headers = raw.slice(0, separator);
  let data;
  try {
    data = JSON.parse(raw.slice(separator + 4));
  } catch {
    throw new Error("面板 API 未返回有效 JSON。");
  }
  if (Number(match[1]) >= 400 || data.success !== true) {
    throw new Error(`面板 API ${route} 请求失败：${data.msg || match[1]}`);
  }
  return { data, cookie: headers.match(/^set-cookie:\s*([^;\r\n]+)/im)?.[1] };
}

function jsonObject(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function nodeFromInbound(inbound, host) {
  const settings = jsonObject(inbound.settings);
  const stream = jsonObject(inbound.streamSettings);
  const reality = stream?.realitySettings;
  const client = settings?.clients?.[0];
  const privateBytes = Buffer.from(reality?.privateKey || "", "base64url");
  if (inbound.protocol !== "vless" || stream?.security !== "reality" ||
      !client?.id || !reality?.serverNames?.[0] || !reality?.shortIds?.[0] || privateBytes.length !== 32) {
    throw new Error("入站配置不完整，无法生成经核对的节点链接。");
  }
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), privateBytes]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const query = new URLSearchParams({ encryption: "none", flow: client.flow || "xtls-rprx-vision", security: "reality", sni: reality.serverNames[0], fp: "chrome", pbk: publicKey, sid: reality.shortIds[0], type: "tcp", spx: "/" });
  return { port: inbound.port, link: `vless://${client.id}@${host}:${inbound.port}?${query}#${encodeURIComponent(inbound.remark)}` };
}

async function createRealityNode(conn, panel, host) {
  let initialCsrf;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      initialCsrf = await panelRequest(conn, panel, "/csrf-token");
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!initialCsrf.cookie || typeof initialCsrf.data.obj !== "string") {
    throw new Error("面板未返回登录前的 CSRF 令牌和会话 Cookie。");
  }
  const login = await panelRequest(conn, panel, "/login", {
    method: "POST",
    body: { username: panel.username, password: panel.password },
    cookie: initialCsrf.cookie,
    csrf: initialCsrf.data.obj
  });
  const sessionCookie = login.cookie || initialCsrf.cookie;
  const csrf = await panelRequest(conn, panel, "/csrf-token", { cookie: sessionCookie });
  if (typeof csrf.data.obj !== "string" || !csrf.data.obj) throw new Error("面板未返回 CSRF 令牌。");

  const remark = `X3UI-${host}`;
  const session = { cookie: csrf.cookie || sessionCookie, csrf: csrf.data.obj };
  const existing = await panelRequest(conn, panel, "/panel/api/inbounds/list", session);
  if (!Array.isArray(existing.data.obj)) throw new Error("无法读取现有入站列表，未继续创建。");
  const previous = existing.data.obj.find((inbound) => inbound.remark === remark);
  if (previous) {
    const readback = await panelRequest(conn, panel, `/panel/api/inbounds/get/${previous.id}`, session);
    const node = nodeFromInbound(readback.data.obj, host);
    const listening = await execRemote(conn, `ss -ltnH 'sport = :${node.port}'`);
    if (!listening.stdout.trim()) throw new Error("已有节点未监听，请检查 Xray 状态。");
    return node;
  }

  const portCheck = await execRemote(conn, "command -v ss >/dev/null || exit 1; for port in 443 8443; do if ! ss -ltnH \"sport = :$port\" | grep -q .; then printf '%s' \"$port\"; break; fi; done");
  const port = Number(portCheck.stdout.trim());
  if (portCheck.code !== 0 || ![443, 8443].includes(port)) throw new Error("443 和 8443 端口都不可用，未创建节点。");

  const keys = crypto.generateKeyPairSync("x25519");
  const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url");
  const clientId = crypto.randomUUID();
  const shortId = crypto.randomBytes(8).toString("hex");
  const sni = "www.cloudflare.com";
  const payload = {
    enable: true, remark, listen: "", port, protocol: "vless", expiryTime: 0, total: 0,
    settings: { clients: [{ id: clientId, email: `client-${shortId}`, flow: "xtls-rprx-vision", enable: true }], decryption: "none", fallbacks: [] },
    streamSettings: { network: "tcp", security: "reality", tcpSettings: {}, realitySettings: { show: false, dest: `${sni}:443`, xver: 0, serverNames: [sni], privateKey, shortIds: [shortId] } },
    sniffing: { enabled: true, destOverride: ["http", "tls"] }
  };
  const added = await panelRequest(conn, panel, "/panel/api/inbounds/add", { method: "POST", body: payload, ...session });
  const inboundId = added.data.obj?.id;
  if (!Number.isInteger(inboundId)) throw new Error("面板未返回新入站 ID，请在面板核对是否已创建，避免重复添加。");
  const readback = await panelRequest(conn, panel, `/panel/api/inbounds/get/${inboundId}`, session);
  if (readback.data.obj?.port !== port || readback.data.obj?.protocol !== "vless") {
    throw new Error("新入站的面板读回校验失败。");
  }
  const listening = await execRemote(conn, `ss -ltnH 'sport = :${port}'`);
  if (!listening.stdout.trim()) throw new Error("节点已写入面板，但端口未监听，请检查 Xray 和防火墙。");
  return nodeFromInbound(readback.data.obj, host);
}

async function readPanelResult(conn, host) {
  const report = await execRemote(conn, "systemctl is-active x-ui 2>/dev/null; printf '\n---RESULT---\n'; test -f /etc/x-ui/install-result.env && cat /etc/x-ui/install-result.env || true");
  const [serviceState, envText = ""] = report.stdout.split("---RESULT---");
  const panel = parseInstallResult(envText, host);
  if (serviceState.trim() !== "active" || !panel.panelUrl || !panel.username || !panel.password) {
    throw new Error("面板服务未运行或安装回执不完整，请检查目标机上的 x-ui 服务。");
  }
  return { service: "active", panel, inbounds: "尚未创建节点。", node: null };
}

async function isManagedInstall(conn) {
  const check = await execRemote(conn, "test \"$(id -u)\" = 0 && test -f /etc/x3ui-bootstrap/managed.env && grep -qx X3UI_BOOTSTRAP_MANAGED=1 /etc/x3ui-bootstrap/managed.env && test -f /etc/x-ui/install-result.env");
  return check.code === 0;
}

async function finishWithNode(job, conn, host) {
  pushLog(job, "面板已核验，正在创建 VLESS + REALITY 节点。");
  try {
    job.result.node = await createRealityNode(conn, job.result.panel, host);
    job.result.inbounds = `VLESS + REALITY 入站已创建，端口 ${job.result.node.port} 正在监听。`;
    job.state = "succeeded";
    pushLog(job, "面板和节点均已通过读回校验。");
  } catch (error) {
    job.state = "partial";
    job.error = `面板已安装，但节点创建未完成：${error.message}`;
    pushLog(job, job.error);
  }
}

async function finishSecurity(job, conn, input, security) {
  if (!security.enabled) return;
  if (job.state !== "succeeded") {
    job.result.security = { username: security.username, login: "未执行", sudo: "未执行", rootSsh: "保持启用" };
    pushLog(job, "节点未完成，已跳过 SSH 安全设置，root SSH 保持启用。");
    return;
  }
  pushLog(job, `正在设置管理员 ${security.username} 并验证独立 SSH 登录。`);
  try {
    job.result.security = await applySecurity(conn, input, security, {
      exec: (client, command, stdin) => execRemote(client, command, () => {}, stdin),
      connect: connectSsh,
      log: (line) => pushLog(job, line)
    });
  } catch (error) {
    job.state = "partial";
    job.error = `面板和节点已安装，但 SSH 安全设置未完成：${error.message}`;
    job.result.security = error.securityReport || {
      username: security.username, login: "未完成", sudo: "未完成", rootSsh: "保持启用"
    };
    pushLog(job, job.error);
  }
}

async function install(job, input, security) {
  let conn;
  try {
    pushLog(job, "正在建立 SSH 连接。");
    await runSsh(input, async (client, resolve, reject) => {
      conn = client;
      try {
        const identity = await execRemote(conn, "id -u");
        if (identity.code !== 0 || identity.stdout.trim() !== "0") {
          throw new Error("此版本仅支持 root SSH 登录。请使用 root，或后续版本启用受控 sudo 支持。");
        }
        const preflight = await execRemote(conn, [
          "set -eu",
          "for path in /usr/local/x-ui /usr/bin/x-ui /etc/systemd/system/x-ui.service /etc/x-ui; do test ! -e \"$path\" || { echo EXISTING_3XUI=1; exit 9; }; done",
          "if command -v ss >/dev/null 2>&1 && ss -ltnH 'sport = :2053' | grep -q .; then echo PANEL_PORT_IN_USE=2053; exit 10; fi"
        ].join("; "));
        if (preflight.code === 9) {
          if (!await isManagedInstall(conn)) {
            throw new Error("目标服务器已有 3X-UI 相关文件，已拒绝覆盖。请先在该服务器完成备份或使用其现有面板。");
          }
          pushLog(job, "检测到本安装器已安装的实例，正在读取现有面板和节点，不会重复安装。");
          job.result = await readPanelResult(conn, input.host);
          await finishWithNode(job, conn, input.host);
          await finishSecurity(job, conn, input, security);
          conn.end();
          resolve();
          return;
        }
        if (preflight.code === 10) throw new Error("目标服务器的面板端口 2053 已被占用，已停止安装，未做任何改动。");
        if (preflight.code !== 0) throw new Error("目标服务器的安装前检查失败，请查看 SSH 环境和端口状态。");

        pushLog(job, OFFLINE_MODE
          ? "已验证 root 权限和空白安装环境，开始上传本地固定发行包。"
          : "已验证 root 权限和空白安装环境，开始从自有固定镜像安装 3X-UI v3.9.0 + Xray 26.3.27。");
        let installer;
        let remoteDir;
        if (OFFLINE_MODE) {
          remoteDir = await uploadOfflineRelease(conn, job);
          installer = [
            "set -euo pipefail",
            `X3UI_LOCAL_ASSET_DIR=${shellQuote(remoteDir)} X3UI_PUBLIC_HOST=${shellQuote(input.host)} X3UI_PANEL_PORT=2053 bash ${shellQuote(`${remoteDir}/bootstrap.sh`)}`
          ].join("; ");
        } else {
          remoteDir = await uploadOnlineBootstrap(conn, job);
          installer = [
            "set -euo pipefail",
            `X3UI_BASE_URL=${shellQuote(MIRROR_BASE_URL)} X3UI_PUBLIC_HOST=${shellQuote(input.host)} X3UI_PANEL_PORT=2053 bash ${shellQuote(`${remoteDir}/bootstrap.sh`)}`
          ].join("; ");
        }
        const result = await execRemote(conn, `bash -lc ${shellQuote(installer)}`, (text) => {
          for (const line of text.split(/\r?\n/)) pushLog(job, line);
        });
        if (result.code !== 0 || !/^INSTALL_SUCCESS=1$/m.test(result.stdout)) {
          throw new Error("固定发行包安装未完成，请查看安装日志。目标机可能留有部分安装文件，请勿直接重复覆盖。");
        }
        if (remoteDir) {
          const stagedNames = OFFLINE_MODE
            ? ["bootstrap.sh", ...Object.values(OFFLINE_FILES).flat().map(([name]) => name)]
            : ["bootstrap.sh"];
          const cleanup = await execRemote(conn, `rm -f -- ${stagedNames.map((name) => shellQuote(`${remoteDir}/${name}`)).join(" ")} && rmdir -- ${shellQuote(remoteDir)}`);
          if (cleanup.code !== 0) pushLog(job, "安装成功，但目标机临时上传目录未清理。");
        }
        job.result = await readPanelResult(conn, input.host);
        await finishWithNode(job, conn, input.host);
        await finishSecurity(job, conn, input, security);
        conn.end();
        resolve();
      } catch (error) {
        conn.end();
        reject(error);
      }
    });
  } catch (error) {
    job.state = "failed";
    job.error = error.message || "安装失败。";
    pushLog(job, job.error);
  }
}

async function enableVerifiedSudo(conn, input) {
  if (input.username === "root") return;
  const sudo = await execRemote(conn, "sudo -k -S -p '' -i id -u", () => {}, `${input.password}\n`);
  if (sudo.code !== 0 || sudo.stdout.trim() !== "0") throw new Error("此用户的 sudo -i 验证失败，未读取或修改面板。");
  sudoConnections.set(conn, input.password);
}

async function recover(job, input, security) {
  let conn;
  try {
    pushLog(job, "正在连接已安装的目标服务器。");
    await runSsh(input, async (client, resolve, reject) => {
      conn = client;
      try {
        await enableVerifiedSudo(conn, input);
        if (!await isManagedInstall(conn)) throw new Error("目标机不是本安装器管理的 3X-UI 实例，已拒绝修改。");
        job.result = await readPanelResult(conn, input.host);
        await finishWithNode(job, conn, input.host);
        if (security.enabled) await finishSecurity(job, conn, input, security);
        conn.end();
        resolve();
      } catch (error) {
        conn.end();
        reject(error);
      }
    });
  } catch (error) {
    job.state = "failed";
    job.error = error.message || "补建节点失败。";
    pushLog(job, job.error);
  }
}

async function remove(job, input) {
  let conn;
  try {
    pushLog(job, "正在连接目标服务器并检查受管理的 3X-UI 安装。");
    await runSsh(input, async (client, resolve, reject) => {
      conn = client;
      try {
        await enableVerifiedSudo(conn, input);
        if (!await isManagedInstall(conn)) throw new Error("目标机不是本安装器管理的 3X-UI 实例，拒绝移除。");
        pushLog(job, "已识别受管理实例；正在创建并校验目标机本地备份，随后移除面板。");
        const response = await execRemote(conn, `bash -lc ${shellQuote(REMOVE_SCRIPT)}`);
        if (response.code !== 0) {
          const rollback = response.stderr.includes("REMOVE_ROLLBACK=restored") ? "已从备份恢复并重新启动面板。" :
            response.stderr.includes("REMOVE_ROLLBACK=failed") ? "自动恢复未通过，请保留 SSH 连接并人工核查备份。" :
            "尚未取得移除成功回执，请检查目标机状态。";
          throw new Error(`移除未完成：${rollback}`);
        }
        job.result = parseRemoveResult(response.stdout);
        job.state = "succeeded";
        pushLog(job, `面板已移除；受限备份保留在 ${job.result.backupPath}。SSH 用户、sudo 和 root 登录设置未修改。`);
        conn.end();
        resolve();
      } catch (error) {
        conn.end();
        reject(error);
      }
    });
  } catch (error) {
    job.state = "failed";
    job.error = error.message || "移除失败。";
    pushLog(job, job.error);
  }
}

function queueJob(req, res, worker, kind) {
  let input;
  let security;
  try {
    input = installInput(req.body || {});
    security = securityInput(req.body || {});
    if (!OFFLINE_MODE && (kind === "remove" || security.enabled)) {
      if (process.env.X3UI_REQUIRE_ACCESS !== "1" || !ACCESS_PASSWORD || ADMIN_ACTION_PASSWORD.length < 16 || ADMIN_ACTION_PASSWORD === ACCESS_PASSWORD) {
        return res.status(503).json({ error: "线上 SSH 安全操作尚未配置独立管理口令。" });
      }
      if (!hasAdminAction(req)) return res.status(403).json({ error: "管理操作口令不正确。" });
    }
    if (kind === "remove") {
      if (security.enabled) throw new Error("移除面板时不执行 SSH 安全设置。");
      if (req.body?.confirmAction !== "remove-managed-x3ui" || req.body?.confirmHost !== input.host) {
        throw new Error("移除操作需要确认目标服务器 IP。");
      }
    }
    if (security.enabled && input.username !== "root") throw new Error("创建管理员和修改 SSH 配置时，请先使用 root 登录；完成后可用新管理员找回结果。");
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const active = [...jobs.values()].filter((job) => job.state === "running");
  if (active.length >= MAX_ACTIVE_JOBS || active.some((job) => job.host === input.host)) {
    return res.status(429).json({ error: "已有安装任务正在运行，请稍后再试。" });
  }
  const id = crypto.randomUUID();
  const job = { id, kind, host: input.host, state: "running", logs: [], result: null, error: null };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), 30 * 60 * 1000).unref();
  void worker(job, input, security);
  res.status(202).json({ id });
}

app.post("/api/install", requireAccess, (req, res) => queueJob(req, res, install, "install"));
app.post("/api/recover", requireAccess, (req, res) => queueJob(req, res, recover, "recover"));
app.post("/api/remove", requireAccess, (req, res) => queueJob(req, res, remove, "remove"));
app.post("/api/probe", async (req, res) => {
  if (!OFFLINE_MODE || process.platform !== "darwin" || process.arch !== "arm64") {
    return res.status(404).json({ error: "本机节点测试仅在 Apple 芯片本地版中提供。" });
  }
  if (probeRunning) return res.status(429).json({ error: "已有节点测试正在运行。" });
  try {
    parseProbeInput(req.body?.link, req.body?.networkInterface);
    const info = await stat(PROBE_XRAY_BIN);
    if (!info.isFile() || await fileSha256(PROBE_XRAY_BIN) !== PROBE_XRAY_SHA256) {
      throw new Error("本机 Xray 测试内核缺失或校验失败。请使用完整的离线安装包。");
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  probeRunning = true;
  try {
    const result = await probeVlessReality(req.body.link, req.body.networkInterface, PROBE_XRAY_BIN);
    res.json(result);
  } catch (error) {
    res.status(422).json({ error: error.message });
  } finally {
    probeRunning = false;
  }
});
app.get("/api/edition", (_req, res) => res.json({
  edition: OFFLINE_MODE ? "offline" : "online",
  ...(APP_INSTANCE ? { instance: APP_INSTANCE } : {})
}));

app.get("/api/jobs/:id", requireAccess, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "任务已过期。" });
  res.set("Cache-Control", "no-store").json(job);
});

const port = Number(process.env.PORT || 4178);
const bindHost = process.env.X3UI_BIND_HOST || "127.0.0.1";
app.listen(port, bindHost, () => {
  console.log(`X3-UI 安装器运行在 http://${bindHost}:${port}`);
});
