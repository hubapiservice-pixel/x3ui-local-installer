#!/usr/bin/env python3
"""Print only listener metadata from the isolated test panel's Xray settings."""

import json
import sqlite3
from pathlib import Path

root = Path('/opt/x3ui-compat-test-20261015')
with sqlite3.connect(f'file:{root}/db/x-ui.db?mode=ro', uri=True) as db:
    for key in ('subEnable', 'xrayTemplateConfig'):
        row = db.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        print(f'{key}_present={row is not None}')
        if key == 'subEnable' and row:
            print(f'subEnable={row[0]}')
        if key == 'xrayTemplateConfig' and row:
            config = json.loads(row[0])
            for inbound in config.get('inbounds', []):
                print('template_inbound=', inbound.get('tag'), inbound.get('listen'), inbound.get('port'))
            print('template_api_tag=', config.get('api', {}).get('tag'))

config_path = root / 'app/bin/config.json'
if config_path.exists():
    config = json.loads(config_path.read_text())
    for inbound in config.get('inbounds', []):
        print('runtime_inbound=', inbound.get('tag'), inbound.get('listen'), inbound.get('port'))
