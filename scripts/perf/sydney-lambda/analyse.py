#!/usr/bin/env python3
"""Analyse a Sydney-Lambda perf result (the JSON written by run.sh).

Usage: python3 analyse.py [/tmp/liveone-perf-result.json]

Prints, for the SSR'd dashboard measured from inside Sydney (ap-southeast-2):
  - the network floor (node /api/health probe) and the SSR document TTFB (node document probe);
    document_TTFB − health_TTFB ≈ the SSR render's server compute.
  - time-to-content: FCP (≈ time-to-tiles, since tiles are server-rendered) + DOMContentLoaded + LCP.
  - time-to-settle: the /api waterfall (raw settle = max(start+dur)); post-SSR this is time-to-chart
    (the un-seeded /api/history), NOT time-to-first-content.
  - the SSR-render span decomposition, if the render is instrumented (inline __ssr_timing payload).
Use `dur` for the browser rows (headless Chromium reports responseStart=0) and the node probes for
clean network numbers.
"""
import json, sys, statistics
from collections import defaultdict

# Recorded PRE-SSR Sydney reference (docs/performance/dashboard-fetch-waterfall.md, 2026-07-21).
PRE_SSR = {
    'health_floor': 46,           # ms warm, node /api/health
    'shared_settle': 496,         # ms median, shared-view 3-request settle
    'history_dur': 250, 'history_server': 176,
    'data8_dur': 86, 'data12_dur': 90,
}
# Italy (fra1 edge) reference, for the geography contrast.
ITALY_HEALTH_TTFB = 613
ITALY_DOC_TTFB = 705              # ms, single warm doc TTFB from Italy (dashboards row, fra1)

def med(xs): return statistics.median(xs) if xs else None
def warm(probes): return [p['ttfb'] for p in probes if p.get('tls') is None and p.get('ttfb') is not None]

def key(e):
    if e['path'] == '/api/data':   return f"/api/data?sys={e['sys']}"
    if e['path'] == '/api/history': return '/api/history'
    return e['path']

def spanmap(items):
    """['name;dur=1.2', ...] -> {'name': 1.2}"""
    out = {}
    for s in items or []:
        if ';dur=' in s:
            n, v = s.split(';dur=', 1)
            try: out[n] = float(v)
            except ValueError: pass
    return out

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/liveone-perf-result.json'
    d = json.load(open(path))
    if 'errorMessage' in d:
        print('LAMBDA ERROR:', d.get('errorType')); print('\n'.join(d.get('stackTrace', [])[:10])); return

    print(f"region={d.get('region')}  target={d.get('target')}")

    # --- network floor + SSR document TTFB (node probes) ---
    hw = warm(d.get('health', []))
    dw = warm(d.get('document', []))
    if hw:
        vid = (d['health'][-1].get('xVercelId') or '')[:12]
        print(f"\nNETWORK FLOOR (node /api/health, warm): {hw}  median={med(hw):.0f} ms  vid={vid}")
        print(f"  -> vs ITALY(fra1) ~{ITALY_HEALTH_TTFB} ms   (pre-SSR Sydney floor ~{PRE_SSR['health_floor']} ms)")
    if dw:
        dvid = (d['document'][-1].get('xVercelId') or '')[:12]
        print(f"\nSSR DOCUMENT TTFB (node, warm): {dw}  median={med(dw):.0f} ms  vid={dvid}")
        if hw:
            print(f"  -> SSR server compute ≈ doc {med(dw):.0f} − floor {med(hw):.0f} = ~{med(dw)-med(hw):.0f} ms"
                  f"   (vs ITALY doc TTFB ~{ITALY_DOC_TTFB} ms, mostly fra1↔syd1 network)")

    if d.get('browserError'):
        print('\nbrowserError:', d['browserError'][:800]); return
    runs = d.get('browserRuns', [])
    if not runs:
        print('\n(no browserRuns)'); return

    # --- time-to-content (paint / nav timing) ---
    fcp = [r['paint']['firstContentfulPaint'] for r in runs if r.get('paint', {}).get('firstContentfulPaint')]
    dcl = [r['nav']['domContentLoadedEventEnd'] for r in runs if r.get('nav', {}).get('domContentLoadedEventEnd')]
    lcp = [r['lcp'] for r in runs if r.get('lcp')]
    print(f"\nTIME-TO-CONTENT (browser, {len(runs)} runs):")
    if fcp: print(f"  FCP (≈ time-to-tiles):     min={min(fcp)} median={med(fcp):.0f} max={max(fcp)} ms")
    if dcl: print(f"  DOMContentLoaded:          min={min(dcl)} median={med(dcl):.0f} max={max(dcl)} ms")
    if lcp: print(f"  LCP:                       min={min(lcp)} median={med(lcp):.0f} max={max(lcp)} ms")
    c = runs[0].get('content', {})
    print(f"  content proof (run0): skeletons={c.get('skeletons')} renderedValues={c.get('renderedValues')} "
          f"bodyTextLen={c.get('bodyTextLen')}")

    # --- time-to-settle (the /api waterfall) ---
    settles = [r.get('settleRaw') or max((e['end'] for e in r['entries']), default=0) for r in runs]
    counts = sorted(set(r['count'] for r in runs))
    print(f"\nTIME-TO-SETTLE — /api waterfall ({len(runs)} runs, counts={counts}):")
    print(f"  settle (raw max end): min={min(settles)} median={med(settles):.0f} max={max(settles)} ms"
          f"   (pre-SSR Sydney ~{PRE_SSR['shared_settle']} ms, 3 req)")
    hist = [max((e['end'] for e in r['entries'] if e['path'] == '/api/history'), default=0) for r in runs]
    hist = [h for h in hist if h]
    if hist:
        print(f"  time-to-chart (/api/history end): median={med(hist):.0f} ms")
    if fcp and hist:
        print(f"  -> tiles ({med(fcp):.0f} ms) beat chart ({med(hist):.0f} ms) by ~{med(hist)-med(fcp):.0f} ms")

    # --- per-endpoint client dur + server total ---
    agg = defaultdict(lambda: defaultdict(list)); order = []
    for r in runs:
        for e in r['entries']:
            k = key(e)
            if k not in order: order.append(k)
            agg[k]['dur'].append(e['dur'])
            sm = spanmap(e.get('st'))
            if 'total' in sm: agg[k]['total'].append(sm['total'])
    print("\n  per-endpoint medians (dur = client; server_total from x-server-timing):")
    for k in order:
        a = agg[k]
        st = f"{med(a['total']):.1f}" if a['total'] else 'n/a'
        print(f"    {k:22s} dur={med(a['dur']):5.0f}  server_total={st}")

    # --- SSR-render decomposition (inline __ssr_timing), if the render is instrumented ---
    ssr = [spanmap(r.get('ssrTiming')) for r in runs if r.get('ssrTiming')]
    if any(ssr):
        names = []
        for m in ssr:
            for n in m:
                if n not in names: names.append(n)
        print(f"\nSSR-RENDER DECOMPOSITION (inline __ssr_timing, {len(ssr)} runs):")
        for n in names:
            vals = [m[n] for m in ssr if n in m]
            print(f"    {n:16s} median={med(vals):6.1f} ms")
    else:
        print("\nSSR-RENDER DECOMPOSITION: (not present — render not yet instrumented; "
              "document TTFB above is the total SSR server time)")

if __name__ == '__main__':
    main()
