# 390·1440 캡처: 상품 상세(바로 구매), 의견 보내기 폼, 운영센터 받은함.
# 정적 파일과 API 모두 로컬 서버(localapi.mjs: 저장소의 worker.fetch + 메모리 DB)에서만 응답한다.
import json, sys, os, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
# 로그인 값은 localapi.mjs 가 실행 때마다 무작위로 만들어 같은 폴더의 .capture-login 에 적는다
LOGIN = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.capture-login')).read().strip()
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for width in (390, 1440):
        for name in ('detail-priced', 'feedback-form', 'ops-inbox', 'ops-detail'):
            ctx = browser.new_context(viewport={'width': width, 'height': 900})
            page = ctx.new_page()
            errors, bad = [], []
            page.on('console', lambda m, e=errors: e.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda ex, e=errors: e.append('pageerror: ' + str(ex)))
            page.on('response', lambda r, b=bad: b.append(f'{r.status} {r.url.split("8765")[-1]}') if r.status >= 400 else None)
            # 설정의 API 주소만 같은 로컬 서버로 바꾼다
            page.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript',
                body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
            page.route(lambda u: not u.startswith('http://localhost:8765') and not u.startswith('data:'),
                       lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
            full = True
            if name == 'detail-priced':
                page.goto(BASE + 'index.html#/product/samamusic.co.kr:100'); page.wait_for_selector('body[data-cgi-ready="1"]')
            elif name == 'feedback-form':
                page.goto(BASE + 'feedback.html'); page.wait_for_load_state('networkidle')
            else:
                page.goto(BASE + 'ops.html'); page.wait_for_selector('#opsLoginForm')
                page.fill('#opsLoginForm [name=email]', 'skerish@naver.com'); page.fill('#opsLoginForm [name=password]', LOGIN)
                page.click('#opsLoginForm [type=submit]')
                page.wait_for_selector('#opsList [data-feedback-id]')
                if name == 'ops-detail':
                    page.click('#opsList [data-feedback-id]'); page.wait_for_timeout(800)
            page.wait_for_timeout(600)
            info = page.evaluate("""() => { const de = document.documentElement;
              const over = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > de.clientWidth + 1 && getComputedStyle(el).position !== 'fixed'; }).slice(0,5).map(el => el.tagName + '.' + el.className);
              const q = s => [...document.querySelectorAll(s)].filter(b => b.offsetParent !== null).map(b => b.textContent.trim().slice(0,40));
              return { overflowX: de.scrollWidth - de.clientWidth, over, cta: q('.detail-cta [data-action], .mobile-cta [data-action]'),
                       rows: document.querySelectorAll('#opsList [data-feedback-id]').length, fields: q('form label').slice(0,8) }; }""")
            expected = [b for b in bad if b.startswith('401 /api/me')]
            real_bad = [b for b in bad if b not in expected]
            errs = errors[len(expected):] if all('401' in e for e in errors[:len(expected)]) else errors
            shot = f'{OUT}/{name}-{width}.png'
            page.screenshot(path=shot, full_page=full)
            results.append({'shot': os.path.basename(shot), 'overflowX': info['overflowX'], 'overflowEls': info['over'], 'consoleErrors': errs,
                            'httpErrors': real_bad, 'ignoredAnon401': expected, 'cta': info['cta'], 'opsRows': info['rows'], 'formLabels': info['fields']})
            ctx.close()
    browser.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results:
    print(r['shot'], 'overflowX=', r['overflowX'], 'consoleErrors=', r['consoleErrors'], 'http>=400=', r['httpErrors'], 'ignored=', len(r['ignoredAnon401']))
    if r['cta']: print('   CTA', r['cta'])
    if r['opsRows']: print('   rows', r['opsRows'])
    if r['overflowEls']: print('   over', r['overflowEls'])
