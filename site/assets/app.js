/*
 * app.js — CGI 상품 카탈로그 (목록/필터/검색/페이지)
 *
 * 원본 삼아스토어에서 분석해 확인한 동작을 재사용한다:
 *   · 카테고리 LNB 는 원본 11개 구조를 그대로 사용하고 URL 파라미터로 상태를 전달한다.
 *   · 검색은 GET 폼 + query 파라미터 (원본 /shopSearch/search.html?query= 와 동일 형태).
 *   · 정렬은 원본 #selArray 와 같은 7종 라벨/동작(신상품·상품명·낮은가격·높은가격·제조사·사용후기·조회수).
 *   · 페이지네이션은 첫/이전/숫자/다음/마지막 구조.
 * 데이터 출처는 항상 카드/상세에 함께 표기한다.
 */
(function () {
  'use strict';

  var PAGE_SIZE = 12;

  var state = {
    catalog: null,
    q: '',
    brand: '',
    sort: 'recent',
    approvedOnly: false,
    page: 1
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function won(n) { return Number(n).toLocaleString('ko-KR') + '원'; }

  function readQuery() {
    var p = new URLSearchParams(location.search);
    state.q = (p.get('q') || '').trim();
    state.brand = (p.get('brand') || '').trim();
    state.sort = p.get('sort') || 'recent';
    state.approvedOnly = p.get('approved') === '1';
    state.page = Math.max(1, parseInt(p.get('page') || '1', 10) || 1);
  }

  function writeQuery(replace) {
    var p = new URLSearchParams();
    if (state.q) { p.set('q', state.q); }
    if (state.brand) { p.set('brand', state.brand); }
    if (state.sort && state.sort !== 'recent') { p.set('sort', state.sort); }
    if (state.approvedOnly) { p.set('approved', '1'); }
    if (state.page > 1) { p.set('page', String(state.page)); }
    var url = location.pathname + (p.toString() ? '?' + p.toString() : '');
    if (replace) { history.replaceState(null, '', url); }
    else { history.pushState(null, '', url); }
  }

  /* --------------------------------------------------------- 필터링/정렬 */
  function filtered() {
    var list = state.catalog.products.slice();
    var q = state.q.toLowerCase();
    if (q) {
      list = list.filter(function (p) {
        return [p.name, p.model, p.brand, p.summary, p.sourceCategoryPath, p.manufacturer]
          .join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    if (state.brand) {
      list = list.filter(function (p) { return p.brand === state.brand; });
    }
    if (state.approvedOnly) {
      list = list.filter(function (p) { return p.cgiSaleStatus === 'approved'; });
    }
    var by = {
      name: function (a, b) { return a.name.localeCompare(b.name, 'ko'); },
      price_asc: function (a, b) { return (a.price === null ? Infinity : a.price) - (b.price === null ? Infinity : b.price); },
      price_desc: function (a, b) { return (b.price === null ? -Infinity : b.price) - (a.price === null ? -Infinity : a.price); },
      brand: function (a, b) { return a.brand.localeCompare(b.brand, 'ko') || a.name.localeCompare(b.name, 'ko'); },
      recent: function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); }
    };
    list.sort(by[state.sort] || by.recent);
    return list;
  }

  /* ------------------------------------------------------------- 렌더링 */
  function priceMarkup(p) {
    var box = el('div', 'price');
    if (p.priceState === 'public' && p.price !== null) {
      box.appendChild(el('span', 'value', won(p.price)));
      var s = el('small', null, '원본 공개가(참고)');
      box.lastChild.appendChild(s);
    } else if (p.priceState === 'inquiry_price') {
      box.classList.add('inquiry');
      box.appendChild(el('span', 'value', '가격 문의'));
      box.lastChild.appendChild(el('small', null, ' · 공급처 문의 필요'));
    } else if (p.priceState === 'sold_out_sale_completed') {
      box.classList.add('inquiry');
      box.appendChild(el('span', 'value', '판매 완료 / 품절'));
    } else {
      box.classList.add('unknown');
      box.appendChild(el('span', 'value', '가격 정보 없음'));
    }
    return box;
  }

  function card(p) {
    var a = el('a', 'card');
    a.href = 'product.html?id=' + encodeURIComponent(p.id);

    var thumb = el('div', 'thumb');
    if (p.image) {
      var img = el('img');
      img.src = p.image;
      img.alt = p.name;
      img.loading = 'lazy';
      img.onerror = function () { img.remove(); thumb.appendChild(el('div', 'placeholder', '이미지 없음')); };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', 'placeholder', '이미지 없음'));
    }
    var badges = el('div', 'badges');
    var isSamaStore = p.sourceSite.indexOf('samamusic') >= 0;
    badges.appendChild(el('span', 'badge ' + (isSamaStore ? 'src-samamusic' : 'src-samasound'),
      isSamaStore ? '삼아스토어' : '삼아사운드'));
    badges.appendChild(el('span', 'badge ' + (p.cgiSaleStatus === 'approved' ? 'approved' : 'unapproved'),
      p.cgiSaleStatus === 'approved' ? 'CGI 승인' : 'CGI 승인 전'));
    thumb.appendChild(badges);
    a.appendChild(thumb);

    var body = el('div', 'body');
    body.appendChild(el('span', 'brand', p.brand || '브랜드 미확인'));
    var nm = el('span', 'name', p.name || '(상품명 미확인)');
    body.appendChild(nm);
    if (p.model) { body.appendChild(el('span', 'model', '모델 ' + p.model)); }
    body.appendChild(priceMarkup(p));
    var src = el('div', 'src');
    src.appendChild(document.createTextNode('출처 '));
    var shortName = isSamaStore ? '삼아스토어' : '삼아사운드';
    var link = el('a', null, shortName);
    link.href = p.canonicalUrl;
    link.target = '_blank';
    link.rel = 'noopener nofollow';
    link.title = p.sourceSiteLabel + ' — 원본 상품 페이지';
    link.onclick = function (e) { e.stopPropagation(); };
    src.appendChild(link);
    body.appendChild(src);
    a.appendChild(body);
    return a;
  }

  function renderGrid(list) {
    var grid = $('#grid');
    grid.innerHTML = '';
    var pageItems = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    pageItems.forEach(function (p) { grid.appendChild(card(p)); });
    $('#emptyState').hidden = pageItems.length > 0;

    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > pages) { state.page = pages; }
    $('#resultCount').innerHTML = '';
    $('#resultCount').appendChild(document.createTextNode('상품 ' + total + '건'));
    var small = el('small', null, '수집 ' + state.catalog.totalCollected + '건 중 · ' +
      'CGI 승인 ' + state.catalog.approvedCount + '건 · 1페이지 ' + Math.min(PAGE_SIZE, total) + '건 표시');
    $('#resultCount').appendChild(small);
  }

  function renderPager(total) {
    var pager = $('#pager');
    pager.innerHTML = '';
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (pages <= 1) { return; }

    function go(p, label, cls, disabled) {
      var node = disabled ? el('span', cls) : el('a', cls);
      if (!disabled) {
        node.href = '#';
        node.setAttribute('data-page', String(p));
      }
      node.textContent = label;
      if (disabled) { node.classList.add('disabled'); }
      pager.appendChild(node);
      return node;
    }

    go(state.page - 1, '이전', 'prev', state.page <= 1);
    var window_ = [];
    for (var p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - state.page) <= 2) { window_.push(p); }
      else if (window_[window_.length - 1] !== '…') { window_.push('…'); }
    }
    window_.forEach(function (p) {
      if (p === '…') { pager.appendChild(el('span', 'gap', '…')); return; }
      if (p === state.page) {
        var cur = el('span', 'current', String(p));
        cur.setAttribute('aria-current', 'page');
        pager.appendChild(cur);
      } else {
        go(p, String(p), 'num');
      }
    });
    go(state.page + 1, '다음', 'next', state.page >= pages);
  }

  function renderLnb() {
    var list = $('#lnbList');
    list.innerHTML = '';
    state.catalog.categories.forEach(function (c) {
      var li = el('li');
      var a = el('a', null, c.name);
      a.href = '#';
      a.setAttribute('data-cate', c.id);
      if (c.product_count) {
        a.appendChild(el('span', 'count', ' (' + c.product_count + ')'));
      }
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function renderBrands() {
    var box = $('#brandFacet');
    box.innerHTML = '';
    state.catalog.brands.forEach(function (b) {
      var label = el('label');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.value = b.name;
      cb.checked = state.brand === b.name;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(b.name));
      label.appendChild(el('span', 'count', String(b.count)));
      box.appendChild(label);
    });
  }

  function renderSourceNote() {
    var m = state.catalog.meta;
    var box = $('#sourceNote');
    box.innerHTML = '';
    var lines = (m.data_basis || []).map(function (t) { return '· ' + t; });
    lines.push('· 생성 ' + (m.generated_at || '').replace('T', ' ').replace('Z', ' UTC'));
    lines.forEach(function (t) { box.appendChild(el('div', null, t)); });
  }

  function renderCrumbs() {
    var c = $('#crumbs');
    c.innerHTML = '';
    c.appendChild(el('a', null, '홈'));
    c.appendChild(document.createTextNode(' › '));
    c.appendChild(el('span', null, '전체 상품'));
    if (state.brand) {
      c.appendChild(document.createTextNode(' › '));
      c.appendChild(el('span', null, state.brand));
    }
    if (state.q) {
      c.appendChild(document.createTextNode(' › '));
      c.appendChild(el('span', null, '검색: ' + state.q));
    }
  }

  function render() {
    var list = filtered();
    renderGrid(list);
    renderPager(list.length);
    renderCrumbs();
    $('#sortSelect').value = state.sort;
    $('#approvedOnly').checked = state.approvedOnly;
    $('#q').value = state.q;
  }

  /* ------------------------------------------------------------- 이벤트 */
  function bind() {
    $('#searchForm').addEventListener('submit', function (e) {
      e.preventDefault();
      state.q = $('#q').value.trim();
      state.page = 1;
      writeQuery(false);
      render();
    });

    $('#sortSelect').addEventListener('change', function (e) {
      state.sort = e.target.value;
      state.page = 1;
      writeQuery(false);
      render();
    });

    $('#approvedOnly').addEventListener('change', function (e) {
      state.approvedOnly = e.target.checked;
      state.page = 1;
      writeQuery(false);
      render();
    });

    $('#brandFacet').addEventListener('change', function (e) {
      if (e.target.type !== 'checkbox') { return; }
      state.brand = e.target.checked ? e.target.value : '';
      state.page = 1;
      writeQuery(false);
      render();
    });

    $('#clearBrands').addEventListener('click', function () {
      state.brand = '';
      state.page = 1;
      writeQuery(false);
      render();
      renderBrands();
    });

    $('#pager').addEventListener('click', function (e) {
      var a = e.target.closest('a[data-page]');
      if (!a) { return; }
      e.preventDefault();
      state.page = parseInt(a.getAttribute('data-page'), 10) || 1;
      writeQuery(false);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('#lnbList').addEventListener('click', function (e) {
      var a = e.target.closest('a[data-cate]');
      if (!a) { return; }
      e.preventDefault();
      var id = a.getAttribute('data-cate');
      var cat = state.catalog.categories.filter(function (c) { return c.id === id; })[0];
      if (cat) {
        state.q = '';
        state.brand = '';
        state.page = 1;
        $('#facetBox').classList.add('open');
        writeQuery(false);
        render();
        renderBrands();
        $('#lnbList').classList.remove('open');
        $('#lnbToggle').setAttribute('aria-expanded', 'false');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    $('#lnbToggle').addEventListener('click', function () {
      var open = $('#lnbList').classList.toggle('open');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // 모바일에서 사이드 필터(브랜드) 토글 — 데스크톱에서는 항상 보인다
    var facetToggle = $('#facetToggle');
    if (facetToggle) {
      facetToggle.addEventListener('click', function () {
        var open = $('#facetBox').classList.toggle('open');
        this.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    window.addEventListener('popstate', function () {
      readQuery();
      render();
      renderBrands();
    });
  }

  /* --------------------------------------------------------------- 시작 */
  function boot() {
    readQuery();
    CGICatalog.load({
      inlineVar: 'CGI_CATALOG',
      jsonUrls: ['data/catalog.full.json', 'data/catalog.demo.json']
    }).then(function (catalog) {
      state.catalog = catalog;
      renderLnb();
      renderSourceNote();
      // 상세 페이지에서는 목록 렌더링 요소가 없으므로 공통 요소만 초기화한다
      if (!$('#grid')) { bindCommon(); return; }
      renderBrands();
      render();
      bind();
    }).catch(function (err) {
      var grid = $('#grid');
      if (!grid) { return; }
      grid.innerHTML = '';
      var e = el('div', 'empty');
      e.appendChild(el('strong', null, '카탈로그 데이터를 불러오지 못했습니다.'));
      e.appendChild(el('div', null, String(err && err.message ? err.message : err)));
      grid.appendChild(e);
      $('#resultCount').textContent = '데이터 없음';
    });
  }

  /* 목록/상세 공통으로 쓰는 요소만 바인딩 (검색, LNB 토글) */
  function bindCommon() {
    var form = $('#searchForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        location.href = 'index.html?q=' + encodeURIComponent($('#q').value.trim());
      });
    }
    var toggle = $('#lnbToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = $('#lnbList').classList.toggle('open');
        this.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    var list = $('#lnbList');
    if (list) {
      list.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-cate]');
        if (!a) { return; }
        e.preventDefault();
        location.href = 'index.html';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
