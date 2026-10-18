import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const node = path.join(root, "runtime", "node.exe");
const app = path.join(root, "app");
const logDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "X3UIOfflineInstaller");
const logPath = path.join(logDir, "server.log");

async function edition(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/edition`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function available(port) {
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => listener.once("error", reject).listen(port, "127.0.0.1", resolve));
    return true;
  } catch {
    return false;
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
}

function openBrowser(url) {
  if (process.env.X3UI_NO_BROWSER === "1") return;
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  browser.once("error", (error) => console.error(`无法自动打开浏览器：${error.message}；请手动访问 ${url}`));
  browser.unref();
}

function announce(port, pid) {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`X3UI_URL=${url}`);
  if (pid) console.log(`X3UI_PID=${pid}`);
  openBrowser(url);
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("此安装包仅支持 Windows x64。请使用对应系统的版本。");
  }
  mkdirSync(logDir, { recursive: true });
  for (let port = 4179; port <= 4190; port += 1) {
    const existing = await edition(port);
    if (existing?.edition === "offline" && existing.instance?.toLowerCase() === root.toLowerCase()) {
      announce(port);
      return;
    }
    if (!await available(port)) continue;

    const log = openSync(logPath, "a");
    let child;
    try {
      child = spawn(node, ["server.mjs"], {
        cwd: app,
        env: { ...process.env, X3UI_OFFLINE: "1", X3UI_APP_INSTANCE: root, X3UI_BIND_HOST: "127.0.0.1", PORT: String(port) },
        detached: true, windowsHide: true, stdio: ["ignore", log, log]
      });
      child.once("error", (error) => console.error(`启动本地服务失败：${error.message}`));
      child.unref();
    } finally {
      closeSync(log);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const started = await edition(port);
      if (started?.edition === "offline" && started.instance?.toLowerCase() === root.toLowerCase()) {
        announce(port, child.pid);
        return;
      }
      if (child.exitCode !== null) break;
    }
    if (child.exitCode === null) child.kill();
    throw new Error(`本地服务未能启动。请查看 ${logPath}`);
  }
  throw new Error("本机端口 4179-4190 均被占用，无法启动离线安装器。");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
