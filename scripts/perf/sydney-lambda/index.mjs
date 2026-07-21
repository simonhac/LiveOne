import https from 'node:https';
import { performance } from 'node:perf_hooks';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Override via Lambda env to point at a fresh share token / different dashboard.
const SHARED = process.env.TARGET_URL || 'https://www.liveone.energy/dashboard/id/5?access=honest-buttery-tapir';
const HEALTH = process.env.HEALTH_URL || 'https://www.liveone.energy/api/health';
const RUNS = Number(process.env.RUNS || 10);

// ---- node-level TTFB probe (raw https, always works even if chromium fails) ----
// Used for BOTH /api/health (clean network floor) and the dashboard DOCUMENT (SSR TTFB): run 5x
// sequentially and the socket is reused after the first, so probes 2-5 are "warm" (dns/tcp/tls null).
// Warm document TTFB − warm health TTFB ≈ the SSR render's server compute (network leg cancels out).
function probe(url) {
  return new Promise((resolve) => {
    const t = { url };
    const start = performance.now();
    const req = https.get(url, { headers: { 'user-agent': 'liveone-perf/1.0' } }, (res) => {
      t.status = res.statusCode;
      t.xServerTiming = res.headers['x-server-timing'] || null;
      t.xVercelId = res.headers['x-vercel-id'] || null;
      t.xVercelCache = res.headers['x-vercel-cache'] || null;
      res.once('data', () => { if (t.ttfb == null) t.ttfb = Math.round(performance.now() - start); });
      res.on('data', () => {});
      res.on('end', () => { t.total = Math.round(performance.now() - start); resolve(t); });
    });
    req.on('socket', (s) => {
      s.once('lookup', () => { t.dns = Math.round(performance.now() - start); });
      s.once('connect', () => { t.tcp = Math.round(performance.now() - start); });
      s.once('secureConnect', () => { t.tls = Math.round(performance.now() - start); });
    });
    req.on('error', (e) => { t.error = String(e); resolve(t); });
    req.setTimeout(20000, () => { t.error = 'timeout'; req.destroy(); resolve(t); });
  });
}

