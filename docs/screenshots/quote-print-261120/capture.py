# 견적서 출력 캡처·인쇄 미리보기 PDF.
# 서버: ../ops-feedback-261120/localapi.mjs (저장소 worker.fetch + 메모리 DB, localhost:8765) 를 먼저 띄운다.
#   node --experimental-sqlite docs/screenshots/ops-feedback-261120/localapi.mjs "$PWD"
#   python3 docs/screenshots/quote-print-261120/capture.py docs/screenshots/quote-print-261120
# 바깥 주소 요청은 모두 막는다. window.print 는 호출 횟수만 센다(인쇄 대화상자는 page.pdf 로 대신 확인).
import json, os, sys, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
CART = [{'id': 'samamusic.co.kr:5552', 'qty': 1}, {'id': 'samamusic.co.kr:100', 'qty': 2}, {'id': 'samamusic.co.kr:117', 'qty': 1}]
SERVICES = ['installation', 'as']

def new_page(browser, width, cart, mobile=False):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, is_mobile=mobile, has_touch=mobile)
    page = ctx.new_page()
    log = {'console': [], 'http': []}
    page.on('console', lambda m: log['console'].append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda ex: log['console'].append('pageerror: ' + str(ex)))
    page.on('response', lambda r: log['http'].append(f'{r.status} {r.request.method} {r.url.split("8765")[-1]}') if r.status >= 400 else None)
    page.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript',
        body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
    page.route(lambda u: not u.startswith('http://localhost:8765') and not u.startswith('data:'),
               lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
    page.add_init_script("window.__printCalls = 0; window.print = function () { window.__printCalls++; };"
                         "localStorage.setItem('cgiQuoteCart', %s); localStorage.setItem('cgiQuoteCartServices', %s);" % (json.dumps(json.dumps(cart)), json.dumps(json.dumps(SERVICES))))
    return ctx, page, log

def errors(log):
    anon = [h for h in log['http'] if h.startswith('401 GET /api/me')]
    return {'consoleErrors': [c for c in log['console'] if not ('401' in c and anon)], 'httpErrors': [h for h in log['http'] if h not in anon], 'ignoredAnon401': len(anon)}

METRICS = """() => { const de = document.documentElement; const t = s => (document.querySelector(s) || {}).textContent || null;
  return { overflowX: de.scrollWidth - de.clientWidth, hash: location.hash, printCalls: window.__printCalls,
    number: t('[data-quote-no]'), korean: t('[data-quote-korean]'), supplied: t('[data-quote-supplied]'), vat: t('[data-quote-vat]'), total: t('[data-quote-total]'),
    inquiryNote: t('[data-quote-inquiry]'), toCompany: (document.querySelector('.qp-to .qp-fill') || {}).textContent || null,
    rows: document.querySelectorAll('.qp-items tbody tr').length }; }"""

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w in (390, 1440):
        ctx, page, log = new_page(browser, w, CART, mobile=(w == 390))
        page.goto(BASE + 'index.html#/quote-cart'); page.wait_for_selector('body[data-cgi-ready="1"]')
        page.fill('#quoteCartForm [name=company]', '○○초등학교 방송실'); page.fill('#quoteCartForm [name=name]', '김선생')
        page.locator('.cart-print-btn').scroll_into_view_if_needed(); page.wait_for_timeout(200)
        page.screenshot(path=f'{OUT}/quote-cart-button-{w}.png', full_page=False)
        page.click('.cart-print-btn')
        page.wait_for_selector('.qp-sheet'); page.wait_for_timeout(700)
        m = page.evaluate(METRICS); m.update(errors(log)); m['shot'] = f'quote-print-{w}.png'
        page.screenshot(path=f'{OUT}/quote-print-{w}.png', full_page=True)
        # 인쇄 버튼을 다시 눌러도 인쇄가 호출되고 번호는 그대로
        page.click('[data-action="quote-print-now"]'); page.wait_for_timeout(200)
        m['printCallsAfterButton'] = page.evaluate('window.__printCalls')
        m['numberAfterReload'] = (page.reload(), page.wait_for_selector('.qp-sheet'), page.wait_for_timeout(500), page.evaluate("document.querySelector('[data-quote-no]').textContent"))[3]
        m['printCallsAfterReload'] = page.evaluate('window.__printCalls')
        if w == 1440:
            page.emulate_media(media='print')
            page.screenshot(path=f'{OUT}/quote-print-print-media-1440.png', full_page=True)
            m['printHidden'] = page.evaluate("['.site-header','.site-footer','.notice-bar','.qp-toolbar'].map(s => [s, getComputedStyle(document.querySelector(s)).display])")
            page.pdf(path=f'{OUT}/quote-print-preview.pdf', format='A4', print_background=True, prefer_css_page_size=True)
        results.append(m); ctx.close()
    # 품목이 많으면 자연스럽게 다음 장으로(머리칸 반복) — 확인용 PDF
    many = [{'id': f'samamusic.co.kr:{i}', 'qty': 1} for i in range(100, 160)]
    ctx, page, log = new_page(browser, 1440, many)
    page.goto(BASE + 'index.html#/quote-print'); page.wait_for_selector('.qp-sheet'); page.wait_for_timeout(500)
    page.emulate_media(media='print')
    page.pdf(path=f'{OUT}/quote-print-many-items.pdf', format='A4', print_background=True, prefer_css_page_size=True)
    mm = page.evaluate(METRICS); mm.update(errors(log)); mm['shot'] = 'quote-print-many-items.pdf'; results.append(mm); ctx.close()
    browser.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results: print(json.dumps(r, ensure_ascii=False))
