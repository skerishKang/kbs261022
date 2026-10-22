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
  function mallUrl(brand) {
    var base = CFG.mallUrl || '../site/index.html';
    var override = new URLSearchParams(location.search).get('mall');
    if (override) { base = override; }
    if (!brand) { return base; }
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'brand=' + encodeURIComponent(brand);
  }

  function applyMallLinks() {
    $$('[data-mall-link]').forEach(function (a) {
      a.setAttribute('href', mallUrl(null));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    });
  }

  /* ------------------------------------------------------ 브랜드 목록 */
  function renderBrands() {
    var grid = $('#brandGrid');
    if (!grid || !CFG.brands) { return; }
    grid.innerHTML = '';
    CFG.brands.forEach(function (b) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = mallUrl(b);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = b;
      a.title = b + ' 제품 보기 — ' + (CFG.mallLabel || 'CGI 상품 쇼핑몰');
      li.appendChild(a);
      grid.appendChild(li);
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
    renderBrands();
    initNav();
    initScrollSpy();
    initRefTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
