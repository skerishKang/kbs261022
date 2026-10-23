const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const TARGETS = (process.env.ERP_TARGETS || [
  '품목등록',
  '재고현황',
  '주문서조회',
  '매출전표',
  '엑셀자료올리기',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const EXTRACT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const o = {
    title: document.title,
    url: location.href.replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED'),
    bodyText: clean(document.body.innerText).slice(0, 3000),
  };
  o.grids = [...document.querySelectorAll('table')].map(t => ({
    id: t.id || null,
    cols: [...t.querySelectorAll('thead th')].map(th => clean(th.innerText)).filter(Boolean),
    rows: t.querySelectorAll('tbody tr').length,
  })).filter(g => g.cols.length);
  const f = {};
  [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].forEach(e => {
    const cid = e.getAttribute('data-cid');
    const key = cid || e.getAttribute('name') || e.id || null;
    if (!key || /^(tbody|thead)/.test(key)) return;
    const box = e.closest('.control-set, .form-group, .form-inline, td, li');
    const lab = box ? clean(box.querySelector('label,.tit,.field-label,.control-label')?.innerText) : '';
    if (!f[key]) f[key] = {
      key, cid: cid || null, name: e.getAttribute('name') || null,
      label: lab || e.getAttribute('placeholder') || e.getAttribute('title') || '',
      tag: e.tagName.toLowerCase(), type: e.type || null, ro: e.readOnly === true,
    };
  });
  o.fields = Object.values(f);
  o.buttons = [...new Set([...document.querySelectorAll('button, a.btn')].map(b => clean(b.innerText || b.value)).filter(Boolean))];
  o.tabs = [...new Set([...document.querySelectorAll('ul.nav-tabs li')].map(t => clean(t.innerText)).filter(Boolean))];
  o.labels = [...new Set([...document.querySelectorAll('label, .tit, .field-label, legend')].map(t => clean(t.innerText)).filter(t => t && t.length < 60))];
  o.selects = [...document.querySelectorAll('select')].map(s => ({
    id: s.id || s.getAttribute('data-cid') || null,
    options: [...s.options].map(op => clean(op.innerText)).filter(Boolean).slice(0, 80),
  })).filter(s => s.options.length);
  return o;
};

async function openProgram(page, label) {
  await page.fill('#inputFavMSearch', '');
  await page.type('#inputFavMSearch', label, { delay: 55 });
  await page.waitForTimeout(2400);
  const picked = await page.evaluate((wanted) => {
    const anchors = [...document.querySelectorAll('.ui-menu-item a')];
    const texts = anchors.map(a => (a.innerText || '').replace(/\s+/g, ' ').trim());
    let a = anchors.find(x => ((x.innerText || '').replace(/\s+/g, ' ').trim()) === wanted);
    if (!a) a = anchors.find(x => ((x.innerText || '').replace(/\s+/g, ' ').trim()).includes(wanted));
    if (!a) return { clicked: null, candidates: texts };
    const id = a.id || null;
    a.click();
    return { clicked: (a.innerText || '').trim(), id, candidates: texts };
  }, label);
  await page.waitForTimeout(6000);
  return picked;
}

async function dump(page, outDir, name) {
  const data = await page.evaluate(EXTRACT);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  return data;
}

(async () => {
  const comCode = requireEnv('ECOUNT_COM_CODE');
  const userId = requireEnv('ECOUNT_USER_ID');
  const password = requireEnv('ECOUNT_PASSWORD');
  const outDir = process.env.ERP_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'reports', 'data', 'erp', 'live');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  await page.goto('https://login.ecount.com/Login?lan_type=ko-KR', { waitUntil: 'networkidle' });
  await page.fill('#com_code', comCode);
  await page.fill('#id', userId);
  await page.fill('#passwd', password);
  await page.click('#save');
  await page.waitForTimeout(9000);

  const summary = { login_url: page.url().replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED'), targets: {} };

  for (const label of TARGETS) {
    const safe = label.replace(/[^\w가-힣-]/g, '_');
    try {
      const nav = await openProgram(page, label);
      const data = await dump(page, outDir, `probe_${safe}`);
      summary.targets[label] = {
        clicked: nav.clicked,
        title: data.title,
        url: data.url,
        grids: data.grids.map(g => ({ id: g.id, cols: g.cols.length, rows: g.rows })),
        buttons: data.buttons.slice(0, 40),
        tabs: data.tabs,
      };
    } catch (e) {
      summary.targets[label] = { error: e.message.slice(0, 300) };
    }
  }

  summary.console_errors = errors.slice(0, 20);
  fs.writeFileSync(path.join(outDir, 'probe_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
})();
