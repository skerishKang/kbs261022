# 명예회원 1회차 화면 문제 캡처·측정.
# 서버: ../ops-feedback-261120/localapi.mjs (저장소 worker.fetch + 메모리 DB, localhost:8765) 를 먼저 띄운다.
#   node --experimental-sqlite docs/screenshots/ops-feedback-261120/localapi.mjs "$PWD"
#   python3 docs/screenshots/honor-member-ux-261120/capture.py docs/screenshots/honor-member-ux-261120
# 바깥 주소로 나가는 요청은 모두 막고(이미지는 1px 대체), API 는 로컬 서버만 쓴다.
import json, os, sys, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/'
LOGIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ops-feedback-261120', '.capture-login')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
LONG, PRICED, INQ = 'samamusic.co.kr:5552', 'samamusic.co.kr:100', 'samamusic.co.kr:117'
HEADER_JS = """() => { const r = s => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return {l:b.left, r:b.right, t:b.top, b:b.bottom}; };
  const els = {search: r('#searchForm'), btn: r('.btn-search'), cart: r('.header-cart'), nav: r('#siteNav'), brand: r('.brand')};
  const ov = (a, b) => a && b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  const overlaps = [['cart','search'],['cart','btn'],['nav','search'],['nav','btn'],['brand','search']].filter(([a,b]) => ov(els[a], els[b])).map(p => p.join('×'));
  const b = els.btn; const hitEl = b && document.elementFromPoint((b.l+b.r)/2, (b.t+b.b)/2);
  return { overlaps, searchButtonClickLandsOn: hitEl ? (hitEl.closest('.btn-search') ? '검색 버튼' : hitEl.closest('.header-cart') ? '장바구니' : (hitEl.textContent || hitEl.tagName).trim().slice(0, 20)) : null,
           headerHeight: Math.round(document.querySelector('.site-header').getBoundingClientRect().height) }; }"""
PAGE_JS = """() => { const de = document.documentElement;
  const over = [...document.querySelectorAll('body *')].filter(el => { const b = el.getBoundingClientRect(); return b.width && b.right > de.clientWidth + 1 && getComputedStyle(el).position !== 'fixed'; }).slice(0, 5).map(el => el.tagName + '.' + el.className);
  const name = document.querySelector('.cart-name'), rm = document.querySelector('.cart-remove');
  let nameCoveredByDelete = null;
  if (name && rm) { const a = name.getBoundingClientRect(), b = rm.getBoundingClientRect(); nameCoveredByDelete = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }
  return { overflowX: de.scrollWidth - de.clientWidth, overflowEls: over, nameCoveredByDelete, navOpen: !!document.querySelector('.site-header.nav-open') }; }"""

def page_for(browser, width, cart=None, mobile=False):
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
    if cart is not None:
        page.add_init_script("localStorage.setItem('cgiQuoteCart', JSON.stringify(%s));" % json.dumps([{'id': i, 'qty': 1} for i in cart]))
    return ctx, page, log

def errors(log):
    anon401 = [h for h in log['http'] if h.startswith('401 GET /api/me')]
    errs = [c for c in log['console'] if not ('401' in c and anon401)]
    return {'consoleErrors': errs, 'httpErrors': [h for h in log['http'] if h not in anon401], 'ignoredAnon401': len(anon401)}

def login_admin(page):
    page.goto(BASE + 'feedback.html')
    pw = open(LOGIN_FILE).read().strip()
    st = page.evaluate("async pw => (await fetch('http://localhost:8765/api/auth/login', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json','X-CSRF-Token':'http://localhost:8765'}, body: JSON.stringify({email:'skerish@naver.com', password: pw})})).status", pw)
    assert st == 200, st

