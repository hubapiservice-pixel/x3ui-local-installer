import assert from "node:assert/strict";
import test from "node:test";
import { parseProbeInput } from "../probe.mjs";

const link = "vless://01234567-89ab-4cde-8f01-23456789abcd@8.8.8.8:443?encryption=none&type=tcp&security=reality&sni=www.example.com&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=1234abcd&flow=xtls-rprx-vision";

test("probe accepts a well-formed public VLESS Reality TCP link", () => {
  const result = parseProbeInput(link, "en0");
  assert.equal(result.port, 443);
  assert.equal(result.iface, "en0");
});

test("probe accepts Shadowrocket encoded VLESS encryption credentials", () => {
  const credentials = Buffer.from(`mlkem768x25519plus.native.0rtt.${"A".repeat(43)}:01234567-89ab-4cde-8f01-23456789abcd`).toString("base64url");
  const encoded = `vless://${credentials}@8.8.8.8:443?tls=1&peer=www.example.com&pbk=${"B".repeat(43)}&sid=1234abcd`;
  const parsed = parseProbeInput(encoded);
  assert.equal(parsed.credentials.id, "01234567-89ab-4cde-8f01-23456789abcd");
  assert.match(parsed.credentials.encryption, /^mlkem768x25519plus/);
  assert.equal(parsed.sni, "www.example.com");
  assert.equal(parsed.fingerprint, "chrome");
  const wholeAuthority = Buffer.from(`mlkem768x25519plus.native.0rtt.${"A".repeat(43)}:01234567-89ab-4cde-8f01-23456789abcd@8.8.8.8:443`).toString("base64url");
  const wholeLink = `vless://${wholeAuthority}?tls=1&peer=www.example.com&pbk=${"B".repeat(43)}&sid=1234abcd`;
  assert.equal(parseProbeInput(wholeLink).credentials.id, parsed.credentials.id);
});

test("probe rejects local destinations, other protocols, and invalid interfaces", () => {
  assert.throws(() => parseProbeInput(link.replace("8.8.8.8", "127.0.0.1")), /公网 IPv4/);
  assert.throws(() => parseProbeInput(link.replace("8.8.8.8", "192.168.1.4")), /公网 IPv4/);
  assert.throws(() => parseProbeInput(link.replace("type=tcp", "type=ws")), /VLESS/);
  assert.throws(() => parseProbeInput(link, "lo0"), /物理网卡/);
});
