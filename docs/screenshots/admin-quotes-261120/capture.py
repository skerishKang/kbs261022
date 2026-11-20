# 390·1440 캡처: 관리자 견적서 목록 · 작성 · 정식 견적서 출력 미리보기.
# 정적 파일과 API 모두 로컬 서버(../ops-feedback-261120/localapi.mjs: 저장소의 worker.fetch + 메모리 DB)에서만 응답한다.
#   python3 capture.py <출력 폴더>
import json, sys, os, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/'
HERE = os.path.dirname(os.path.abspath(__file__))
LOGIN = open(os.path.join(HERE, '..', 'ops-feedback-261120', '.capture-login')).read().strip()
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
MEASURE = """() => { const de = document.documentElement;
  const over = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect();
    return r.width && r.right > de.clientWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.qp-sheet'); }).slice(0,5).map(el => el.tagName + '.' + el.className);
  return { overflowX: de.scrollWidth - de.clientWidth, over }; }"""
results = []

def page_for(browser, width):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, is_mobile=(width == 390), has_touch=(width == 390))
    page = ctx.new_page()
    log = {'c': [], 'h': []}
    page.on('console', lambda m: log['c'].append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda ex: log['c'].append('pageerror: ' + str(ex)))
    page.on('response', lambda r: log['h'].append(f'{r.status} {r.url.split("8765")[-1]}') if r.status >= 400 else None)
    page.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript',
        body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
    page.route(lambda u: not u.startswith('http://localhost:8765') and not u.startswith('data:'),
               lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
    return ctx, page, log

def errs(log):
    anon = [h for h in log['h'] if h.startswith('401 /api/me')]
    return {'consoleErrors': [c for c in log['c'] if not ('401' in c and anon)], 'httpErrors': [h for h in log['h'] if h not in anon]}

def login(page):
    page.goto(BASE + 'quotes.html'); page.wait_for_selector('#aqLoginForm')
    page.fill('#aqLoginForm [name=email]', 'skerish@naver.com'); page.fill('#aqLoginForm [name=password]', LOGIN)
    page.click('#aqLoginForm [type=submit]')
    page.wait_for_selector('#aqApp:not([hidden])')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    # 시험 견적 몇 장(화면과 같은 API 로)
    ctx, page, log = page_for(browser, 1440)
    login(page)
    seeded = page.evaluate("""async () => {
      const mk = (company, name, status, items, extra) => window.CGI_AUTH.api('POST', '/api/admin/quotes', Object.assign({ status, recipient: { company, name, phone: '062-000-0000' }, items }, extra || {}));
      const out = [];
      out.push((await mk('광주○○초등학교 행정실', '김행정', 'sent', [
        { kind: 'product', product_id: 'samamusic.co.kr:4306', qty: 2 },
        { kind: 'custom', name: '설치비', qty: 1, unit_price: 350000 }])).data.quote);
      out.push((await mk('○○교회', '박집사', 'won', [
        { kind: 'product', product_id: 'samamusic.co.kr:755', qty: 2, discount_type: 'pct', discount_value: 5 },
        { kind: 'custom', name: '출장비', qty: 1, unit_price: 100000 }])).data.quote);
      out.push((await mk('전남○○군청 총무과', '이주무관', 'draft', [
        { kind: 'product', product_id: 'samamusic.co.kr:117', name: 'PRESONUS StudioLive RM32 AI 프리소너스 믹서', qty: 1, unit_price: 4950000 },
        { kind: 'product', product_id: 'samamusic.co.kr:4061', qty: 1 },
        { kind: 'custom', name: '공사비', spec: '배관·배선', qty: 1, unit_price: 1200000, discount_type: 'amount', discount_value: 200000, memo: '현장 확인 후 확정' }],
        { delivery_terms: '발주 후 3주 이내 설치', payment_terms: '설치 완료 후 30일 이내 계좌 이체', valid_days: 30 })).data.quote);
      return out.map(q => ({ id: q.id, no: q.quote_no, total: q.total_amount, status: q.status }));
    }""")
    ctx.close()
    official_id = seeded[2]['id']
    for width in (390, 1440):
        # 1. 목록
        ctx, page, log = page_for(browser, width)
        login(page)
        page.wait_for_selector('[data-aq-row]'); page.wait_for_timeout(300)
        m = page.evaluate(MEASURE); m.update(errs(log))
        m.update({'scene': 'list', 'width': width, 'shot': f'list-{width}.png', 'rows': page.locator('[data-aq-row]').count()})
        page.screenshot(path=f'{OUT}/list-{width}.png', full_page=True)
        results.append(m)
        # 2. 작성: 받는 곳 고르기 + 카탈로그 검색 + 공개가·가격 문의·직접 입력 줄
        page.click('[data-action="aq-new"]'); page.wait_for_selector('[data-aq-field="company"]')
        page.wait_for_selector('[data-aq-recipient-pick]')
        page.select_option('[data-aq-recipient-pick]', index=1)
        page.fill('#aqItemQ', '무선마이크'); page.wait_for_selector('.aq-result', timeout=20000)
        page.click('.aq-result >> nth=0')
        page.fill('#aqItemQ', 'RM32'); page.wait_for_function("document.querySelectorAll('.aq-result').length > 0 && /RM32/i.test(document.querySelector('.aq-result').textContent)")
        inq = page.evaluate("[...document.querySelectorAll('.aq-result')].findIndex(b => /가격 문의/.test(b.textContent))")
        page.click(f'.aq-result >> nth={max(inq, 0)}')
        page.fill('.aq-line:nth-child(2) [data-aq-line="unit_price"]', '4950000')
        page.click('[data-action="aq-add-custom"][data-name="설치비"]')
        page.fill('.aq-line:nth-child(3) [data-aq-line="unit_price"]', '500000')
        page.select_option('.aq-line:nth-child(3) [data-aq-line="discount_type"]', 'pct')
        page.fill('.aq-line:nth-child(3) [data-aq-line="discount_value"]', '10')
        page.fill('.aq-line:nth-child(1) [data-aq-line="qty"]', '4')
        page.fill('[data-aq-field="delivery_terms"]', '발주 후 2주 이내')
        page.fill('#aqItemQ', '무선마이크'); page.wait_for_timeout(500)
        before = page.evaluate("({ total: document.querySelector('[data-aq-total]').textContent, korean: document.querySelector('[data-aq-korean]').textContent, lines: document.querySelectorAll('.aq-line').length, results: document.querySelectorAll('.aq-result').length })")
        m = page.evaluate(MEASURE); m.update(errs(log)); m.update({'scene': 'editor', 'width': width, 'shot': f'editor-{width}.png', **before})
        # 저장 줄은 화면 아래에 붙어 있다(sticky). 전체 페이지 캡처에서만 제자리에 두고 찍는다.
        page.add_style_tag(content='.aq-actions { position: static !important; }')
        page.evaluate("document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)"); page.wait_for_timeout(200)
        page.screenshot(path=f'{OUT}/editor-{width}.png', full_page=True)
        page.click('[data-action="aq-save"]'); page.wait_for_selector('#aqMsg .fb-alert.ok')
        m['saved'] = page.evaluate("({ msg: document.querySelector('#aqMsg').textContent, hash: location.hash, total: document.querySelector('[data-aq-total]').textContent })")
        results.append(m)
        ctx.close()
        # 3. 출력 미리보기 (정식 견적서)
        ctx, page, log = page_for(browser, width)
        login(page)
        page.goto(BASE + f'quotes.html#/q/{official_id}/print'); page.wait_for_selector('.qp-sheet'); page.wait_for_timeout(300)
        info = page.evaluate("""() => ({ no: document.querySelector('[data-quote-no]').textContent, total: document.querySelector('[data-quote-total]').textContent,
          korean: document.querySelector('[data-quote-korean]').textContent, provisional: !!document.querySelector('.qp-provisional, .qp-tag'),
          terms: [...document.querySelectorAll('.qp-terms th')].map(t => t.textContent), ecount: (document.querySelector('.aq-ecount') || {}).disabled,
          dataView: document.body.getAttribute('data-view') })""")
        m = page.evaluate(MEASURE); m.update(errs(log)); m.update({'scene': 'print', 'width': width, 'shot': f'print-{width}.png', **info, 'serverTotal': seeded[2]['total']})
        page.evaluate("window.scrollTo(0, 0)"); page.wait_for_timeout(100)
        page.screenshot(path=f'{OUT}/print-{width}.png', full_page=True)
        if width == 1440:
            page.emulate_media(media='print')
            page.pdf(path=f'{OUT}/print-A4.pdf', format='A4', print_background=True)
            m['pdf'] = 'print-A4.pdf'
        results.append(m)
        ctx.close()
    browser.close()
json.dump({'seeded': seeded, 'results': results}, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(seeded, ensure_ascii=False))
for r in results:
    print(json.dumps(r, ensure_ascii=False)[:600])