results = []
def record(name, page, log, extra=None, full=True):
    page.wait_for_timeout(400)
    info = page.evaluate(PAGE_JS); info.update(errors(log)); info.update(extra or {})
    page.screenshot(path=f'{OUT}/{name}.png', full_page=full)
    info['shot'] = name + '.png'; results.append(info)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    # 1. 머리글 폭별(손님) + 관리자 로그인(메뉴가 가장 긴 경우)
    for who in ('guest', 'admin'):
        for w in (960, 1024, 1100, 1280, 1440):
            ctx, page, log = page_for(browser, w)
            if who == 'admin': login_admin(page)
            page.goto(BASE + 'index.html#/'); page.wait_for_selector('body[data-cgi-ready="1"]'); page.wait_for_timeout(300)
            h = page.evaluate(HEADER_JS)
            page.screenshot(path=f'{OUT}/header-{who}-{w}.png', clip={'x': 0, 'y': 0, 'width': w, 'height': h['headerHeight'] + 8})
            # 검색 버튼을 실제로 눌러 본다
            page.fill('#headerSearch', '마이크'); page.click('.btn-search'); page.wait_for_timeout(400)
            h['afterClickHash'] = page.evaluate('decodeURIComponent(location.hash)')
            h.update(errors(log)); h['shot'] = f'header-{who}-{w}.png'; results.append(h); ctx.close()
    # 390 · 1440 화면들
    for w in (390, 1440):
        mobile = w == 390
        ctx, page, log = page_for(browser, w, cart=[], mobile=mobile)
        page.goto(BASE + 'index.html#/products?q=StudioLive%20RM'); page.wait_for_selector('body[data-cgi-ready="1"]')
        record(f'list-inquiry-{w}', page, log, {'inquiryCardPriceWordCount': page.evaluate("(c => c ? (c.innerText.match(/가격 문의/g)||[]).length : null)(document.querySelector('.product-card[data-product-id=\"%s\"]'))" % INQ)}, full=False); ctx.close()

        ctx, page, log = page_for(browser, w, cart=[], mobile=mobile)
        page.goto(BASE + f'index.html#/product/{PRICED}'); page.wait_for_selector('body[data-cgi-ready="1"]')
        record(f'detail-{w}', page, log); ctx.close()

        ctx, page, log = page_for(browser, w, cart=[LONG, INQ], mobile=mobile)
        page.goto(BASE + 'index.html#/quote-cart'); page.wait_for_selector('body[data-cgi-ready="1"]')
        page.click('.cart-summary summary')
        preview = page.inner_text('#quoteCartText')
        record(f'quote-cart-{w}', page, log, {'previewLines': [l for l in preview.split('\n') if '|' in l], 'doublePriceWord': '가격 가격' in preview}); ctx.close()

        ctx, page, log = page_for(browser, w, cart=[LONG, INQ], mobile=mobile)
        page.goto(BASE + 'index.html#/checkout'); page.wait_for_selector('body[data-cgi-ready="1"]')
        record(f'checkout-pending-{w}', page, log, {'pendingRows': page.evaluate("[...document.querySelectorAll('.order-items-pending tbody tr td:first-child')].map(td => td.textContent)"),
                                                     'pricedRows': page.evaluate("[...document.querySelectorAll('.order-items-priced tbody tr td:first-child')].map(td => td.textContent.slice(0,30))")}); ctx.close()

        # 폭마다 다른 장바구니(같은 장바구니를 2분 안에 다시 주문하면 중복 주문 안내가 뜬다)
        ctx, page, log = page_for(browser, w, cart=[LONG] if mobile else [LONG, PRICED], mobile=mobile)
        page.goto(BASE + 'index.html#/checkout'); page.wait_for_selector('#orderForm')
        record(f'checkout-{w}', page, log, {'note': page.inner_text('.order-summary-note')})
        # 로컬 서버(메모리 DB)에만 주문을 만들어 결제 화면의 금액 표시를 본다 — 결제창은 열지 않는다
        page.fill('[name=company]', '(주)캡처'); page.fill('[name=name]', '홍길동'); page.fill('[name=phone]', '010-0000-0000'); page.fill('[name=email]', 'capture@example.com')
        page.check('[name=terms_consent]'); page.check('[name=privacy_consent]'); page.click('#orderForm button[type=submit]')
        page.wait_for_selector('#payBtn')
        record(f'payment-{w}', page, log, {'amountLine': page.inner_text('.payment-order')}); ctx.close()

        ctx, page, log = page_for(browser, w, mobile=mobile)
        page.goto(BASE + 'returns.html'); page.wait_for_load_state('networkidle')
        record(f'returns-{w}', page, log); ctx.close()

        if mobile:
            ctx, page, log = page_for(browser, w, mobile=True)
            page.goto(BASE + 'index.html#/'); page.wait_for_selector('body[data-cgi-ready="1"]')
            page.click('.nav-toggle'); page.wait_for_timeout(250)
            record('menu-open-390', page, log, full=False)
            page.fill('#headerSearch', 'shure'); page.keyboard.press('Enter')
            record('menu-after-search-390', page, log, {'hash': page.evaluate('location.hash')}, full=False)
            page.click('.nav-toggle'); page.wait_for_timeout(200); page.click('.header-cart')
            record('menu-after-cart-390', page, log, {'hash': page.evaluate('location.hash')}, full=False)
            ctx.close()
    browser.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results:
    keys = {k: v for k, v in r.items() if k not in ('shot',) and v not in (None, [], 0, False) or k in ('overflowX', 'overlaps', 'consoleErrors')}
    print(r['shot'], json.dumps(keys, ensure_ascii=False)[:400])
