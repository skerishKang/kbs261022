# 카탈로그 품질 캡처·측정: "SM7B" 검색, "스피커" 추천순 첫 화면, 믹서 대분류 첫 화면, 병합된 옛 주소 이동.
# 서버: ../ops-feedback-261120/localapi.mjs <저장소 경로> (localhost:8765, 실제 API 없음)
#   python3 capture.py <출력 폴더> [shots]   — shots 를 주면 390·1440 캡처도 남긴다
import json, os, sys, base64
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; SHOTS = 'shots' in sys.argv[2:]
os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/index.html'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
SCENES = [
    ('search-sm7b', '#/products?q=SM7B'),
    ('speaker-featured', '#/products?q=%EC%8A%A4%ED%94%BC%EC%BB%A4'),
    ('mixer-category', '#/products?cat=%EB%AF%B9%EC%84%9C%C2%B7%ED%94%84%EB%A1%9C%EC%84%B8%EC%84%9C'),
]
DEMOTE = ['리퍼', '박스손상', '전시', '단종', '클리어런스']
results = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w in ((390, 1440) if SHOTS else (1440,)):
        for name, hash_ in SCENES:
            ctx = b.new_context(viewport={'width': w, 'height': 900}, is_mobile=(w == 390), has_touch=(w == 390))
            pg = ctx.new_page(); errs = []; http = []
            pg.on('console', lambda m, e=errs: e.append(m.text) if m.type == 'error' else None)
            pg.on('response', lambda r, h=http: h.append(f'{r.status} {r.url.split("8765")[-1]}') if r.status >= 400 else None)
            pg.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript', body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
            pg.route(lambda u: not u.startswith('http://localhost:8765') and not u.startswith('data:'), lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
            pg.goto(BASE + hash_); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(500)
            info = pg.evaluate("""() => ({ count: (document.querySelector('.result-count, .list-count, .toolbar-count') || {}).textContent || null,
              heading: (document.querySelector('.page-sub') || {}).textContent || null,
              first: [...document.querySelectorAll('.product-card')].slice(0, 12).map(c => (c.querySelector('.card-flags .badge') ? '[' + c.querySelector('.card-flags .badge').textContent + '] ' : '') + c.querySelector('.card-name').textContent),
              cards: document.querySelectorAll('.product-card').length,
              overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth })""")
            anon = [h for h in http if h.startswith('401 /api/me')]
            info.update({'scene': name, 'width': w, 'demotedInFirst12': sum(1 for n in info['first'] if any(k in n for k in DEMOTE)),
                         'consoleErrors': [e for e in errs if not ('401' in e and anon)], 'httpErrors': [h for h in http if h not in anon]})
            if SHOTS: pg.screenshot(path=f'{OUT}/{name}-{w}.png', full_page=False); info['shot'] = f'{name}-{w}.png'
            results.append(info); ctx.close()
    if SHOTS:
        # 병합으로 없어진 옛 주소 → 남긴 상품 (KSM40C, 상품명 완전 일치 병합)
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page()
        pg.route(lambda u: not u.startswith('http://localhost:8765'), lambda r: r.abort())
        pg.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript', body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
        merge = json.loads(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'site', 'data', 'product_merge.js')).read().split('=', 1)[1].strip().rstrip(';'))
        old = next(k for k, v in merge.items() if v == 'samamusic.co.kr:1355') if 'samamusic.co.kr:1355' in merge.values() else next(iter(merge))
        pg.goto(BASE + '#/product/' + old); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(600)
        results.append({'scene': 'merged-redirect', 'from': old, 'expected': merge[old], 'landedHash': pg.evaluate('decodeURIComponent(location.hash)'), 'title': (pg.query_selector('.detail-title') and pg.inner_text('.detail-title'))})
        ctx.close()
    b.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results: print(json.dumps(r, ensure_ascii=False)[:900])
