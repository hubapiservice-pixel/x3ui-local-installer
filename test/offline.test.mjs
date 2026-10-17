import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("offline bootstrap reads uploaded files without a network fallback", async () => {
  const source = await readFile(path.join(root, "release/offline-v3.9.0-xray-26.3.27/bootstrap.sh"), "utf8");
  assert.match(source, /X3UI_LOCAL_ASSET_DIR/);
  assert.match(source, /cp -- "\$ASSET_DIR\/\$asset"/);
  assert.doesNotMatch(source, /\bcurl\b|X3UI_BASE_URL|DEFAULT_BASE_URL/);
});

test("offline edition serves only loopback Host and reports its mode", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, X3UI_OFFLINE: "1", X3UI_BIND_HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore"
  });
  t.after(() => child.kill());

  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/edition`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(response, "offline server did not start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { edition: "offline" });

  const rejected = await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: "/api/edition", headers: { Host: "external.example" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
  assert.equal(rejected, 403);

  const invalid = await fetch(`http://127.0.0.1:${port}/api/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host: "8.8.8.8", port: 22, username: "root", password: "not-used",
      createAdminUser: "on", adminUsername: "myadmin", adminPassword: "valid-test-password",
      disableRootSsh: "on"
    })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /必须验证管理员登录和 sudo -i/);

  const unconfirmed = await fetch(`http://127.0.0.1:${port}/api/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: "8.8.8.8", port: 22, username: "root", password: "not-used" })
  });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /需要确认目标服务器 IP/);
});

test("online remove requires both passwords and an exact host confirmation", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      X3UI_OFFLINE: "0", X3UI_REQUIRE_ACCESS: "1",
      X3UI_WEB_ACCESS_PASSWORD: "page-test-only",
      X3UI_ADMIN_ACTION_PASSWORD: "action-test-password-12345",
      X3UI_BIND_HOST: "127.0.0.1", PORT: String(port)
    },
    stdio: "ignore"
  });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/api/edition`);
      if (ready.ok) break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  const body = { host: "8.8.8.8", port: 22, username: "root", password: "not-used" };
  const post = async (data) => fetch(`http://127.0.0.1:${port}/api/remove`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
  });
  assert.equal((await post(body)).status, 401);
  assert.equal((await post({ ...body, accessCode: "page-test-only" })).status, 403);
  const hardening = await fetch(`http://127.0.0.1:${port}/api/install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, accessCode: "page-test-only", createAdminUser: "on", adminUsername: "operator_1", adminPassword: "valid-test-password" })
  });
  assert.equal(hardening.status, 403);
  const unconfirmed = await post({ ...body, accessCode: "page-test-only", actionCode: "action-test-password-12345" });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /需要确认目标服务器 IP/);
});
