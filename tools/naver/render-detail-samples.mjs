#!/usr/bin/env node
// M1 — PC/mobile rendering verification for the 10 detailContent samples.
//
// Renders each generated sample HTML in headless Chromium (the local Chrome
// install, driven by playwright-core) at a desktop and a mobile viewport, and
// measures what a shopper would actually see:
//
//   - no horizontal overflow (the draft must not force sideways scrolling),
//   - every <img> resolved (naturalWidth > 0) — supplier images are hotlinked,
//     so a broken URL is a data defect the operator must see,
//   - the title block is visible at both widths.
//
// Screenshots go to reports/screenshots/detail-samples/ (gitignored; binary
// evidence stays local) and the assertions go to
// reports/data/registration/detail_samples/render_evidence.json (committed).
// This tool only reads local files and the sample pages' public images — it
// never calls the Commerce API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES_DIR = path.join(ROOT, 'reports/data/registration/detail_samples');
const SHOTS_DIR = path.join(ROOT, 'reports/screenshots/detail-samples');
const EVIDENCE = path.join(SAMPLES_DIR, 'render_evidence.json');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const VIEWPORTS = [
  { label: 'pc', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
];

const sampleFiles = fs.readdirSync(SAMPLES_DIR).filter((f) => /^sample-\d+-.*\.html$/.test(f)).sort();
if (sampleFiles.length === 0) {
  console.error('no sample files found — run backend/tools/m1-detail-samples.mjs first');
  process.exit(2);
}

const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('no Chrome/Edge executable found for playwright-core');
  process.exit(2);
}

fs.mkdirSync(SHOTS_DIR, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const context = await browser.newContext({ viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height } });
  const evidence = {
    kind: 'cgi-m1-detail-render-evidence',
    executable: path.basename(executablePath),
    generated_at: new Date().toISOString(),
    viewports: VIEWPORTS,
    samples: [],
    summary: null,
  };
  let allOk = true;

  const page = await context.newPage();
  for (const file of sampleFiles) {
    const url = 'file:///' + path.join(SAMPLES_DIR, file).replace(/\\/g, '/');
    const perSample = { file, viewports: {} };
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      // Supplier images are hotlinked; give them a bounded window to resolve
      // and record what actually happened instead of assuming.
      await page.evaluate(() => Promise.all(
        [...document.images].map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => { img.onload = img.onerror = resolve; setTimeout(resolve, 8000); })),
      ));
      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const imgs = [...document.images].map((img) => ({ src: img.src.slice(0, 120), loaded: img.complete && img.naturalWidth > 0, naturalWidth: img.naturalWidth }));
        const title = document.querySelector('h2');
        const visible = title ? title.getBoundingClientRect().width > 0 : false;
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          images: imgs,
          titleVisible: visible,
        };
      });
      const shot = path.join(SHOTS_DIR, `${file.replace(/\.html$/, '')}-${vp.label}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      const ok = !metrics.horizontalOverflow && metrics.titleVisible && metrics.images.every((img) => img.loaded);
      perSample.viewports[vp.label] = { ...metrics, screenshot: path.relative(ROOT, shot), ok };
      if (!ok) allOk = false;
    }
    evidence.samples.push(perSample);
  }
  await context.close();

  evidence.summary = { all_ok: allOk, sample_count: evidence.samples.length };
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  const failing = [];
  for (const sample of evidence.samples) {
    for (const [label, vp] of Object.entries(sample.viewports)) {
      if (!vp.ok) {
        failing.push(`${sample.file}/${label}: overflow=${vp.horizontalOverflow} title=${vp.titleVisible} brokenImages=${vp.images.filter((i) => !i.loaded).length}`);
      }
    }
  }
  console.log(JSON.stringify({ evidence: path.relative(ROOT, EVIDENCE), all_ok: allOk, sample_count: evidence.samples.length, failing }, null, 2));
  process.exit(allOk ? 0 : 1);
} finally {
  await browser.close();
}
