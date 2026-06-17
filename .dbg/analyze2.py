import json

lines = open(r'd:\Work Projects\Harness\.dbg\trae-debug-log-bing-links-no-response.ndjson').readlines()
events = [json.loads(l) for l in lines if l.strip()]

# Check if navigate event was ever called for localhost
print('=== Navigate events ===')
for e in events:
    if 'navigate' in e['msg']:
        d = e['data']
        print(f'  final={d.get("final")}')

print()

# Show tab=1 timeline (the bug case - before localhost)
print('=== Tab 1 timeline (BUGGY case - before localhost) ===')
for e in events:
    d = e['data']
    if d.get('tabId') == '1':
        ts = e['ts']
        url = d.get('currentUrl', '?')
        po = d.get('proxyOrigin')
        proxied = d.get('isProxiedTab')
        sand = d.get('hasSandbox')
        print(f'  ts={ts} url={url} proxyOrigin={po} isProxied={proxied} hasSandbox={sand}')

print()

# Show when proxyOrigin changes
print('=== proxyOrigin changes ===')
prev_po = None
for e in events:
    d = e['data']
    po = d.get('proxyOrigin')
    if po != prev_po:
        print(f'  ts={e["ts"]} proxyOrigin: {prev_po} -> {po} tabId={d.get("tabId")} currentUrl={d.get("currentUrl")}')
        prev_po = po
