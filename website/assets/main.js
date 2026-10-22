/*
 * main.js — CGI 홈페이지 인터랙션
 *
 * 기능
 *  1) 모바일 메뉴 토글 (접기/펼치기 + 스크롤 잠금 + Esc 닫기)
 *  2) 스크롤 위치에 따른 헤더 고정/축소 + 현재 섹션 메뉴 활성화
 *  3) 취급 브랜드 목록 렌더링 → 클릭 시 쇼핑몰 브랜드 필터로 이동
 *  4) 쇼핑몰 링크 일괄 적용 (config.js 의 mallUrl, ?mall= 파라미터로 덮어쓰기 가능)
 *  5) REFERENCE 탭 전환 (INSTALL / RENTAL)
 */
(function () {
  'use strict';

  var CFG = window.CGI_CONFIG || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------ 쇼핑몰 주소 */
  function mallBase() {
    var override = new URLSearchParams(location.search).get('mall');
    if (override) { return override; }
    return CFG.mallUrl || '../site/index.html';
  }

  /** 쇼핑몰 URL 생성.
   *  - 브랜드 지정 없으면: ../site/index.html
   *  - 브랜드 지정 시  : ../site/index.html#/products?brand=SHURE
   *  (PR #17 쇼핑몰은 해시 라우터이며 brand 값은 brand_norm 대문자 기준) */
  function mallUrl(brand) {
    var base = mallBase();
    if (!brand) { return base; }
    var listBase = CFG.mallListUrl || (base + '#/products');
    var key = CFG.mallBrandParam || 'brand';
    var value = (CFG.mallBrandCase === 'upper') ? String(brand).toUpperCase() : String(brand);
    return listBase + '?' + key + '=' + encodeURIComponent(value);
  }

  function applyMallLinks() {
    $$('[data-mall-link]').forEach(function (a) {
      a.setAttribute('href', mallUrl(null));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    });
  }

  /* ------------------------------------------------------ 브랜드 목록 */
  function brandListFromMaster(items) {
    var counts = {};
    items.forEach(function (p) {
      var b = p.brand_norm || p.brand || '';
      if (!b) { return; }
      b = (CFG.mallBrandCase === 'upper') ? String(b).toUpperCase() : String(b);
      counts[b] = (counts[b] || 0) + 1;
    });
    return Object.keys(counts).map(function (b) {
      return { name: b, count: counts[b] };
    }).sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  function renderBrands(list) {
    var grid = $('#brandGrid');
    if (!grid) { return; }
    grid.innerHTML = '';
    list.forEach(function (item) {
      var name = typeof item === 'string' ? item : item.name;
      var count = typeof item === 'string' ? null : item.count;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = mallUrl(name);
      a.target = '_blank';
      a.rel = 'noopener';
      a.appendChild(document.createTextNode(name));
      if (count) {
        var c = document.createElement('span');
        c.className = 'brand-count';
        c.textContent = count;
        a.appendChild(c);
      }
      a.title = name + ' 제품 보기 — ' + (CFG.mallLabel || 'CGI 상품 쇼핑몰');
      li.appendChild(a);
      grid.appendChild(li);
    });
    var note = $('#brandNote');
    if (note && list.length && list[0].count) {
      var total = list.reduce(function (s, b) { return s + (b.count || 0); }, 0);
      var withData = list.filter(function (b) { return b.count; }).length;
      note.textContent = '현재 쇼핑몰 데이터 기준 ' + total + '건 · 데이터 보유 브랜드 ' + withData + '종 / '
        + '취급 브랜드 ' + list.length + '종 (데이터 준비 중 브랜드는 목록이 비어 보일 수 있습니다)';
    }
  }

  /** 공통 상품 마스터(쇼핑몰 데이터)를 읽어 브랜드 목록을 자동 반영한다.
   *  마스터에 있는 브랜드는 건수를 표시하고, 아직 데이터가 없는 취급 브랜드는
   *  config 의 정적 목록(31종)에 포함시켜 함께 보여준다(공급처 실측 목록 유지).
   *  파일이 없거나 읽지 못하면 config 의 정적 목록으로 graceful fallback 한다. */
  function loadMasterBrands() {
    var url = CFG.mallDataUrl;
    var staticList = (CFG.brands || []).map(function (b) { return { name: b, count: null }; });
    if (!url) { renderBrands(staticList); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () {
        var items = window[CFG.mallDataGlobal || 'CGI_PRODUCTS'];
        if (!Array.isArray(items) || !items.length) {
          renderBrands(staticList);
          resolve();
          return;
        }
        var master = brandListFromMaster(items);
        var seen = {};
        master.forEach(function (m) { seen[m.name] = true; });
        var merged = master.slice();
        staticList.forEach(function (st) {
          var key = (CFG.mallBrandCase === 'upper') ? st.name.toUpperCase() : st.name;
          if (!seen[key]) {
            // 쇼핑몰 표기(brand_norm 대문자)와 맞추기 위해 대문자로 표기한다
            merged.push({ name: key, count: null });
          }
        });
        renderBrands(merged);
        resolve();
      };
      s.onerror = function () { renderBrands(staticList); resolve(); };
      document.head.appendChild(s);
    });
  }

  /* ------------------------------------------------------ 브랜드 칩 좁히기 */
  function initBrandFilter() {
    var input = $('#brandFilter');
    var grid = $('#brandGrid');
    if (!input || !grid) { return; }
    input.addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      var items = $$('#brandGrid li');
      var shown = 0;
      items.forEach(function (li) {
        var hit = !q || (li.textContent || '').toLowerCase().indexOf(q) >= 0;
        li.style.display = hit ? '' : 'none';
        if (hit) { shown++; }
      });
      var empty = $('#brandEmpty');
      if (empty) { empty.hidden = shown > 0; }
    });
  }

  /* ------------------------------------------------------ 모바일 메뉴 */
  function initNav() {
    var btn = $('#navToggle');
    var nav = $('#primaryNav');
    if (!btn || !nav) { return; }

    function close() {
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('nav-open');
    }
    function toggle() {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('nav-open', open);
    }
    btn.addEventListener('click', function () {
      if (nav.classList.contains('open')) { close(); } else { toggle(); }
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A' && !e.target.hasAttribute('data-mall-link')) { close(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) { close(); }
    });
  }

  /* ------------------------------------------------------ 헤더 상태 */
  function initScrollSpy() {
    var head = $('.site-head');
    var sections = ['about', 'business', 'products', 'reference', 'support'];
    var links = $$('.primary-nav a[href^="#"]');
    if (!head) { return; }

    function onScroll() {
      var y = window.scrollY || document.documentElement.scrollTop;
      head.classList.toggle('is-stuck', y > 40);

      var current = '';
      var offset = (head.offsetHeight || 70) + 40;
      sections.forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= offset) { current = id; }
      });
      links.forEach(function (a) {
        var href = a.getAttribute('href');
        if (href === '#' + current) { a.setAttribute('aria-current', 'true'); }
        else { a.removeAttribute('aria-current'); }
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ------------------------------------------------------ REFERENCE 탭 */
  function initRefTabs() {
    var tabs = $$('.ref-tabs [role=tab]');
    if (!tabs.length) { return; }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        tabs.forEach(function (x) {
          x.setAttribute('aria-selected', 'false');
          x.classList.remove('on');
          var p = document.getElementById(x.getAttribute('aria-controls'));
          if (p) { p.hidden = true; }
        });
        t.setAttribute('aria-selected', 'true');
        t.classList.add('on');
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) { panel.hidden = false; }
      });
    });
  }

  /* ------------------------------------------------------ 시작 */
  function boot() {
    applyMallLinks();
    loadMasterBrands();
    initNav();
    initScrollSpy();
    initRefTabs();
    initBrandFilter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
