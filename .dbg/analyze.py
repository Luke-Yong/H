import json

lines = open(r'd:\Work Projects\Harness\.dbg\trae-debug-log-bing-links-no-response.ndjson').readlines()
events = [json.loads(l) for l in lines if l.strip()]

# Show unique (tabId, currentUrl) pairs with first ts
seen = {}
for e in events:
    d = e['data']
    key = (d.get('tabId','?'), d.get('currentUrl','?'), d.get('isProxiedTab','?'))
    if key not in seen:
        seen[key] = (e['ts'], d.get('proxyOrigin'))

print('=== Tab URL timeline ===')
for (tab, url, proxied), (ts, po) in sorted(seen.items(), key=lambda x: x[1][0]):
    print(f'  tab={tab} url={url} isProxiedTab={proxied} proxyOrigin={po} ts={ts}')

print()
print('=== Navigate events ===')
for e in events:
    if 'navigate' in e['msg']:
        d = e['data']
        print(f'  final={d.get("final")} proxyOrigin={d.get("proxyOrigin")} tabId={d.get("tabId")}')
