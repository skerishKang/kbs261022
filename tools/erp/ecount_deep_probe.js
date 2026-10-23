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

const EXTRACT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const o = { title: document.title, url: location.href.replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED') };
  o.grids = [...document.querySelectorAll('table')].map(t => ({
    id: t.id || null,
    cols: [...t.querySelectorAll('thead th')].map(th => clean(th.innerText)).filter(Boolean),
    rows: t.querySelectorAll('tbody tr').length,
  })).filter(g => g.cols.length);
  o.buttons = [...new Set([...document.querySelectorAll('button, a.btn')].map(b => clean(b.innerText || b.value)).filter(Boolean))];
  o.tabs = [...new Set([...document.querySelectorAll('ul.nav-tabs li')].map(t => clean(t.innerText)).filter(Boolean))];
  o.fields = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].map(e => {
    const cid = e.getAttribute('data-cid');
    const box = e.closest('.control-set, .form-group, .form-inline, td, li');
    const lab = box ? clean(box.querySelector('label,.tit,.field-label,.control-label')?.innerText) : '';
    return {
      key: cid || e.getAttribute('name') || e.id || null,
      cid: cid || null,
      name: e.getAttribute('name') || null,
      label: lab || e.getAttribute('placeholder') || e.getAttribute('title') || '',
      tag: e.tagName.toLowerCase(),
      type: e.type || null,
      ro: e.readOnly === true,
      value: (e.type === 'checkbox' || e.type === 'radio') ? String(e.checked) : clean(e.value).slice(0, 40),
    };
  }).filter(f => f.key);
  o.selects = [...document.querySelectorAll('select')].map(s => ({
    key: s.getAttribute('data-cid') || s.id || s.name || null,
    label: clean(s.closest('.control-set, .form-group, td, li')?.querySelector('label,.tit,.control-label')?.innerText || ''),
    options: [...s.options].map(op => clean(op.innerText)).filter(Boolean).slice(0, 120),
  })).filter(s => s.options.length);
  o.visibleText = clean(document.body.innerText).slice(0, 4000);
  return o;
};

async function openProgram(page, label) {
  await page.fill('#inputFavMSearch', '');
  await page.type('#inputFavMSearch', label, { delay: 55 });
  await page.waitForTimeout(2400);
  const picked = await page.evaluate((wanted) => {
    const anchors = [...document.querySelectorAll('.ui-menu-item a')];
    let a = anchors.find(x => ((x.innerText || '').replace(/\s+/g, ' ').trim()) === wanted);
    if (!a) a = anchors.find(x => ((x.innerText || '').replace(/\s+/g, ' ').trim()).includes(wanted));
    if (!a) return { clicked: null, candidates: anchors.map(x => (x.innerText || '').trim()) };
    a.click();
    return { clicked: (a.innerText || '').trim(), id: a.id || null };
  }, label);
  await page.waitForTimeout(6000);
  return picked;
}

async function clickButton(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('button, a.btn, a')].find(x => norm(x.innerText || x.value) === t);
    if (!el) return false;
    el.click();
    return true;
  }, text);
}

async function capturePage(page, outDir, name) {
  const data = await page.evaluate(EXTRACT);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  return data;
}

async function capturePopups(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('.dropdown-menu, .ui-menu, .modal, .popup, .layer')]
      .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    return els.map(e => clean(e.innerText).slice(0, 1500)).filter(Boolean).slice(0, 10);
  });
}

async function closeModal(page) {
  const closed = await clickButton(page, '닫기') || await clickButton(page, '취소');
  if (!closed) await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
}

async function saveDownload(page, outDir, filename, action) {
  const dlP = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
  await action();
  const dl = await dlP;
  if (!dl) return null;
  const dest = path.join(outDir, filename);
  await dl.saveAs(dest);
  return { path: dest, suggested: dl.suggestedFilename() };
}

