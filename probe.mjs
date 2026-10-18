import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PROBE_XRAY_SHA256 = {
  "macos-arm64": "5d9dd24c0aba4b6cfcc6a33a5d67f854816ee17f392bf932ec8176da46f7e404",
  "windows-x64": "15c2d007954ac53ba69b80ec91242786b3c0b71d52649165b4ca1d5cc96ef8f1"
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VLESS_ENCRYPTION = /^mlkem768x25519plus\.(native|xorpub|random)\.(0rtt|1rtt)\.[A-Za-z0-9_-]{32,128}$/;

function normalizeVlessLink(link) {
  const match = link.match(/^vless:\/\/([A-Za-z0-9_-]{80,512})(\?[^#]*)?(#.*)?$/);
  if (!match) return { url: new URL(link), embeddedEncryption: null };
  const decoded = Buffer.from(match[1], "base64url").toString("utf8");
  const authority = decoded.match(/^(.+):([0-9a-f-]{36})@([0-9.]+):([0-9]{1,5})$/i);
  if (!authority || !VLESS_ENCRYPTION.test(authority[1]) || !UUID.test(authority[2])) {
    throw new Error("节点链接格式不正确。");
  }
  return {
    url: new URL(`vless://${authority[2]}@${authority[3]}:${authority[4]}${match[2] || ""}${match[3] || ""}`),
    embeddedEncryption: authority[1]
  };
}

function vlessCredentials(url) {
  if (UUID.test(url.username)) return { id: url.username, encryption: url.searchParams.get("encryption") || "none" };
  let decoded;
  try { decoded = Buffer.from(url.username, "base64url").toString("utf8"); } catch { return null; }
  const separator = decoded.lastIndexOf(":");
  const encryption = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!UUID.test(id) || !VLESS_ENCRYPTION.test(encryption)) return null;
  return { id, encryption };
}

export function parseProbeInput(link, networkInterface = "", platform = process.platform) {
  if (typeof link !== "string" || link.length > 4096) throw new Error("节点链接格式不正确。");
  let url;
  let embeddedEncryption;
  try { ({ url, embeddedEncryption } = normalizeVlessLink(link.trim())); } catch { throw new Error("节点链接格式不正确。"); }
  const port = Number(url.port);
  const credentials = vlessCredentials(url);
  if (credentials && embeddedEncryption) credentials.encryption = embeddedEncryption;
  const sni = url.searchParams.get("sni") || url.searchParams.get("peer") || "";
  const fingerprint = url.searchParams.get("fp") || "chrome";
  const octets = url.hostname.split(".").map(Number);
  const publicIpv4 = net.isIP(url.hostname) === 4 &&
    octets[0] !== 0 && octets[0] !== 10 && octets[0] !== 127 && octets[0] < 224 &&
    !(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) &&
    !(octets[0] === 169 && octets[1] === 254) &&
    !(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) &&
    !(octets[0] === 192 && (octets[1] === 0 || octets[1] === 168)) &&
    !(octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || (octets[1] === 51 && octets[2] === 100))) &&
    !(octets[0] === 203 && octets[1] === 0 && octets[2] === 113);
  if (url.protocol !== "vless:" || !credentials ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !(url.searchParams.get("security") === "reality" || url.searchParams.get("tls") === "1") ||
      ![null, "tcp"].includes(url.searchParams.get("type")) ||
      !publicIpv4 || !/^[a-z0-9.-]{1,253}$/i.test(sni) ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("pbk") || "") ||
      !/^[0-9a-f]{0,16}$/i.test(url.searchParams.get("sid") || "") ||
      !/^[a-z0-9_-]{1,32}$/i.test(fingerprint)) {
    throw new Error("本机端到端测试目前支持公网 IPv4 的 VLESS + REALITY TCP 链接。");
  }
  const iface = String(networkInterface || "").trim();
  if (iface && platform === "win32") throw new Error("Windows 本机测试请留空物理网卡，使用系统路由。");
  if (iface && !/^en\d{1,2}$/.test(iface)) throw new Error("网卡名称须为 en0、en1 等物理网卡；留空则跟随系统路由。");
  return { url, port, iface, credentials, sni, fingerprint };
}

function configFor({ url, port, iface, credentials, sni, fingerprint }, localPort) {
  const query = url.searchParams;
  return {
    log: { loglevel: "warning" },
    inbounds: [{ listen: "127.0.0.1", port: localPort, protocol: "socks", settings: { auth: "noauth", udp: false } }],
    outbounds: [{
      protocol: "vless",
      settings: { vnext: [{ address: url.hostname, port, users: [{ ...credentials, ...(query.get("flow") ? { flow: query.get("flow") } : {}) }] }] },
      streamSettings: {
        network: "tcp", security: "reality",
        ...(iface ? { sockopt: { interface: iface } } : {}),
        realitySettings: {
          serverName: sni, fingerprint, publicKey: query.get("pbk"),
          shortId: query.get("sid") || "", spiderX: query.get("spx") || "/"
        }
      }
    }]
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runCurl(port) {
  return new Promise((resolve, reject) => {
    const args = ["--silent", "--show-error", "--fail", "--noproxy", "", "--connect-timeout", "7", "--max-time", "18",
      "--retry", "2", "--retry-connrefused", "--proxy", `socks5h://127.0.0.1:${port}`,
      "--write-out", "\n__HTTP_STATUS__=%{http_code}", "https://www.cloudflare.com/cdn-cgi/trace"];
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ALL_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-8192); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8192); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function probeVlessReality(link, networkInterface, binary) {
  const parsed = parseProbeInput(link, networkInterface);
  const port = await freePort();
  const dir = await mkdtemp(path.join(os.tmpdir(), "x3ui-node-probe-"));
  let xray;
  const started = Date.now();
  try {
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(configFor(parsed, port)), { mode: 0o600 });
    xray = spawn(binary, ["run", "-c", configPath], { stdio: ["ignore", "ignore", "ignore"] });
    let spawnError;
    xray.once("error", (error) => { spawnError = error; });
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (spawnError || xray.exitCode !== null) throw new Error("本机 Xray 测试内核未能启动。");
    const result = await runCurl(port);
    const status = Number(result.stdout.match(/__HTTP_STATUS__=(\d{3})/)?.[1] || 0);
    if (result.code !== 0 || status !== 200) {
      const cause = /timed out/i.test(result.stderr) ? "连接超时" :
        /certificate/i.test(result.stderr) ? "目标站点证书校验失败" :
        /failed to connect|connection refused/i.test(result.stderr) ? "连接被拒绝" : "代理请求失败";
      throw new Error(`本机端到端测试未通过：${cause}。请核对防火墙、节点参数和客户端网络。`);
    }
    return {
      reachable: true,
      httpStatus: status,
      egressIp: result.stdout.match(/^ip=([^\r\n]+)$/m)?.[1] || null,
      networkInterface: parsed.iface || "系统路由",
      durationMs: Date.now() - started
    };
  } finally {
    if (xray && xray.exitCode === null) {
      const closed = new Promise((resolve) => xray.once("close", resolve));
      xray.kill("SIGTERM");
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    await rm(dir, { recursive: true, force: true });
  }
}
