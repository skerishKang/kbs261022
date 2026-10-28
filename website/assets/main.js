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
  /* #126: 브랜드 칩 초기 노출 개수를 줄여 시각 밀도를 낮춘다(접기/더보기 토글).
   * 전체 브랜드는 DOM에 유지되며 브랜드 검색 중에는 접기 상태를 무시한다. */
  var BRAND_INITIAL = 24;
  var brandCollapsed = true;

  function applyBrandCollapse() {
    var grid = $('#brandGrid');
    if (!grid) { return; }
    var items = $$('#brandGrid li');
    var input = $('#brandFilter');
    var q = input ? input.value.trim().toLowerCase() : '';
    var filtering = q.length > 0;
    var shown = 0;
    items.forEach(function (li, idx) {
      var matches = !q || (li.textContent || '').toLowerCase().indexOf(q) >= 0;
      var base = matches && (filtering || !brandCollapsed || idx < BRAND_INITIAL);
      li.hidden = !base;
      if (base) { shown++; }
    });
    var btn = $('#brandMore');
    if (btn) {
      btn.hidden = items.length <= BRAND_INITIAL;
      btn.textContent = brandCollapsed
        ? '브랜드 더보기 (전체 ' + items.length + '종)'
        : '브랜드 접기';
      btn.setAttribute('aria-expanded', brandCollapsed ? 'false' : 'true');
    }
    var empty = $('#brandEmpty');
    if (empty) { empty.hidden = !filtering || shown > 0; }
  }

  function initBrandMore() {
    var btn = $('#brandMore');
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      brandCollapsed = !brandCollapsed;
      applyBrandCollapse();
    });
  }

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
    applyBrandCollapse();
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
      applyBrandCollapse();
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

  /* ══════════════════════════════════ 2025년 지명원 회사정보 렌더링 */
  var CO = window.CGI_COMPANY || null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }

  function renderOrg() {
    var host = document.getElementById('orgChart');
    if (!host) { return; }
    host.innerHTML = '';
    CO.org.divisions.forEach(function (div) {
      var li = el('li', 'org-branch');
      li.appendChild(el('strong', 'org-div-name', div.name));
      var sub = el('ul', 'org-sub');
      div.units.forEach(function (u) {
        var unit = el('li');
        if (typeof u === 'string') {
          unit.textContent = u;
        } else {
          unit.appendChild(el('span', 'org-team-name', u.team));
          var roles = el('ul', 'org-roles');
          u.roles.forEach(function (r) { roles.appendChild(el('li', null, r)); });
          unit.appendChild(roles);
        }
        sub.appendChild(unit);
      });
      li.appendChild(sub);
      host.appendChild(li);
    });
  }

  function renderHistory() {
    var host = document.getElementById('historyList');
    if (!host) { return; }
    host.innerHTML = '';
    CO.history.forEach(function (row) {
      var li = el('li', 'tl-row');
      li.appendChild(el('span', 'year', row.year));
      var ul = el('ul', 'tl-items');
      row.items.forEach(function (it) { ul.appendChild(el('li', null, it)); });
      li.appendChild(ul);
      host.appendChild(li);
    });
  }

  function renderKeywords() {
    var host = document.getElementById('bizKeywords');
    if (!host) { return; }
    host.innerHTML = '';
    CO.keywords.forEach(function (k) { host.appendChild(el('li', 'kw', k)); });
  }

  function renderBusiness() {
    var host = document.getElementById('bizGrid');
    if (!host) { return; }
    host.innerHTML = '';
    CO.business.forEach(function (b) {
      var art = el('article', 'biz biz-card');
      art.appendChild(el('span', 'biz-no', b.no));
      var img = el('img');
      img.src = b.img; img.alt = b.alt; img.loading = 'lazy'; img.width = 800; img.height = 500;
      art.appendChild(img);
      var h = el('h3', null, b.name);
      h.appendChild(el('span', 'en', ' ' + b.en));
      art.appendChild(h);
      var ul = el('ul');
      b.items.forEach(function (it) { ul.appendChild(el('li', null, it)); });
      art.appendChild(ul);
      host.appendChild(art);
    });
  }

  function renderAgencies() {
    var host = document.getElementById('agencyList');
    if (!host) { return; }
    host.innerHTML = '';
    CO.agencies.forEach(function (a) {
      var li = el('li');
      li.appendChild(el('span', 'ag-year', a.year));
      li.appendChild(el('strong', 'ag-name', a.name));
      li.appendChild(el('span', 'ag-type', a.type));
      if (a.note) { li.appendChild(el('span', 'ag-note', a.note)); }
      host.appendChild(li);
    });
  }

  function renderReferences() {
    var host = document.getElementById('refGrid');
    if (!host) { return; }
    host.innerHTML = '';
    var byCat = {};
    CO.references.forEach(function (r) {
      (byCat[r.cat] = byCat[r.cat] || []).push(r);
    });
    Object.keys(byCat).forEach(function (cat) {
      var box = el('div', 'ref-cat');
      box.appendChild(el('h4', 'ref-cat-name', cat));
      var ul = el('ul', 'ref-cards');
      byCat[cat].forEach(function (r) {
        var li = el('li', 'ref-card');
        li.appendChild(el('strong', 'ref-place', r.place));
        li.appendChild(el('span', 'ref-spec', r.spec));
        li.appendChild(el('span', 'ref-gear', r.gear));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      host.appendChild(box);
    });
  }

  function renderRecords() {
    var host = document.getElementById('recordList');
    if (!host) { return; }
    host.innerHTML = '';
    CO.records.forEach(function (row) {
      var det = el('details', 'rec-year');
      var sum = el('summary');
      sum.appendChild(el('span', 'rec-badge', row.year));
      sum.appendChild(el('span', 'rec-count', '지명원 기재 ' + row.count + '건'));
      det.appendChild(sum);
      var ul = el('ul', 'rec-samples');
      row.samples.forEach(function (s) { ul.appendChild(el('li', null, s)); });
      det.appendChild(ul);
      host.appendChild(det);
    });
  }

  function renderMaintenance() {
    var host = document.getElementById('maintList');
    if (!host) { return; }
    host.innerHTML = '';
    CO.maintenanceCases.forEach(function (m) {
      var li = el('li');
      li.appendChild(el('strong', 'mt-place', m.place));
      li.appendChild(el('span', 'mt-period', m.period));
      li.appendChild(el('span', 'mt-scope', m.scope));
      host.appendChild(li);
    });
  }

  function renderCredentials() {
    var host = document.getElementById('credList');
    if (!host) { return; }
    host.innerHTML = '';
    CO.credentials.groups.forEach(function (g) {
      var box = el('div', 'cred-group');
      box.appendChild(el('h4', 'cred-title', g.title));
      var ul = el('ul', 'cred-items');
      g.items.forEach(function (it) { ul.appendChild(el('li', null, it)); });
      box.appendChild(ul);
      host.appendChild(box);
    });
  }

  function renderCompany() {
    if (!CO) { return; }
    renderOrg();
    renderHistory();
    renderKeywords();
    renderBusiness();
    renderAgencies();
    renderReferences();
    renderRecords();
    renderMaintenance();
    renderCredentials();
  }

  /* ------------------------------------------------------ 시작 */
  function boot() {
    applyMallLinks();
    loadMasterBrands();
    renderCompany();
    initNav();
    initScrollSpy();
    initRefTabs();
    initBrandFilter();
    initBrandMore();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