// ---- the browser harness, run in-page (mirror of the laptop / dashboard-fetch-waterfall harness) ----
// Post-SSR, the tiles are baked into the initial HTML (React Query HydrationBoundary), so the
// interesting numbers are the DOCUMENT/paint timings (time-to-content), not just /api settle
// (which now measures only the un-seeded /api/history = time-to-chart). We therefore capture:
//   - Navigation Timing (document TTFB = SSR server + network, DCL, load)
//   - Paint Timing (FCP ≈ time-to-tiles, since tile text is server-rendered)
//   - LCP (armed via evaluateOnNewDocument below)
//   - content proof (skeletons vs rendered value-strings in the SSR DOM)
//   - the inline __ssr_timing payload (SSR-render span decomposition; empty until the render is
//     instrumented — a Next page can't set response headers, so it's surfaced in the DOM)
//   - the /api resource waterfall (unchanged), reported with raw settle = max(start+dur)
const HARNESS = async () => {
  const maxWaitMs = 30000, quietMs = 4000, pollMs = 400;
  const t0 = performance.now(); let lc = -1, lm = -1, ss = null;
  while (performance.now() - t0 < maxWaitMs) {
    const es = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
    const c = es.length, me = es.reduce((m, e) => Math.max(m, e.startTime + e.duration), 0);
    const nav0 = performance.getEntriesByType('navigation')[0];
    const loaded = !!(nav0 && nav0.loadEventEnd > 0);
    // Settle when the /api count + max-end have been stable for quietMs. Allow settling with zero
    // /api requests once the document load event has fired (future-proofs the case where /api/history
    // also gets SSR-seeded → 0 client requests on first paint), so the loop can't hang.
    if (c === lc && me === lm && (c > 0 || loaded)) {
      if (ss === null) ss = performance.now();
      if (performance.now() - ss >= quietMs) break;
    } else { ss = null; lc = c; lm = me; }
    await new Promise(r => setTimeout(r, pollMs));
  }
  const es = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).sort((a, b) => a.startTime - b.startTime);
  const stByUrl = {}, vidByUrl = {};
  for (const url of [...new Set(es.map(e => e.name))]) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      stByUrl[url] = (r.headers.get('x-server-timing') || '').split(', ').filter(Boolean);
      vidByUrl[url] = r.headers.get('x-vercel-id');
    } catch {}
  }

  // Navigation Timing for the SSR document (this navigation).
  const nav = performance.getEntriesByType('navigation')[0];
  const navOut = nav ? {
    startType: nav.type,
    requestStart: Math.round(nav.requestStart),
    responseStart: Math.round(nav.responseStart),   // document TTFB (0 under headless — use node `document` probe)
    responseEnd: Math.round(nav.responseEnd),
    domInteractive: Math.round(nav.domInteractive),
    domContentLoadedEventEnd: Math.round(nav.domContentLoadedEventEnd),
    domComplete: Math.round(nav.domComplete),
    loadEventEnd: Math.round(nav.loadEventEnd),
    transferSize: nav.transferSize, encodedBodySize: nav.encodedBodySize, decodedBodySize: nav.decodedBodySize,
  } : null;

  // Paint Timing — FCP ≈ time-to-(tile)content, because the tiles are server-rendered.
  const paints = performance.getEntriesByType('paint');
  const paintOut = {
    firstPaint: Math.round(paints.find(p => p.name === 'first-paint')?.startTime || 0),
    firstContentfulPaint: Math.round(paints.find(p => p.name === 'first-contentful-paint')?.startTime || 0),
  };

  // LCP captured by the observer installed via evaluateOnNewDocument (reset each navigation).
  const lcp = Math.round((typeof window !== 'undefined' && window.__lcp) || 0);

  // Content proof: are tile VALUES in the DOM (SSR'd), or skeletons (client-fetch pending)?
  const bodyText = (document.body && document.body.innerText) || '';
  const content = {
    skeletons: document.querySelectorAll('.animate-pulse').length,
    // value-like strings (a number followed by a common unit) present in the rendered DOM
    renderedValues: (bodyText.match(/\d[\d.,]*\s?(kWh|kW|Wh|W|%|°|kV|V|A)\b/g) || []).length,
    bodyTextLen: bodyText.length,
    chartSkeleton: /Loading chart|chart-skeleton/i.test(document.body?.innerHTML || '') || undefined,
  };

  // SSR-render decomposition, surfaced inline by the (optionally instrumented) page render as a
  // <script id="__ssr_timing"> whose content is JSON.stringify("name;dur=1.2, name2;dur=3.4").
  // Robust to both the JSON-string form and a raw "name;dur=…" string.
  let ssrTiming = [];
  const ssrEl = document.getElementById('__ssr_timing');
  if (ssrEl) {
    let s = ssrEl.textContent || '';
    try { const p = JSON.parse(s); if (typeof p === 'string') s = p; else if (Array.isArray(p)) s = p.join(', '); } catch {}
    ssrTiming = s.split(', ').filter(Boolean);
  }

  return {
    count: es.length,
    settleRaw: Math.round(es.reduce((m, e) => Math.max(m, e.startTime + e.duration), 0)),
    nav: navOut, paint: paintOut, lcp, content, ssrTiming,
    entries: es.map(e => {
      const u = new URL(e.name);
      return {
        path: u.pathname, sys: u.searchParams.get('systemId'), sankey: e.name.includes('sankey'),
        start: Math.round(e.startTime), end: Math.round(e.startTime + e.duration), dur: Math.round(e.duration),
        // NOTE: responseStart/requestStart come back 0 under headless Chromium in Lambda (known quirk);
        // use `dur` for the browser rows and the node-level `health`/`document` probes for clean network.
        ttfb: Math.round(e.responseStart - e.requestStart), conn: Math.round(e.connectEnd - e.connectStart),
        st: stByUrl[e.name] || [], vid: vidByUrl[e.name] || null
      };
    })
  };
};

async function runBrowser() {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
  });
  const page = await browser.newPage();
  // Arm an LCP observer on every fresh document (before page scripts run), stashing the latest
  // largest-contentful-paint into window.__lcp for the harness to read after settle.
  await page.evaluateOnNewDocument(() => {
    window.__lcp = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
  });
  // warm-up (discarded) — connection is then reused across runs, matching the laptop protocol
  try { await page.goto(SHARED, { waitUntil: 'domcontentloaded', timeout: 30000 }); await new Promise(r => setTimeout(r, 6000)); } catch {}
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto(SHARED, { waitUntil: 'domcontentloaded', timeout: 30000 });
    runs.push(await page.evaluate(HARNESS));
  }
  await browser.close();
  return runs;
}

export const handler = async () => {
  const out = { region: process.env.AWS_REGION, target: SHARED, chromiumPath: null };
  // 1) guaranteed node-level network floors: 5x health (clean floor) + 5x the SSR document (SSR TTFB)
  out.health = [];
  for (let k = 0; k < 5; k++) out.health.push(await probe(HEALTH));
  out.document = [];
  for (let k = 0; k < 5; k++) out.document.push(await probe(SHARED));
  // 2) the real browser waterfall + SSR page timings
  try {
    out.chromiumPath = await chromium.executablePath();
    out.browserRuns = await runBrowser();
  } catch (e) {
    out.browserError = String((e && e.stack) || e);
  }
  return out;
};
