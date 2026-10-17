import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const [binary, linkFile, overrideHost, overridePort, bindInterface] = process.argv.slice(2);
if (!binary || !linkFile) {
  console.error('Usage: node probe-vless-node.mjs XRAY_BINARY VLESS_LINK_FILE');
  process.exit(2);
}

const link = new URL((await readFile(linkFile, 'utf8')).trim());
if (link.protocol !== 'vless:' || link.searchParams.get('security') !== 'reality') {
  throw new Error('Expected a VLESS + REALITY link');
}

const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const localPort = listener.address().port;
await new Promise((resolve) => listener.close(resolve));

const config = {
  log: { loglevel: 'info' },
  inbounds: [{ listen: '127.0.0.1', port: localPort, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
  outbounds: [{
    protocol: 'vless',
    settings: { vnext: [{ address: overrideHost || link.hostname, port: Number(overridePort || link.port), users: [{ id: link.username, encryption: 'none', flow: link.searchParams.get('flow') }] }] },
    streamSettings: {
      network: 'tcp', security: 'reality',
      ...(bindInterface ? { sockopt: { interface: bindInterface } } : {}),
      realitySettings: {
        serverName: link.searchParams.get('sni'),
        fingerprint: link.searchParams.get('fp'),
        publicKey: link.searchParams.get('pbk'),
        shortId: link.searchParams.get('sid'),
        spiderX: link.searchParams.get('spx') || '/'
      }
    }
  }]
};

const dir = await mkdtemp(join(tmpdir(), 'xray-probe-'));
let xray;
try {
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  xray = spawn(binary, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let xrayError = '';
  xray.stdout.on('data', (chunk) => { xrayError += chunk.toString(); });
  xray.stderr.on('data', (chunk) => { xrayError += chunk.toString(); });
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const curl = spawn('curl', [
    '-fsS', '--retry', '3', '--retry-connrefused', '--retry-delay', '1',
    '--connect-timeout', '8', '--max-time', '20',
    '--proxy', `socks5h://127.0.0.1:${localPort}`,
    'https://www.cloudflare.com/cdn-cgi/trace'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let error = '';
  curl.stdout.on('data', (chunk) => { output += chunk.toString(); });
  curl.stderr.on('data', (chunk) => { error += chunk.toString(); });
  const exitCode = await new Promise((resolve) => curl.on('close', resolve));
  if (exitCode !== 0) {
    console.error(`PROXY_TEST_FAILED=${exitCode}`);
    console.error(error.trim());
    console.error(xrayError.trim());
    process.exitCode = 1;
  } else {
    console.log('PROXY_TEST_OK=1');
    console.log(output.split('\n').filter((line) => /^(ip|loc)=/.test(line)).join('\n'));
  }
} finally {
  if (xray && !xray.killed) xray.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
