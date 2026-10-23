'use strict';
/*
 * 나라장터(G2B) 공개 입찰공고 수집기 (Playwright).
 *
 * 중단된 debug7.js와 달리 조달 사이트가 아니라 CGI 쇼핑몰 staff.html의
 * window.CGI_PRODUCTS만 기다리는 구조였으므로 본 작업과 무관하다. 이 수집기는
 * 실제 페이지 구조에 맞춰 다음을 수행한다:
 *   - 페이지 로드 단계별 상태 기록
 *   - 메인 응답 HTTP 상태 / 최종 도착 URL / JavaScript 오류 확인
 *   - 네트워크 postback(JSON/XML)과 실제 DOM 그리드 양쪽에서 공고 행 추출
 *   - 고정 전역 변수가 아닌 실제 공고행 셀렉터 기반 유한 대기 (무한 대기 방지)
 *   - 이미 열린 브라우저(--cdp/--ws) 또는 영구 프로파일(--profile) 재사용
 *   - 실패 시 최소 진단 정보만 파일로 저장
 *
 * 출력 스키마는 tools/procurement/g2b_bid_analysis.py의 normalize()가 바로 소비한다.
 * 위조 금지: 실제 페이지에서 확인된 항목만 내보낸다.
 */
const path = require('path');
const fs = require('fs');
const PW = 'D:/1022/1022-2/kbs261022/tools/playwright/node_modules/playwright';
const { chromium } = require(PW);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const OUT_DIR = 'D:/1022/1022-2/kbs261022/reports/data/procurement';
const SELFTEST = arg('selftest', false); // validate extraction against a local fixture, no live site
const FIXTURE = 'file:///' + path.join(__dirname, 'fixtures', 'notice_results_fixture.html').replace(/\\/g, '/');
const SEARCH_URL = SELFTEST ? FIXTURE : arg('url', 'https://www.g2b.go.kr/bidselect/bidsrch/BBID0001.do');
const WAIT_MS = parseInt(arg('wait', '25000'), 10);
const KEYWORD = arg('keyword', ''); // optional client-side filter on title
const CDP = arg('cdp', '');         // connect to an already-open browser
const WS = arg('ws', '');           // connect over websocket endpoint
const PROFILE = arg('profile', ''); // persistent context dir to reuse
const OUT = arg('out', SELFTEST ? path.join(OUT_DIR, '_selftest_collected.json') : path.join(OUT_DIR, 'collected_bids.json'));

const log = (...a) => console.log('[collector]', ...a);

// Fields captured from any real notice source (network JSON or DOM).
function coerceBid(o) {
  const bid_no = o.bid_no || o.bidNtceNo || o.bldNo || o.ntceNo || null;
  const title = o.title || o.bidNtceNm || o.ntceNm || o.salePrcWthgDtlNm || null;
  const agency = o.agency || o.dminsttNm || o.insttNm || o.demandInsttNm || null;
  const region = o.region || o.bidRgnNm || o.rgnNm || null;
  const category = o.category || o.purchContraMthdNm || o.bidClsfcNm || o.bsnsDivNm || null;
  const notice_date = o.notice_date || o.dltlPubnDt || o.bidNtceDt || o.etsPrceNoticeDlBgyUn || o.pubnDt || null;
  const close_date = o.close_date || o.bidClsseDt || o.bareDclsdDt || o.bidClseDt || null;
  let detail_url = o.detail_url || o.bidNtceDtlUrl || o.bidDtlUrl || null;
  if (detail_url && detail_url.startsWith('/')) detail_url = 'https://www.g2b.go.kr' + detail_url;
  if (!bid_no && !title) return null;
  return {
    bid_no, title, agency, region, category,
    notice_date, close_date, detail_url,
    status: o.status || o.bidSttusNm || '공고',
    estimated_price: o.estimated_price || o.estntPrcAmt || o.presmptPrce || o.asignBdgtAmt || null,
    data_source: 'live:g2b.go.kr',
  };
}

// Parse any JSON/XML-ish network payload that carries notice rows.
function harvestFromText(text, sink) {
  if (!text || text.length < 8) return;
  let obj = null;
  try { obj = JSON.parse(text); } catch (_) { /* not json */ }
  if (obj) {
    const found = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === 'object') {
        if (n.bidNtceNo || n.bidNtceNm || n.ntceNo) found.push(n);
        Object.values(n).forEach(walk);
      }
    };
    walk(obj);
    found.forEach((r) => { const c = coerceBid(r); if (c) sink.set(c.bid_no || c.title, c); });
  }
}

