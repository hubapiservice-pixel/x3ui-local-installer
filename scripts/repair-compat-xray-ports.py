#!/usr/bin/env python3
"""Move only the isolated panel's Xray API and metrics listeners."""

import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

ROOT = Path('/opt/x3ui-compat-test-20261015')


def main():
    creds = dict(line.split('=', 1) for line in (ROOT / 'panel.env').read_text().splitlines())
    base = f"http://127.0.0.1:22053/{creds['PANEL_PATH']}"
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    def request(route, body=None, csrf=None, form=False):
        data = None
        headers = {}
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode('utf-8')
                headers['Content-Type'] = 'application/x-www-form-urlencoded'
            else:
                data = json.dumps(body).encode('utf-8')
                headers['Content-Type'] = 'application/json'
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
    config = request('/panel/api/setting/getDefaultJsonConfig')
    config = json.loads(config) if isinstance(config, str) else config
    api = next(item for item in config['inbounds'] if item.get('tag') == 'api')
    metrics = config['metrics']
    print(f"DEFAULT_API={api.get('listen')}:{api.get('port')}")
    print(f"DEFAULT_METRICS={metrics.get('listen')}")
    assert api['listen'] == '127.0.0.1' and api['port'] == 62789
    assert metrics['listen'] == '127.0.0.1:11111'
    api['port'] = 62790
    metrics['listen'] = '127.0.0.1:11112'
    if '--dry-run' in sys.argv[1:]:
        print('PORT_REPAIR_DRY_RUN_OK=1')
        return

    request('/panel/api/xray/update', {
        'xraySetting': json.dumps(config, separators=(',', ':')),
        'outboundTestUrl': 'https://www.google.com/generate_204',
    }, csrf, form=True)
    print('PORT_REPAIR_SAVED=1')


if __name__ == '__main__':
    main()
