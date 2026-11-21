# 홈페이지 390·1440 캡처: 공사·설치 상담, 관공서·공공기관 대표 사례, 납품·설치 실적 표, CONTACT.
# 저장소 루트를 정적 서버로 띄워 찍는다(외부 요청 차단).
#   (저장소 루트에서) python3 -m http.server 8766 &  →  python3 capture.py <출력 폴더>
import json, sys, os, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8766/website/index.html'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
MEASURE = """() => { const de = document.documentElement;
  const over = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > de.clientWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.primary-nav'); }).slice(0,5).map(el => el.tagName + '.' + el.className);
  return { overflowX: de.scrollWidth - de.clientWidth, over }; }"""
results = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w in (390, 1000, 1440):
        ctx = b.new_context(viewport={'width': w, 'height': 900}, is_mobile=(w == 390), has_touch=(w == 390))
        page = ctx.new_page(); log = {'c': [], 'h': []}
        page.on('console', lambda m: log['c'].append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda ex: log['c'].append('pageerror: ' + str(ex)))
        page.on('response', lambda r: log['h'].append(f'{r.status} {r.url}') if r.status >= 400 else None)
        page.route(lambda u: not u.startswith('http://localhost:8766'), lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
        page.goto(BASE); page.wait_for_load_state('networkidle'); page.wait_for_timeout(400)
        info = page.evaluate("""() => ({
          heroConsult: (document.querySelector('.hero [data-consult-link]') || {}).getAttribute && document.querySelector('.hero [data-consult-link]').getAttribute('href'),
          ctaConsult: document.querySelector('.cta-band [data-consult-link]').getAttribute('href'),
          quoteCartLinks: [...document.querySelectorAll('a')].filter(a => /quote-cart/.test(a.href)).length,
          hours: [...document.querySelectorAll('[data-consult-hours]')].map(n => n.textContent),
          emails: [...document.querySelectorAll('a[data-company-email]')].map(a => a.getAttribute('href')),
          publicGroups: [...document.querySelectorAll('.pub-group-box')].map(g => [g.querySelector('.pub-group-name').textContent, [...g.querySelectorAll(':scope > ul.pub-cards .pub-client')].map(x => x.textContent)]),
          recYears: document.querySelectorAll('.rec-year').length, recRows: document.querySelectorAll('.rec-table tbody tr').length,
          recHead: [...document.querySelectorAll('.rec-table thead th')].slice(0,2).map(t => t.textContent),
          headerHeight: document.querySelector('.head-bar').getBoundingClientRect().height,
          navWraps: (() => { const lis = [...document.querySelectorAll('.primary-nav > ul > li')]; return new Set(lis.map(li => Math.round(li.getBoundingClientRect().top))).size; })() })""")
        m = page.evaluate(MEASURE); m.update(info); m.update({'width': w, 'consoleErrors': log['c'], 'httpErrors': log['h']})
        if w != 1000:
            page.screenshot(path=f'{OUT}/top-{w}.png')
            # 히어로의 상담 버튼을 누르면 상담 영역으로
            page.click('.hero [data-consult-link]'); page.wait_for_timeout(2500)
            m['afterHeroClick'] = page.evaluate("({ hash: location.hash, consultTop: Math.round(document.getElementById('consult').getBoundingClientRect().top) })")
            # 요소 캡처가 고정 머리글에 가리지 않게(캡처할 때만)
            page.add_style_tag(content='.site-head { position: static !important; }')
            page.locator('#consult').screenshot(path=f'{OUT}/consult-{w}.png')
            page.locator('#support .support-grid .panel').first.screenshot(path=f'{OUT}/contact-{w}.png')
            page.locator('#publicRefs').scroll_into_view_if_needed(); page.wait_for_timeout(200)
            page.locator('#publicRefs').screenshot(path=f'{OUT}/reference-public-{w}.png')
            page.click('#tabRecords'); page.wait_for_timeout(200)
            if w == 390:
                page.locator('#recordList .rec-year').nth(1).locator('summary').click()
            page.locator('#panelRecords').screenshot(path=f'{OUT}/records-{w}.png')
            m['afterTabs'] = page.evaluate(MEASURE)
        results.append(m); ctx.close()
    b.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results: print(json.dumps(r, ensure_ascii=False)[:900])
