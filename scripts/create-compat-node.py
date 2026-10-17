#!/usr/bin/env python3
"""Create and read back one VLESS+REALITY inbound on the isolated test panel."""

import base64
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import urllib.parse
import urllib.request
import uuid

ROOT = Path('/opt/x3ui-compat-test-20261015')
HOST = '117.55.224.148'
PORT = 8443
REMARK = 'X3UI-117-compat-test'
SNI = 'www.cloudflare.com'


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def decode_b64url(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def keypair():
    private_der = subprocess.run(
        ['openssl', 'genpkey', '-algorithm', 'X25519', '-outform', 'DER'],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout
    public_der = subprocess.run(
        ['openssl', 'pkey', '-inform', 'DER', '-pubout', '-outform', 'DER'],
        input=private_der, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout
    return b64url(private_der[-32:]), b64url(public_der[-32:])


def public_from_private(private_key):
    private_der = bytes.fromhex('302e020100300506032b656e04220420') + decode_b64url(private_key)
    public_der = subprocess.run(
        ['openssl', 'pkey', '-inform', 'DER', '-pubout', '-outform', 'DER'],
        input=private_der, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout
    return b64url(public_der[-32:])


def parse_json(value):
    return json.loads(value) if isinstance(value, str) else value


def node_link(inbound):
    settings = parse_json(inbound['settings'])
    stream = parse_json(inbound['streamSettings'])
    reality = stream['realitySettings']
    client = settings['clients'][0]
    assert inbound['protocol'] == 'vless'
    assert stream['security'] == 'reality'
    assert inbound['port'] == PORT
    query = urllib.parse.urlencode({
        'encryption': 'none',
        'flow': client.get('flow') or 'xtls-rprx-vision',
        'security': 'reality',
        'sni': reality['serverNames'][0],
        'fp': 'chrome',
        'pbk': public_from_private(reality['privateKey']),
        'sid': reality['shortIds'][0],
        'type': 'tcp',
        'spx': '/',
    })
    return f"vless://{client['id']}@{HOST}:{PORT}?{query}#{urllib.parse.quote(REMARK)}"


def main():
    creds = dict(line.split('=', 1) for line in (ROOT / 'panel.env').read_text().splitlines())
    base = f"http://127.0.0.1:22053/{creds['PANEL_PATH']}"
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    def request(route, body=None, csrf=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        headers = {'Content-Type': 'application/json'} if data is not None else {}
        if csrf:
            headers['X-CSRF-Token'] = csrf
        req = urllib.request.Request(base + route, data=data, headers=headers)
        with opener.open(req, timeout=15) as response:
            result = json.load(response)
        if result.get('success') is not True:
            raise RuntimeError(f"panel rejected {route}: {result.get('msg')}")
        return result.get('obj')

    csrf = request('/csrf-token')
    request('/login', {'username': creds['PANEL_USER'], 'password': creds['PANEL_PASSWORD']}, csrf)
    csrf = request('/csrf-token')
    inbounds = request('/panel/api/inbounds/list')
    existing = next((item for item in inbounds if item.get('remark') == REMARK), None)
    if existing is None:
        private_key, _ = keypair()
        short_id = secrets.token_hex(8)
        payload = {
            'enable': True, 'remark': REMARK, 'listen': '', 'port': PORT,
            'protocol': 'vless', 'expiryTime': 0, 'total': 0,
            'settings': {
                'clients': [{
                    'id': str(uuid.uuid4()), 'email': f'client-{short_id}',
                    'flow': 'xtls-rprx-vision', 'enable': True,
                }],
                'decryption': 'none', 'fallbacks': [],
            },
            'streamSettings': {
                'network': 'tcp', 'security': 'reality', 'tcpSettings': {},
                'realitySettings': {
                    'show': False, 'dest': f'{SNI}:443', 'xver': 0,
                    'serverNames': [SNI], 'privateKey': private_key,
                    'shortIds': [short_id],
                },
            },
            'sniffing': {'enabled': True, 'destOverride': ['http', 'tls']},
        }
        added = request('/panel/api/inbounds/add', payload, csrf)
        inbound_id = added['id']
    else:
        inbound_id = existing['id']

    readback = request(f'/panel/api/inbounds/get/{inbound_id}')
    link = node_link(readback)
    with socket.create_connection(('127.0.0.1', PORT), timeout=5):
        pass
    node_file = ROOT / 'node.txt'
    node_file.write_text(link + '\n')
    os.chmod(node_file, 0o600)
    print('NODE_READBACK_OK=1')
    print(link)


if __name__ == '__main__':
    main()
