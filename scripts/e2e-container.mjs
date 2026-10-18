import { stdin, stdout } from "node:process";

const installer = process.env.X3UI_TEST_INSTALLER_URL || "http://127.0.0.1:4179";
const host = process.env.X3UI_TEST_HOST;
const name = process.env.X3UI_TEST_NAME;
const panelPort = Number(process.env.X3UI_TEST_PANEL_PORT);
const nodePort = Number(process.env.X3UI_TEST_NODE_PORT);
const sshPort = Number(process.env.X3UI_TEST_SSH_PORT || 22);
if (!host || !name || !panelPort || !nodePort) {
  throw new Error("Set X3UI_TEST_HOST, X3UI_TEST_NAME, X3UI_TEST_PANEL_PORT and X3UI_TEST_NODE_PORT.");
}

async function readSecret() {
  if (process.env.X3UI_TEST_SSH_PASSWORD) return process.env.X3UI_TEST_SSH_PASSWORD;
  if (!stdin.isTTY) throw new Error("SSH password must be supplied via a protected environment secret or TTY.");
  stdout.write("SSH password: ");
  stdin.setRawMode(true);
  stdin.resume();
  let secret = "";
  try {
    for await (const chunk of stdin) {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") {
          stdout.write("\n");
          return secret;
        }
        if (char === "\u0003") throw new Error("Cancelled.");
        if (char === "\u007f") secret = secret.slice(0, -1);
        else secret += char;
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  throw new Error("SSH password was not provided.");
}

async function json(path, options) {
  const response = await fetch(new URL(path, installer), options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const password = await readSecret();
const edition = await json("/api/edition");
if (edition.edition !== "offline") throw new Error("The test must use an extracted offline package.");
const { id } = await json("/api/install", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    installMode: "lxd", containerName: name, containerPanelPort: panelPort, containerNodePort: nodePort,
    host, port: sshPort, username: "root", password
  })
});
stdout.write(`INSTALL_JOB=${id}\n`);

let job;
for (let attempt = 0; attempt < 600; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  job = await json(`/api/jobs/${id}`);
  if (job.state !== "running") break;
  if (attempt % 20 === 0) stdout.write(`INSTALL_RUNNING=${Math.ceil((attempt + 1) * 1.5)}s\n`);
}
if (!job || job.state !== "succeeded" || job.result?.container?.name !== name ||
    !job.result?.panel?.panelUrl?.startsWith(`https://${host}:${panelPort}/`) ||
    !job.result?.node?.link?.includes(`@${host}:${nodePort}?`)) {
  throw new Error(`Install did not pass readback: ${job?.state || "timed out"}; ${job?.error || "no result"}`);
}
stdout.write(`INSTALL_VERIFIED=${edition.platform} container=${name} panel_port=${panelPort} node_port=${nodePort}\n`);

const probe = await json("/api/probe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ link: job.result.node.link })
});
if (probe.httpStatus !== 200) throw new Error(`Node probe returned HTTP ${probe.httpStatus}.`);
stdout.write(`PROBE_VERIFIED=${edition.platform} http=${probe.httpStatus} duration_ms=${probe.durationMs}\n`);
