import https from 'node:https';
import { performance } from 'node:perf_hooks';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Override via Lambda env to point at a fresh share token / different dashboard.
const SHARED = process.env.TARGET_URL || 'https://www.liveone.energy/dashboard/id/5?access=honest-buttery-tapir';
const HEALTH = process.env.HEALTH_URL || 'https://www.liveone.energy/api/health';
const RUNS = Number(process.env.RUNS || 10);

// ---- node-level TTFB probe (raw https, always works even if chromium fails) ----
function probe(url) {
  return new Promise((resolve) => {
    const t = { url };
    const start = performance.now();
    const req = https.get(url, { headers: { 'user-agent': 'liveone-perf/1.0' } }, (res) => {
      t.status = res.statusCode;
      t.xServerTiming = res.headers['x-server-timing'] || null;
      t.xVercelId = res.headers['x-vercel-id'] || null;
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
const HARNESS = async () => {
  const maxWaitMs = 30000, quietMs = 4000, pollMs = 400;
  const t0 = performance.now(); let lc = -1, lm = -1, ss = null;
  while (performance.now() - t0 < maxWaitMs) {
    const es = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
    const c = es.length, me = es.reduce((m, e) => Math.max(m, e.startTime + e.duration), 0);
    if (c === lc && me === lm && c > 0) { if (ss === null) ss = performance.now(); if (performance.now() - ss >= quietMs) break; }
    else { ss = null; lc = c; lm = me; }
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
  return {
    count: es.length,
    entries: es.map(e => {
      const u = new URL(e.name);
      return {
        path: u.pathname, sys: u.searchParams.get('systemId'), sankey: e.name.includes('sankey'),
        start: Math.round(e.startTime), end: Math.round(e.startTime + e.duration), dur: Math.round(e.duration),
        // NOTE: responseStart/requestStart come back 0 under headless Chromium in Lambda (known quirk);
        // use `dur` for the browser rows and the node-level `health` probe for the clean network floor.
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
  // 1) guaranteed node-level network floor: 5x health
  out.health = [];
  for (let k = 0; k < 5; k++) out.health.push(await probe(HEALTH));
  // 2) the real browser waterfall
  try {
    out.chromiumPath = await chromium.executablePath();
    out.browserRuns = await runBrowser();
  } catch (e) {
    out.browserError = String((e && e.stack) || e);
  }
  return out;
};