(async () => {
  const phase = (process.env.PHASE || 'A').toUpperCase();
  const comCode = requireEnv('ECOUNT_COM_CODE');
  const userId = requireEnv('ECOUNT_USER_ID');
  const password = requireEnv('ECOUNT_PASSWORD');
  const outDir = process.env.ERP_EVIDENCE_DIR || path.join(__dirname, '..', '..', 'reports', 'data', 'erp', 'live');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const out = { phase, steps: {} };

  await page.goto('https://login.ecount.com/Login?lan_type=ko-KR', { waitUntil: 'networkidle' });
  await page.fill('#com_code', comCode);
  await page.fill('#id', userId);
  await page.fill('#passwd', password);
  await page.click('#save');
  await page.waitForTimeout(9000);

  try {
    if (phase === 'A') {
      let nav = await openProgram(page, '품목등록');
      out.steps.item_list = { nav, data: await capturePage(page, outDir, 'item_list') };

      const opened = await clickButton(page, '신규(F2)');
      await page.waitForTimeout(2500);
      out.steps.item_new = { opened, data: await capturePage(page, outDir, 'item_new') };
      await closeModal(page);

      const dl = await saveDownload(page, outDir, 'item_export_excel_click.xlsx', async () => {
        out.steps.item_excel_clicked = await clickButton(page, 'Excel');
      });
      await page.waitForTimeout(1500);
      out.steps.item_excel = { download: dl, popups: await capturePopups(page) };
      await closeModal(page);

      nav = await openProgram(page, '재고현황');
      const searched = await clickButton(page, '검색(F8)');
      await page.waitForTimeout(6000);
      out.steps.inventory = { nav, searched, data: await capturePage(page, outDir, 'inventory') };
      const invDl = await saveDownload(page, outDir, 'inventory_export_excel_click.xlsx', async () => {
        out.steps.inventory_excel_clicked = await clickButton(page, 'Excel');
      });
      await page.waitForTimeout(1500);
      out.steps.inventory_excel = { download: invDl, popups: await capturePopups(page) };
      await closeModal(page);

      nav = await openProgram(page, '매출전표 I');
      out.steps.sales_slip = { nav, data: await capturePage(page, outDir, 'sales_slip') };
      const slipOpened = await clickButton(page, '신규(F2)');
      await page.waitForTimeout(2500);
      out.steps.sales_slip_new = { opened: slipOpened, data: await capturePage(page, outDir, 'sales_slip_new') };
      await closeModal(page);
    } else if (phase === 'B') {
      let nav = await openProgram(page, '엑셀자료올리기');
      await page.waitForTimeout(1500);
      out.steps.excel_uploader = { nav, data: await capturePage(page, outDir, 'excel_uploader') };

      const tpl = await saveDownload(page, outDir, 'ecount_template.xlsx', async () => {
        out.steps.template_clicked = await clickButton(page, '엑셀서식내려받기');
      });
      out.steps.template = tpl;
      await page.waitForTimeout(500);

      nav = await openProgram(page, '쇼핑몰등록');
      out.steps.mall_list = { nav, data: await capturePage(page, outDir, 'mall_list') };
      const mallOpened = await clickButton(page, '신규(F2)');
      await page.waitForTimeout(2500);
      out.steps.mall_new = { opened: mallOpened, data: await capturePage(page, outDir, 'mall_new') };

      const selected = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        for (const s of document.querySelectorAll('select')) {
          const opt = [...s.options].find(o => clean(o.innerText).includes('스마트스토어'));
          if (opt) {
            s.value = opt.value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return { select: s.id || s.getAttribute('data-cid'), option: clean(opt.innerText) };
          }
        }
        return null;
      });
      await page.waitForTimeout(2500);
      out.steps.mall_new_smartstore = { selected, data: await capturePage(page, outDir, 'mall_new_smartstore') };
      await closeModal(page);

      nav = await openProgram(page, '데이터내보내기');
      out.steps.data_export = { nav, data: await capturePage(page, outDir, 'data_export') };
    }
  } catch (e) {
    out.error = e.message.slice(0, 500);
    await page.screenshot({ path: path.join(outDir, `error_${phase}.png`) }).catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, `deep_probe_${phase}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ phase, steps: Object.fromEntries(Object.entries(out.steps).map(([k, v]) => [k, v && v.data ? { title: v.data.title, grids: v.data.grids.map(g => [g.id, g.cols.length, g.rows]), buttons: v.data.buttons.slice(0, 30), tabs: v.data.tabs } : v])), error: out.error }, null, 2));
  await browser.close();
})();
