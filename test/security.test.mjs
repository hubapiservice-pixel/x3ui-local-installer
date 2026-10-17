import assert from "node:assert/strict";
import test from "node:test";
import { applySecurity, securityInput } from "../security.mjs";

const target = { host: "198.19.0.1", port: 22, username: "root", password: "root-test-only" };
const options = {
  enabled: true,
  username: "operator_1",
  password: "new-user-test-1234",
  grantSudo: true,
  disableRoot: true
};

function harness({ adminLoginFails = false, postDisableAdminFails = false, sudoFails = false, rootStillAllowed = false, reloadFails = false, timerFails = false } = {}) {
  const commands = [];
  let rootDenied = false;
  const rootConn = { x3uiHostKey: Buffer.from("test-host-key") };
  return {
    commands,
    rootConn,
    get rootDenied() { return rootDenied; },
    connect: async (input, hostKey) => {
      assert.deepEqual(hostKey, rootConn.x3uiHostKey);
      if (input.username === options.username && (adminLoginFails || (postDisableAdminFails && rootDenied))) throw new Error("connection refused");
      if (input.username === "root" && rootDenied && !rootStillAllowed) {
        throw Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
      }
      return { username: input.username, end() {} };
    },
    exec: async (conn, command, stdin) => {
      commands.push({ command, stdin });
      if (command === "id -un") return { code: 0, stdout: `${conn.username}\n` };
      if (command.startsWith("sudo -k")) {
        assert.equal(stdin, `${options.password}\n`);
        return { code: sudoFails ? 1 : 0, stdout: sudoFails ? "" : "0\n" };
      }
      if (command === "chpasswd") assert.equal(stdin, `${options.username}:${options.password}\n`);
      if (command.startsWith("systemd-run ") && timerFails) return { code: 1, stdout: "" };
      if (command.startsWith("rm -f -- /etc/ssh/sshd_config.d/")) rootDenied = false;
      if (command.startsWith("umask 077; printf 'PermitRootLogin")) {
        if (reloadFails) return { code: 1, stdout: "" };
        rootDenied = true;
      }
      return { code: 0, stdout: "" };
    }
  };
}

test("configurable username is accepted; invalid or unsafe combinations are rejected", () => {
  assert.deepEqual(securityInput({}), { enabled: false });
  assert.equal(securityInput({ createAdminUser: "on", adminUsername: "operator_1", adminPassword: options.password }).username, "operator_1");
  assert.throws(() => securityInput({ grantSudo: "on" }), /必须创建/);
  assert.throws(() => securityInput({ disableRootSsh: "on", createAdminUser: "on", adminUsername: "operator_1", adminPassword: options.password }), /必须验证/);
  assert.throws(() => securityInput({ createAdminUser: "on", adminUsername: "root", adminPassword: options.password }), /不能为 root/);
  assert.throws(() => securityInput({ createAdminUser: "on", adminUsername: "operator_1", adminPassword: "short" }), /12 到 128/);
  assert.throws(() => securityInput({ createAdminUser: "on", adminUsername: "operator_1", adminPassword: options.password, disableRootSsh: "yes" }), /格式不正确/);
});

test("successful hardening verifies admin and sudo before and after denying root", async () => {
  const fake = harness();
  const result = await applySecurity(fake.rootConn, target, options, fake);
  assert.equal(fake.rootDenied, true);
  assert.equal(result.username, options.username);
  assert.match(result.rootSsh, /拒绝/);
  const commands = fake.commands.map((entry) => entry.command);
  assert.ok(commands.indexOf("id -un") < commands.findIndex((line) => line.startsWith("umask 077; printf 'PermitRootLogin")));
  assert.equal(commands.filter((line) => line === "id -un").length, 2);
  assert.ok(commands.some((line) => line.startsWith("systemctl stop ") && line.includes("x3ui-root-rollback-")));
  assert.ok(commands.every((line) => !line.includes(options.password)));
});

test("admin SSH failure leaves root SSH enabled", async () => {
  const fake = harness({ adminLoginFails: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), /connection refused/);
  assert.equal(fake.rootDenied, false);
  assert.ok(fake.commands.every(({ command }) => !command.includes("PermitRootLogin no")));
});

test("sudo failure leaves root SSH enabled", async () => {
  const fake = harness({ sudoFails: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), /sudo -i 验证失败/);
  assert.equal(fake.rootDenied, false);
  assert.ok(fake.commands.every(({ command }) => !command.includes("PermitRootLogin no")));
});

test("a failed SSH reload restores root and reports partial hardening", async () => {
  const fake = harness({ reloadFails: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), (error) => {
    assert.match(error.message, /已恢复并重新验证 root SSH/);
    assert.match(error.securityReport.rootSsh, /已恢复/);
    return true;
  });
  assert.equal(fake.rootDenied, false);
});

test("root still accepting passwords forces rollback", async () => {
  const fake = harness({ rootStillAllowed: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), /root 仍能通过密码/);
  assert.equal(fake.rootDenied, false);
});

test("rollback timer failure blocks the root SSH change", async () => {
  const fake = harness({ timerFails: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), /无法启动自动回滚定时器/);
  assert.equal(fake.rootDenied, false);
  assert.ok(fake.commands.every(({ command }) => !command.startsWith("umask 077; printf 'PermitRootLogin")));
});

test("admin login failure after disabling root restores and rechecks root", async () => {
  const fake = harness({ postDisableAdminFails: true });
  await assert.rejects(applySecurity(fake.rootConn, target, options, fake), /已恢复并重新验证 root SSH/);
  assert.equal(fake.rootDenied, false);
  assert.ok(fake.commands.some(({ command }) => command.startsWith("rm -f -- /etc/ssh/sshd_config.d/")));
});
