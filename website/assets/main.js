/*
 * main.js — CGI 홈페이지 인터랙션
 *
 * 기능
 *  1) 모바일 메뉴 토글 (접기/펼치기 + 스크롤 잠금 + Esc 닫기)
 *  2) 스크롤 위치에 따른 헤더 고정/축소 + 현재 섹션 메뉴 활성화
 *  3) 취급 브랜드 목록 렌더링 → 클릭 시 쇼핑몰 브랜드 필터로 이동
 *  4) 쇼핑몰 링크 일괄 적용 (config.js 의 mallUrl 고정 — URL 파라미터로 덮어쓰지 않음)
 *  5) REFERENCE 탭 전환 (INSTALL / RENTAL)
 */
(function () {
  'use strict';

  var CFG = window.CGI_CONFIG || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------ 쇼핑몰 주소 */
  function mallBase() {
    // ?mall= 로 임의 주소를 주입할 수 있었지만, 홍보·피싱 링크에 악용될 수 있어
    // 제거했다. 주소는 config.js 한 곳에서만 바꾼다.
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

  function applyQuoteLinks() {
    var url = mallBase().replace(/#.*$/, '') + '#/quote-cart';
    $$('[data-quote-link]').forEach(function (a) {
      a.setAttribute('href', url);
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

  function brandListFromBrands(rows) {
    return (rows || []).map(function (row) {
      var name = (CFG.mallBrandCase === 'upper') ? String(row.name || '').toUpperCase() : String(row.name || '');
      return { name: name, count: Number(row.count) || 0 };
    }).filter(function (row) { return !!row.name; })
      .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
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
      note.textContent = '취급 브랜드 ' + list.length + '종';
    }
  }

  /** 공통 상품 마스터(쇼핑몰 데이터)를 읽어 브랜드 목록을 자동 반영한다.
   *  마스터에 있는 브랜드는 건수를 표시하고, 아직 데이터가 없는 취급 브랜드는
   *  config 의 정적 목록(31종)에 포함시켜 함께 보여준다(공급처 실측 목록 유지).
   *  파일이 없거나 읽지 못하면 config 의 정적 목록으로 graceful fallback 한다. */
  function loadMasterBrands() {
    // 홈페이지는 브랜드 이름·건수만 필요하다. 11MB 상품 마스터 대신
    // brands.json(약 3KB)만 읽어 첫 화면 전송량을 줄인다.
    var url = CFG.mallBrandsUrl || '../site/data/brands.json';
    var staticList = (CFG.brands || []).map(function (b) { return { name: b, count: null }; });
    return fetch(url, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        var master = brandListFromBrands(payload && payload.brands);
        if (!master.length) { renderBrands(staticList); return; }
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
      })
      .catch(function () { renderBrands(staticList); });
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
    var navLabel = btn.querySelector('.sr-only');

    function setLabel(open) {
      if (navLabel) navLabel.textContent = open ? '메뉴 닫기' : '메뉴 열기';
    }
    function close() {
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      setLabel(false);
      document.body.classList.remove('nav-open');
    }
    function toggle() {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      setLabel(open);
      document.body.classList.toggle('nav-open', open);
      if (open) {
        // 키보드 사용자가 열린 메뉴 안에서 바로 이동할 수 있게 첫 링크로 포커스.
        // visibility/transform 전환이 적용되기 전에는 focus()가 무시될 수 있어
        // 강제 리플로 후 시도하고, 실패하면 짧게 지연해 한 번 더 시도한다
        // (백그라운드 탭에서는 requestAnimationFrame이 멈출 수 있다).
        var first = nav.querySelector('a');
        if (first) {
          var focusFirst = function () { try { first.focus(); } catch (e) {} };
          void nav.offsetWidth;
          focusFirst();
          if (document.activeElement !== first) setTimeout(focusFirst, 60);
        }
      }
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
    var disclosure = document.getElementById('orgDisclosure');
    if (disclosure) { disclosure.open = false; }
  }

  function renderHistory() {
    var recent = document.getElementById('historyRecent');
    var older = document.getElementById('historyOlder');
    if (!recent || !older) { return; }
    recent.innerHTML = '';
    older.innerHTML = '';
    CO.history.forEach(function (row) {
      var li = el('li', 'tl-row');
      li.appendChild(el('span', 'year', row.year));
      var ul = el('ul', 'tl-items');
      row.items.forEach(function (it) { ul.appendChild(el('li', null, it)); });
      li.appendChild(ul);
      (Number(row.year) >= 2023 ? recent : older).appendChild(li);
    });
    var disclosure = document.getElementById('historyMore');
    if (disclosure) { disclosure.open = false; }
  }

  function renderKeywords() {
    var host = document.getElementById('bizKeywords');
    if (!host) { return; }
    host.innerHTML = '';
    CO.keywords.forEach(function (k) { host.appendChild(el('li', 'kw', k)); });
  }

  var FIELD_ICON_MARKS = {
    'Media & Broadcast': '<rect x="18" y="24" width="60" height="48" rx="5"/><path d="M28 48h8l6-12 10 25 8-18 6 9h9"/><path d="M30 80h36"/>',
    'LED Screen': '<rect x="16" y="20" width="64" height="48" rx="4"/><path d="M28 32h8v8h-8zm16 0h8v8h-8zm16 0h8v8h-8zM28 48h8v8h-8zm16 0h8v8h-8zm16 0h8v8h-8zM36 80h24m-12-12v12"/>',
    'Stage & Lighting': '<path d="M20 26h56L64 48H32z"/><path d="M36 50 26 76m18-26-3 28m19-28 10 26m-18-26v28"/><circle cx="48" cy="32" r="5"/>',
    'CCTV & Smart Farm': '<path d="M22 34h42l12 10v20l-12 10H22z"/><circle cx="48" cy="54" r="10"/><path d="M48 44c-10-8-18 2-12 9 6 6 12 2 12-9zm0 0c10-8 18 2 12 9-6 6-12 2-12-9zm0 1v28"/>',
    'Control System': '<rect x="16" y="20" width="64" height="48" rx="4"/><path d="M24 30h18v13H24zm30 0h18v13H54zM24 49h18v11H24zm30 0h18v11H54zM36 80h24m-12-12v12"/>',
    'Rental': '<rect x="27" y="20" width="42" height="58" rx="5"/><circle cx="48" cy="39" r="10"/><circle cx="48" cy="64" r="5"/><path d="M39 20v-6h18v6"/>',
    'Training': '<path d="M18 25h27a9 9 0 0 1 9 9v42H27a9 9 0 0 0-9 5z"/><path d="M78 25H57a9 9 0 0 0-9 9v42h21a9 9 0 0 1 9 5zM29 41h9m-9 10h9m20-10h9m-9 10h9"/>',
    'Maintenance': '<path d="M60 17a21 21 0 0 0-24 27L17 63a9 9 0 0 0 13 13l19-19a21 21 0 0 0 27-25L64 44 52 32z"/>',
    'Interior Architecture': '<path d="M18 78V32l30-15 30 15v46z"/><path d="M28 40h12v12H28zm28 0h12v12H56zM28 61h12v17H28zm28-1h12v18H56z"/>',
    'R&D & Manufacturing': '<path d="M36 19h24v14l16 28a12 12 0 0 1-10 18H30a12 12 0 0 1-10-18l16-28z"/><path d="M30 58h36M40 70h16"/>'
  };
  function fieldIcon(key, label) {
    var wrap = el('div', 'field-icon');
    wrap.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.setAttribute('class', 'field-icon-svg');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = FIELD_ICON_MARKS[key] || FIELD_ICON_MARKS['Media & Broadcast'];
    wrap.appendChild(svg);
    if (label) { wrap.appendChild(el('span', 'field-icon-label', label)); }
    return wrap;
  }

  function addPhoto(media, img) {
    img.classList.add('field-photo');
    img.addEventListener('load', function () { media.classList.add('has-photo'); });
    img.addEventListener('error', function () { media.classList.remove('has-photo'); });
    media.appendChild(img);
    if (img.complete && img.naturalWidth > 0) { media.classList.add('has-photo'); }
  }

  function fieldMedia(key, label, source, alt) {
    var media = el('div', 'field-media');
    media.appendChild(fieldIcon(key, label));
    if (source) {
      var img = el('img');
      img.alt = alt || label;
      img.width = 800; img.height = 500; img.loading = 'lazy';
      img.src = source;
      addPhoto(media, img);
    }
    return media;
  }

  function initPhotoGridFallbacks() {
    $$('.photo-grid .figure-frame img').forEach(function (img) {
      var figure = img.parentNode;
      var caption = (figure.querySelector('figcaption') || {}).textContent || '';
      var text = ((img.alt || '') + ' ' + caption).toLowerCase();
      var key = text.indexOf('led') >= 0 ? 'LED Screen'
        : (text.indexOf('조명') >= 0 || text.indexOf('lighting') >= 0) ? 'Stage & Lighting'
        : (text.indexOf('관제') >= 0 || text.indexOf('control') >= 0) ? 'Control System'
        : (text.indexOf('팜') >= 0 || text.indexOf('farm') >= 0) ? 'CCTV & Smart Farm'
        : 'Media & Broadcast';
      var media = fieldMedia(key, caption);
      figure.replaceChild(media, img);
      addPhoto(media, img);
    });
  }

  function renderBusiness() {
    var host = document.getElementById('bizGrid');
    if (!host) { return; }
    host.innerHTML = '';
    CO.business.forEach(function (b) {
      var art = el('article', 'biz biz-card');
      art.appendChild(el('span', 'biz-no', b.no));
      art.appendChild(fieldMedia(b.en, b.name, b.img, b.alt));
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
    var cover = {
      'AV시스템': { key: 'Media & Broadcast', src: 'assets/img/ref_hall.jpg', alt: '회사 보유 공연장 음향·영상 시공 사진' },
      'LED 스크린': { key: 'LED Screen', src: 'assets/img/biz_led.jpg', alt: '회사 보유 LED 스크린 설치 사진' },
      '레퍼런스': { key: 'Control System', src: 'assets/img/ref_broadcast.jpg', alt: '회사 보유 방송 제어실 사진' }
    };
    CO.references.forEach(function (r) {
      (byCat[r.cat] = byCat[r.cat] || []).push(r);
    });
    Object.keys(byCat).forEach(function (cat) {
      var rows = byCat[cat];
      var box = el('div', 'ref-cat');
      box.appendChild(el('h4', 'ref-cat-name', cat));
      var photo = cover[cat];
      if (photo) { box.appendChild(fieldMedia(photo.key, cat + ' 분야 대표 사진', photo.src, photo.alt)); }
      var ul = el('ul', 'ref-cards');
      var moreList = el('ul', 'ref-cards ref-cards-more');
      rows.forEach(function (r, index) {
        var li = el('li', 'ref-card');
        li.appendChild(el('strong', 'ref-place', r.place));
        li.appendChild(el('span', 'ref-spec', r.spec));
        li.appendChild(el('span', 'ref-gear', r.gear));
        (index === 0 ? ul : moreList).appendChild(li);
      });
      box.appendChild(ul);
      if (rows.length > 1) {
        var more = el('details', 'ref-more');
        var summary = el('summary', null, '이 분야 사례 더 보기 (' + (rows.length - 1) + ')');
        more.appendChild(summary);
        more.appendChild(moreList);
        more.open = false;
        box.appendChild(more);
      }
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
      sum.appendChild(el('span', 'rec-count', '실적 ' + row.count + '건'));
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
    applyQuoteLinks();
    loadMasterBrands();
    renderCompany();
    initPhotoGridFallbacks();
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
