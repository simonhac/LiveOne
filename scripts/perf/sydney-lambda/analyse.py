#!/usr/bin/env python3
"""Analyse a Sydney-Lambda perf result (the JSON written by run.sh).

Usage: python3 analyse.py [/tmp/liveone-perf-result.json]

Prints the Sydney network floor (from the node /api/health probe), the shared-view browser
waterfall (settle + per-endpoint client `dur` and server `total`), and a comparison against the
recorded Italy baseline. Use `dur` for the browser rows (headless Chromium reports responseStart=0)
and the health probe for the clean network floor.
"""
import json, sys, statistics
from collections import defaultdict

# Recorded Italy reference (see docs/performance/dashboard-fetch-waterfall.md, 2026-07-21).
ITALY_HEALTH_TTFB = 613          # ms, warm (curl/node), server ~2.7ms
ITALY_SHARED_DUR = {'/api/data?sys=8': 741, '/api/data?sys=12': 681, '/api/history': 1015}  # single shared run

def med(xs): return statistics.median(xs) if xs else None

def key(e):
    if e['path'] == '/api/data':   return f"/api/data?sys={e['sys']}"
    if e['path'] == '/api/history': return '/api/history'
    return e['path']

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/liveone-perf-result.json'
    d = json.load(open(path))
    if 'errorMessage' in d:
        print('LAMBDA ERROR:', d.get('errorType')); print('\n'.join(d.get('stackTrace', [])[:10])); return

    print(f"region={d.get('region')}  target={d.get('target')}")
    hw = [h['ttfb'] for h in d.get('health', []) if h.get('tls') is None and h.get('ttfb') is not None]
    if hw:
        vid = (d['health'][-1].get('xVercelId') or '')[:12]
        print(f"\nNETWORK FLOOR (node /api/health, warm): {hw}  median={med(hw):.0f} ms  vid={vid}")
        print(f"  -> ~{med(hw)-3:.0f} ms network  vs ITALY ~{ITALY_HEALTH_TTFB} ms")

    if d.get('browserError'):
        print('\nbrowserError:', d['browserError'][:800]); return
    runs = d.get('browserRuns', [])
    settles = [max(e['end'] for e in r['entries']) for r in runs]
    print(f"\nBROWSER shared-view waterfall ({len(runs)} runs, counts={sorted(set(r['count'] for r in runs))})")
    if settles:
        print(f"  settle: min={min(settles)} median={med(settles):.0f} max={max(settles)} ms")

    agg = defaultdict(lambda: defaultdict(list)); order = []
    for r in runs:
        for e in r['entries']:
            k = key(e)
            if k not in order: order.append(k)
            agg[k]['dur'].append(e['dur'])
            tot = [float(s.split(';dur=')[1]) for s in e['st'] if s.startswith('total;')]
            if tot: agg[k]['total'].append(tot[0])
    print("  per-endpoint medians (dur = client; server_total from x-server-timing):")
    for k in order:
        a = agg[k]
        st = f"{med(a['total']):.1f}" if a['total'] else 'n/a'
        it = ITALY_SHARED_DUR.get(k)
        cmp = f"   (Italy ~{it} ms)" if it else ""
        print(f"    {k:20s} dur={med(a['dur']):5.0f}  server_total={st}{cmp}")

if __name__ == '__main__':
    main()
