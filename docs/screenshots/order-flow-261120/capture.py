import json, sys, base64, threading, http.server, functools, os
from playwright.sync_api import sync_playwright

ROOT = sys.argv[1]; OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
handler = functools.partial(Quiet, directory=ROOT)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:8765/site/index.html'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
PRICED = 'samamusic.co.kr:100'; INQ = 'samamusic.co.kr:117'
MEMBER = {'id': 7, 'email': 'member@example.com', 'name': '김회원', 'phone': '010-1111-2222', 'company': '(주)예시', 'email_verified': True}

def scenario_routes(page, logged_in, dup=False):
    calls = []
    def api(route):
        req = route.request; url = req.url; path = url.split('workers.dev', 1)[1].split('?')[0]
        calls.append((req.method, path))
        def ok(data, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/me': return ok({'member': MEMBER}) if logged_in else ok({'error': 'unauthorized'}, 401)
        if path == '/api/shop/config': return ok({'shipping_fee_default': 0})
        if path == '/api/payments/config': return ok({'provider': 'nicepay', 'mode': 'mock'})
        if path in ('/api/me/orders', '/api/orders') and req.method == 'POST':
            if dup: return ok({'error': 'duplicate_order', 'existing_id': 'CGI-20261120-0009', 'detail': 'same cart was ordered recently'}, 409)
            return ok({'error': 'blocked in capture'}, 503)
        return ok({'error': 'not mocked'}, 404)
    # 실제 API·외부 자원에는 나가지 않는다 (주문·결제 생성 없음)
    page.route('**/*workers.dev/**', api)
    page.route(lambda u: not u.startswith('http://127.0.0.1:8765') and not u.startswith('data:') and 'workers.dev' not in u,
               lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.fulfill(status=204, body=''))
    return calls

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for width in (390, 1440):
        for name, hash_, logged, dup, cart in [
            ('detail-priced', f'#/product/{PRICED}', False, False, False),
            ('detail-inquiry', f'#/product/{INQ}', False, False, False),
            ('checkout-member', '#/checkout', True, False, True),
            ('checkout-duplicate', '#/checkout', False, True, True),
        ]:
            ctx = browser.new_context(viewport={'width': width, 'height': 900}, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on('console', lambda m, e=errors: e.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda ex, e=errors: e.append('pageerror: ' + str(ex)))
            calls = scenario_routes(page, logged, dup)
            if cart:
                page.add_init_script(f"localStorage.setItem('cgiQuoteCart', JSON.stringify([{{id:'{PRICED}', qty:1}}]));")
            page.goto(BASE + hash_)
            page.wait_for_selector('body[data-cgi-ready="1"]', timeout=30000)
            page.wait_for_timeout(600)
            if name == 'checkout-duplicate':
                page.fill('[name="company"]', '(주)시험'); page.fill('[name="name"]', '홍길동'); page.fill('[name="phone"]', '010-0000-0000')
                page.check('[name="terms_consent"]'); page.check('[name="privacy_consent"]')
                page.click('#orderForm button[type="submit"]'); page.wait_for_selector('.duplicate-order-notice')
                page.locator('.duplicate-order-notice').scroll_into_view_if_needed()
            info = page.evaluate("""() => {
              const de = document.documentElement;
              const over = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > de.clientWidth + 1); }).slice(0,5).map(el => el.tagName + '.' + el.className);
              const q = (s) => [...document.querySelectorAll(s)].filter(b => b.offsetParent !== null).map(b => b.className + ' :: ' + b.textContent.trim());
              return { scrollW: de.scrollWidth, clientW: de.clientWidth, over,
                       cta: q('.detail-cta button, .mobile-cta button'),
                       email: (document.querySelector('[name=email]')||{}).value || null,
                       dup: (document.querySelector('.duplicate-order-notice')||{}).innerText || null };
            }""")
            # 익명 /api/me 401 은 예상된 오류
            errs = [e for e in errors if not ('401' in e and not logged)]
            shot = f'{OUT}/{name}-{width}.png'
            page.screenshot(path=shot, full_page=(name != 'checkout-duplicate'))
            results.append({'shot': os.path.basename(shot), 'width': width, 'overflowX': info['scrollW'] - info['clientW'], 'overflowEls': info['over'],
                            'consoleErrors': errs, 'ignored401': len(errors) - len(errs), 'cta': info['cta'], 'emailPrefill': info['email'], 'dupNotice': info['dup'],
                            'apiCalls': calls})
            ctx.close()
    browser.close()
srv.shutdown()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results:
    print(r['shot'], 'overflowX=', r['overflowX'], 'errors=', len(r['consoleErrors']), r['consoleErrors'][:2], 'ignored401=', r['ignored401'])
    if r['cta']: print('   CTA:', r['cta'])
    if r['emailPrefill'] is not None and 'checkout' in r['shot']: print('   email:', r['emailPrefill'])
    if r['dupNotice']: print('   dup:', r['dupNotice'].replace('\n', ' | '))
    if r['overflowEls']: print('   over:', r['overflowEls'])
