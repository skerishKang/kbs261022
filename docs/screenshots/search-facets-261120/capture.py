# 검색 결과 기준 필터 숫자 · 0건 검색 안내 · 첫 화면 추천 캡처/측정.
# 서버: ../ops-feedback-261120/localapi.mjs <저장소> (localhost:8765, 실제 API 없음)
#   python3 capture.py <출력 폴더>
import json, os, sys, base64, collections
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:8765/site/index.html'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+5dPQAI2QNxmf2tIwAAAABJRU5ErkJggg==')
results = []
def page_for(b, w):
    ctx = b.new_context(viewport={'width': w, 'height': 900}, is_mobile=(w == 390), has_touch=(w == 390))
    pg = ctx.new_page(); log = {'c': [], 'h': []}
    pg.on('console', lambda m: log['c'].append(m.text) if m.type == 'error' else None)
    pg.on('response', lambda r: log['h'].append(f'{r.status} {r.url.split("8765")[-1]}') if r.status >= 400 else None)
    pg.route('**/site/config.js*', lambda r: r.fulfill(status=200, content_type='text/javascript', body=r.fetch().text() + "\nwindow.CGI_SITE_CONFIG.quoteApiUrl='http://localhost:8765';window.CGI_SITE_CONFIG.orderApiUrl='http://localhost:8765';"))
    pg.route(lambda u: not u.startswith('http://localhost:8765') and not u.startswith('data:'), lambda r: r.fulfill(status=200, content_type='image/png', body=PNG) if r.request.resource_type == 'image' else r.abort())
    return ctx, pg, log
def errs(log):
    anon = [h for h in log['h'] if h.startswith('401 /api/me')]
    return {'consoleErrors': [c for c in log['c'] if not ('401' in c and anon)], 'httpErrors': [h for h in log['h'] if h not in anon]}
FACETS = """() => { const rows = sel => [...document.querySelectorAll(sel + ' label')].map(l => [l.querySelector('span').textContent, Number(l.querySelector('.cnt').textContent.replace(/,/g,'')), l.classList.contains('is-zero')]);
  const groups = [...document.querySelectorAll('.filter-group')];
  return { scope: (document.querySelector('.facet-scope') || {}).textContent || null, resultCount: Number((document.querySelector('.result-count b') || {}).textContent.replace(/,/g,'')),
    brand: groups[0] ? [...groups[0].querySelectorAll('label')].map(l => [l.querySelector('span').textContent, Number(l.querySelector('.cnt').textContent.replace(/,/g,''))]) : [],
    cat: groups[1] ? [...groups[1].querySelectorAll('label')].map(l => [l.querySelector('span').textContent, Number(l.querySelector('.cnt').textContent.replace(/,/g,''))]) : [],
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }; }"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for w in (390, 1440):
        # 1. "무선마이크" 검색 필터 숫자
        ctx, pg, log = page_for(b, w)
        pg.goto(BASE + '#/products?q=%EB%AC%B4%EC%84%A0%EB%A7%88%EC%9D%B4%ED%81%AC'); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(400)
        if w == 390: pg.click('[data-action="toggle-filters"]'); pg.wait_for_timeout(200)
        m = pg.evaluate(FACETS); m.update(errs(log)); m.update({'scene': 'facets-wireless', 'width': w, 'shot': f'facets-wireless-{w}.png'})
        m['brandSum'] = sum(n for _, n in m['brand']); m['catSum'] = sum(n for _, n in m['cat'])
        pg.locator('.filter-panel').scroll_into_view_if_needed() if w == 390 else None
        pg.screenshot(path=f'{OUT}/facets-wireless-{w}.png', full_page=(w == 390))
        results.append(m); ctx.close()
        # 2. "강당 스피커" 0건
        ctx, pg, log = page_for(b, w)
        pg.goto(BASE + '#/products?q=%EA%B0%95%EB%8B%B9%20%EC%8A%A4%ED%94%BC%EC%BB%A4'); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(400)
        e = pg.evaluate("""() => ({ title: (document.querySelector('.empty-search h3') || {}).textContent || null,
          suggestions: [...document.querySelectorAll('[data-suggest-query]')].map(a => a.textContent),
          cats: [...document.querySelectorAll('[data-suggest-cat]')].map(a => a.textContent),
          call: (document.querySelector('.empty-call') || {}).textContent || null,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth })""")
        e.update(errs(log)); e.update({'scene': 'zero-auditorium-speaker', 'width': w, 'shot': f'zero-auditorium-speaker-{w}.png'})
        pg.locator('.empty-search').scroll_into_view_if_needed(); pg.wait_for_timeout(150)
        pg.screenshot(path=f'{OUT}/zero-auditorium-speaker-{w}.png', full_page=False)
        # 추천 검색어 첫 칩을 누르면 결과가 나온다
        pg.click('[data-suggest-query]'); pg.wait_for_timeout(500)
        e['afterFirstSuggestion'] = pg.evaluate("[decodeURIComponent(location.hash), document.querySelectorAll('.product-card').length]")
        results.append(e); ctx.close()
        # 3. 첫 화면 추천
        ctx, pg, log = page_for(b, w)
        pg.goto(BASE + '#/'); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(500)
        h = pg.evaluate("""() => { const sec = [...document.querySelectorAll('.section')].find(s => /추천 상품/.test(s.textContent));
          return { sub: (sec.querySelector('.section-sub') || {}).textContent || null, featured: [...sec.querySelectorAll('.product-card')].map(c => [c.getAttribute('data-product-id'), c.querySelector('.card-name').textContent]),
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }; }""")
        h.update(errs(log)); h.update({'scene': 'home-featured', 'width': w, 'shot': f'home-featured-{w}.png'})
        sec = pg.locator('.section', has_text='추천 상품').first; sec.scroll_into_view_if_needed()
        sec.screenshot(path=f'{OUT}/home-featured-{w}.png')
        results.append(h); ctx.close()
    # D1: 전체 상품 추천순 첫 24개의 브랜드 반복(고정 추천 포함)
    ctx, pg, log = page_for(b, 1440)
    pg.goto(BASE + '#/products'); pg.wait_for_selector('body[data-cgi-ready="1"]'); pg.wait_for_timeout(400)
    brands = pg.evaluate("[...document.querySelectorAll('.product-card .card-brand')].slice(0,24).map(x => x.textContent)")
    results.append({'scene': 'all-products-featured-first24', 'brandCounts': dict(collections.Counter(brands).most_common()), 'first8': pg.evaluate("[...document.querySelectorAll('.product-card')].slice(0,8).map(c => c.getAttribute('data-product-id'))")})
    ctx.close(); b.close()
json.dump(results, open(f'{OUT}/results.json', 'w'), ensure_ascii=False, indent=1)
for r in results: print(json.dumps({k: v for k, v in r.items() if k not in ('brand', 'cat')}, ensure_ascii=False)[:700])
