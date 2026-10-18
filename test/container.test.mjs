import assert from "node:assert/strict";
import test from "node:test";
import { containerInput, containerNodeLink, containerPortUrl } from "../container.mjs";

test("host mode keeps existing installation behavior", () => {
  assert.equal(containerInput({}), null);
  assert.equal(containerInput({ installMode: "host" }), null);
});

test("LXD mode requires a safe name and separate nonprivileged ports", () => {
  assert.deepEqual(containerInput({ installMode: "lxd", containerName: "x3ui-win-test", containerPanelPort: "22055", containerNodePort: "18446" }), {
    name: "x3ui-win-test", panelPort: 22055, nodePort: 18446
  });
  for (const name of ["x-ui", "x3ui-;rm", "x3ui-../bad", "x3ui-UPPER"]) {
    assert.throws(() => containerInput({ installMode: "lxd", containerName: name, containerPanelPort: 22055, containerNodePort: 18446 }), /容器名/);
  }
  assert.throws(() => containerInput({ installMode: "lxd", containerName: "x3ui-test", containerPanelPort: 443, containerNodePort: 18446 }), /1024-65535/);
  assert.throws(() => containerInput({ installMode: "lxd", containerName: "x3ui-test", containerPanelPort: 18446, containerNodePort: 18446 }), /两个不同/);
  assert.throws(() => containerInput({ installMode: "unknown" }), /安装方式无效/);
});

test("container panel and node links expose mapped ports", () => {
  assert.equal(containerPortUrl("https://117.55.224.148:2053/abc", 22054), "https://117.55.224.148:22054/abc");
  assert.equal(containerNodeLink("vless://id@117.55.224.148:443?security=reality#node", 18445),
    "vless://id@117.55.224.148:18445?security=reality#node");
  assert.throws(() => containerPortUrl("http://127.0.0.1:2053/abc", 22054), /HTTPS/);
});
