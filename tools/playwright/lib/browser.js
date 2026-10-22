'use strict';
/**
 * Shared browser bootstrap + retry/evidence helpers for the samastore Playwright toolchain.
 *
 * Design goals (see tools/playwright/README.md):
 *   - one place to launch a real Chromium and to attach to the user's logged-in Chrome if needed
 *   - every network failure is retried with backoff and recorded as evidence
 *   - nothing in here can purchase / order / pay (no click ever targets a buy button)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE_DIR = path.join(ROOT, 'reports', 'evidence');
const SHOT_DIR = path.join(__dirname, '..', 'screenshots');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/153.0.0.0 Safari/537.36';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function evidencePath(name) {
  ensureDir(EVIDENCE_DIR);
  return path.join(EVIDENCE_DIR, name);
}

function shotPath(name) {
  ensureDir(SHOT_DIR);
  return path.join(SHOT_DIR, name.endsWith('.png') ? name : `${name}.png`);
}

/** Append a JSON line to the shared evidence log (errors, retries, timings). */
function logEvidence(file, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  fs.appendFileSync(evidencePath(file), `${line}\n`, 'utf8');
  return line;
}

/**
 * Run `fn` with retries. On failure the error + a screenshot (when a page is available)
 * is written to the evidence log so the run is auditable.
 */
async function withRetry(fn, { label, retries = 3, delayMs = 1500, evidenceFile = 'run-errors.jsonl' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      logEvidence(evidenceFile, {
        label,
        attempt,
        retries,
        error: String(err && err.message ? err.message : err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
      });
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw new Error(`[${label}] failed after ${retries} attempts: ${lastErr && lastErr.message}`);
}

/**
 * Launch a real Chromium. `headless:false` gives a visible browser window which is the
 * default for the "real browser" requirement; set SAMASTORE_HEADLESS=1 for CI.
 */
async function launch(opts = {}) {
  const headless = process.env.SAMASTORE_HEADLESS === '1' || opts.headless === true;
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent: opts.userAgent || DEFAULT_UA,
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  context.setDefaultTimeout(opts.timeout || 45000);
  context.setDefaultNavigationTimeout(opts.timeout || 60000);
  return { browser, context };
}

/** Polite delay between requests so we never hammer the storefront. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  ROOT,
  EVIDENCE_DIR,
  SHOT_DIR,
  DEFAULT_UA,
  ensureDir,
  evidencePath,
  shotPath,
  logEvidence,
  withRetry,
  launch,
  sleep,
};