// Extract grid rows from the live DOM (WebSquare grids render into tables/divs).
async function harvestFromDom(page, sink) {
  const rows = await page.evaluate(() => {
    const out = [];
    const pick = (txt) => (txt || '').trim().replace(/\s+/g, ' ');
    document.querySelectorAll('table tr').forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => pick(c.innerText));
      if (cells.join('').length < 6) return;
      const link = tr.querySelector('a[href]');
      out.push({ cells, href: link ? link.href : null, text: pick(tr.innerText) });
    });
    return out;
  });
  const BID_RE = /\b(R\d{2}[A-Z]K\d{5,}(?:-\d{1,4})?|R\d{2}[A-Z]\d{6,})\b/;
  for (const r of rows) {
    const m = r.text.match(BID_RE);
    const nonEmpty = r.cells.filter((c) => c && !/^(단계구분|번호|상태|작성일|마감일|no|title)$/i.test(c));
    // A genuine notice row needs an official bid-notice number (R..K..-..) OR a
    // g2b notice detail link, plus real content (>=2 substantive cells).
    // Calendar/datepicker widgets and header-only rows are rejected.
    const hasAnchor = r.href && /g2b\.go\.kr/i.test(r.href) && /bid|ntce|invt/i.test(r.href);
    if (!m && !hasAnchor) continue;
    if (nonEmpty.length < 2) continue;
    if (!m && !hasAnchor) continue;
    const c = coerceBid({
      bid_no: m ? m[1] : null,
      title: nonEmpty[0] || r.text.slice(0, 80),
      agency: nonEmpty[1] || null,
      detail_url: r.href,
    });
    if (c && (c.bid_no || c.detail_url)) sink.set(c.bid_no || c.detail_url || c.title, c);
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const diagnostics = {
    started_at: new Date().toISOString(),
    search_url: SEARCH_URL,
    final_url: null,
    http_status: null,
    page_errors: [],
    console_errors: [],
    load_stages: [],
    network_hits: 0,
  };

  const sink = new Map();
  const netbodies = [];

  let browser, context, reuse = false;
  if (CDP) {
    log('reusing browser via CDP', CDP);
    browser = await chromium.connectOverCDP(CDP);
    context = browser.contexts()[0] || (await browser.newContext());
    reuse = true;
  } else if (WS) {
    log('reusing browser via WS', WS);
    browser = await chromium.connect(WS);
    context = browser.contexts()[0] || (await browser.newContext());
    reuse = true;
  } else if (PROFILE) {
    log('persistent profile', PROFILE);
    context = await chromium.launchPersistentContext(PROFILE, { headless: true });
    browser = context; // close() via context
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
  }

  const page = context.pages && context.pages[0] ? context.pages[0] : await context.newPage();

  page.on('pageerror', (e) => diagnostics.page_errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') diagnostics.console_errors.push(m.text()); });
  page.on('request', (r) => { if (r.resourceType() === 'document') diagnostics.load_stages.push('request:' + r.url().slice(0, 120)); });
  page.on('response', async (res) => {
    const u = res.url();
    diagnostics.network_hits++;
    if (/bid|ntce|annc|invt|Bid|Ntce/i.test(u)) {
      try {
        const ct = res.headers()['content-type'] || '';
        if (/json|xml|text/i.test(ct)) {
          const body = await res.text();
          netbodies.push({ url: u.slice(0, 160), status: res.status(), sample: body.slice(0, 4000) });
          harvestFromText(body, sink);
        }
      } catch (_) { /* body not readable (streamed/binary) */ }
    }
  });

  diagnostics.load_stages.push('goto');
  let resp;
  try {
    resp = await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });
  } catch (e) {
    diagnostics.goto_error = e.message;
    log('GOTO failed:', e.message);
  }
  diagnostics.http_status = resp ? resp.status() : null;
  diagnostics.final_url = page.url();
  diagnostics.load_stages.push('domcontentloaded');

  // Structure-aware bounded wait: real notice rows, NOT a fixed global variable.
  try {
    await page.waitForFunction(() => {
      const txt = document.body ? document.body.innerText : '';
      if (/R\d{2}B?K\d{6,}/.test(txt)) return true;
      const rows = document.querySelectorAll('table tr');
      for (const r of rows) if (/공고|입찰/.test(r.innerText) && r.querySelectorAll('td,th').length > 2) return true;
      return false;
    }, null, { timeout: WAIT_MS });
    diagnostics.load_stages.push('rows:present');
  } catch (e) {
    diagnostics.wait_error = e.message;
    diagnostics.load_stages.push('rows:absent(timeout)');
    log('notice grid did not populate within budget:', e.message);
  }

  await harvestFromDom(page, sink);
  netbodies.forEach((n) => harvestFromText(n.sample, sink));

  const collected = Array.from(sink.values());
  const filtered = KEYWORD
    ? collected.filter((b) => (b.title || '').includes(KEYWORD) || (b.agency || '').includes(KEYWORD))
    : collected;

  fs.writeFileSync(OUT, JSON.stringify({
    meta: { collected_at: new Date().toISOString(), source: SEARCH_URL, count: filtered.length },
    bids: filtered,
  }, null, 2), 'utf-8');

  diagnostics.finished_at = new Date().toISOString();
  diagnostics.rows_found = filtered.length;
  fs.writeFileSync(path.join(OUT_DIR, 'collector_diagnostics.json'), JSON.stringify(diagnostics, null, 2), 'utf-8');

  log('DONE. rows_found=', filtered.length, 'http_status=', diagnostics.http_status, 'final_url=', diagnostics.final_url);

  if (SELFTEST) {
    const ok = filtered.length >= 3 && filtered.every((b) => b.bid_no && b.title);
    log('SELFTEST', ok ? 'PASS' : 'FAIL', 'rows=', filtered.length);
    if (!ok) process.exitCode = 1;
    try { fs.unlinkSync(OUT); } catch (_) {}
    try { fs.unlinkSync(path.join(OUT_DIR, 'collector_diagnostics.json')); } catch (_) {}
  }

  if (!reuse) await browser.close();
  else log('reused browser kept open; closing page only');
  if (reuse && context.close) { /* leave browser open for the operator */ }
})().catch((e) => {
  log('FATAL', e && e.stack || e);
  process.exit(1);
});
