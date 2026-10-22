// 이카운트 ERP 화면 구조 프로브 (읽기 전용)
// 사용법:
//   node ecount_screen_probe.js --targets 품목등록,거래처등록,쇼핑몰등록
//   node ecount_screen_probe.js --menu-list          # 프로그램 목록만
//
// 주의:
//   - 계정정보는 이 스크립트가 받지 않는다. 로그인 세션이 이미 있는 브라우저 컨텍스트를 전제로 한다.
//   - 읽기 전용. '저장(F8)', '저장/전표(F7)', '키발급', '자료올리기' 실행, '선택삭제' 는 누르지 않는다.
//   - 출력 JSON 에는 ec_req_sid 를 포함하지 않는다.

const { chromium } = require('playwright');

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const targets = (arg('--targets', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const outFile = arg('--out', 'ecount_screens.json');
const settle = Number(arg('--settle', '5000'));

const EXTRACT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const o = {
    title: document.title,
    url: location.href.replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED'),
  };
  o.grids = [...document.querySelectorAll('table')]
    .map((t) => ({
      id: t.id || null,
      cols: [...t.querySelectorAll('thead th')].map((th) => clean(th.innerText)).filter(Boolean),
      rowCount: t.querySelectorAll('tbody tr').length, // 행 개수만. 값은 취하지 않는다
    }))
    .filter((g) => g.cols.length);
  const f = {};
  [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].forEach((e) => {
    const cid = e.getAttribute('data-cid');
    const key = cid || e.getAttribute('name') || e.id || null;
    if (!key || /^(tbody|thead)/.test(key)) return;
    const box = e.closest('.control-set, .form-group, .form-inline, td, li');
    const lab = box ? clean(box.querySelector('label,.tit,.field-label,.control-label')?.innerText) : '';
    if (!f[key]) {
      f[key] = {
        key,
        cid: cid || null,
        name: e.getAttribute('name') || null,
        label: lab || e.getAttribute('placeholder') || e.getAttribute('title') || '',
        tag: e.tagName.toLowerCase(),
        type: e.type || null,
        readonly: e.readOnly === true,
      };
    }
  });
  o.fields = Object.values(f);
  o.buttons = [...new Set([...document.querySelectorAll('button, a.btn')].map((b) => clean(b.innerText || b.value)).filter(Boolean))];
  o.tabs = [...new Set([...document.querySelectorAll('ul.nav-tabs li')].map((t) => clean(t.innerText)).filter(Boolean))];
  o.labels = [...new Set([...document.querySelectorAll('label, .tit, .field-label, legend')].map((t) => clean(t.innerText)).filter((t) => t && t.length < 60))];
  return o;
};

async function openMenu(page, name) {
  await page.fill('#inputFavMSearch', '');
  await page.type('#inputFavMSearch', name, { delay: 50 });
  await page.waitForTimeout(2100);
  const hit = await page.evaluate((n) => {
    const a = [...document.querySelectorAll('.ui-menu-item a')].find((x) => x.innerText.trim() === n);
    if (a) {
      a.click();
      return a.id;
    }
    return null;
  }, name);
  if (!hit) {
    const suggestions = await page.evaluate(() => [...document.querySelectorAll('.ui-menu-item a')].map((a) => a.innerText.trim()));
    return { ok: false, suggestions };
  }
  await page.waitForTimeout(settle);
  return { ok: true, hit };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  const page = await ctx.newPage();
  const results = [];
  for (const t of targets) {
    const r = await openMenu(page, t);
    if (!r.ok) {
      results.push({ target: t, error: 'menu_not_found', suggestions: r.suggestions });
      continue;
    }
    const info = await page.evaluate(EXTRACT);
    results.push({
      target: t,
      menuId: r.hit,
      programId: (page.url().match(/prgId=([A-Z0-9]+)/) || [])[1] || null,
      menuSeq: (page.url().match(/menuSeq=([A-Z0-9_]+)/) || [])[1] || null,
      groupSeq: (page.url().match(/groupSeq=([A-Z0-9_]+)/) || [])[1] || null,
      ...info,
    });
  }
  require('fs').writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results.map((r) => ({ t: r.target, prg: r.programId, g: (r.grids || []).length, f: (r.fields || []).length, err: r.error })), null, 1));
  await browser.close();
})();
