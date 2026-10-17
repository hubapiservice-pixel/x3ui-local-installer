import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [jobId, xrayBin, installerBase = "http://127.0.0.1:4179"] = process.argv.slice(2);
if (!jobId || !xrayBin) {
  console.error("usage: node scripts/probe-vless.mjs JOB_ID XRAY_BINARY [INSTALLER_URL]");
  process.exit(2);
}

const jobResponse = await fetch(`${installerBase}/api/jobs/${encodeURIComponent(jobId)}`);
if (!jobResponse.ok) throw new Error(`Installer job unavailable: HTTP ${jobResponse.status}`);
const job = await jobResponse.json();
if (job.state !== "succeeded" || !job.result?.node?.link) throw new Error(`Node not ready: ${job.state}`);
const link = new URL(job.result.node.link);
const params = link.searchParams;
const connectHost = process.env.X3UI_PROBE_HOST || link.hostname;
const connectPort = Number(process.env.X3UI_PROBE_PORT || link.port);
if (link.protocol !== "vless:" || params.get("security") !== "reality" || params.get("type") !== "tcp") {
  throw new Error("Unexpected node protocol");
}

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const config = {
  log: { loglevel: "warning" },
  inbounds: [{ listen: "127.0.0.1", port, protocol: "socks", settings: { auth: "noauth", udp: false } }],
  outbounds: [{
    tag: "proxy",
    protocol: "vless",
    settings: { vnext: [{ address: connectHost, port: connectPort, users: [{ id: link.username, encryption: "none", flow: params.get("flow") || "" }] }] },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        serverName: params.get("sni"),
        fingerprint: params.get("fp"),
        publicKey: params.get("pbk"),
        shortId: params.get("sid") || "",
        spiderX: params.get("spx") || "/"
      }
    }
  }]
};
const useSingBox = path.basename(xrayBin) === "sing-box";
const singBoxConfig = {
  log: { level: "error" },
  inbounds: [{ type: "socks", tag: "local", listen: "127.0.0.1", listen_port: port }],
  outbounds: [{
    type: "vless", tag: "proxy", server: connectHost, server_port: connectPort,
    uuid: link.username, flow: params.get("flow") || "",
    tls: {
      enabled: true, server_name: params.get("sni"),
      utls: { enabled: true, fingerprint: params.get("fp") },
      reality: { enabled: true, public_key: params.get("pbk"), short_id: params.get("sid") || "" }
    }
  }],
  route: { final: "proxy" }
};

const dir = await mkdtemp(path.join(os.tmpdir(), "x3ui-probe-"));
const configPath = path.join(dir, "config.json");
let xray;
try {
  await writeFile(configPath, JSON.stringify(useSingBox ? singBoxConfig : config), { mode: 0o600 });
  xray = spawn(xrayBin, useSingBox ? ["run", "-c", configPath] : ["run", "-config", configPath], { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (xray.exitCode !== null) throw new Error(`Xray exited: ${xray.exitCode}`);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error("Local Xray SOCKS listener did not start");
  const curl = spawn("curl", [
    "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code} %{time_total}",
    "--connect-timeout", "10", "--max-time", "25", "--proxy", `socks5h://127.0.0.1:${port}`,
    "https://www.cloudflare.com/cdn-cgi/trace"
  ]);
  let output = "";
  let error = "";
  curl.stdout.on("data", (chunk) => { output += chunk; });
  curl.stderr.on("data", (chunk) => { error += chunk; });
  const code = await new Promise((resolve) => curl.once("close", resolve));
  if (code !== 0 || !output.startsWith("200 ")) throw new Error(`Proxy request failed: curl=${code}, response=${output}, error=${error.trim()}`);
  console.log(`PROXY_OK host=${link.hostname} via=${connectHost}:${connectPort} status=${output.trim()}`);
} finally {
  xray?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
