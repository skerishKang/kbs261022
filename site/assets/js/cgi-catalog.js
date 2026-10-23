/* ==========================================================================
   CGI 상품 카탈로그 — 프런트엔드
   - 정적 HTML/CSS/JS (빌드 없음)
   - 라우팅: #/ · #/products?... · #/product/<id> · #/quote-cart · #/about
   - 데이터: window.CGI_PRODUCTS (data/products.js) 또는 ?data=<json>
   - 원본 데이터는 수정하지 않고, 화면 렌더링 단계에서 이미지·표시 정보를 정리한다.
   ========================================================================== */
(function () {
  'use strict';

  var PER_PAGE = 12;
  var HOME_CHIP_LIMIT = 10;
  var app = document.getElementById('app');
  var loadingBox = document.getElementById('loadingBox');
  var lastView = null;
  var toastTimer = null;

  var state = {
    products: [],
    meta: { product_count: 0, source_labels: {}, supplier_catalog_totals: {} },
    route: { view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'recent', page: 1, id: null },
    quoteCart: [],
    quoteServices: [],
    quoteCartServices: [],
    failedImages: {}
  };

  /* ---------------------------------------------------------------- utils */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function norm(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[()[\]/,.·]/g, '');
  }
  function decodeUrl(url) {
    return String(url == null ? '' : url)
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&#x0*26;/gi, '&')
      .trim();
  }
  function absoluteUrl(url) {
    try { return new URL(url, location.href).href; } catch (e) { return String(url || ''); }
  }
  function fmtPrice(product) {
    if (!product.price) return { text: '가격 문의', inquiry: true, cls: 'inquiry' };
    if (product.price.state === 'public' && product.price.value !== null && product.price.value !== undefined) {
      return { text: Number(product.price.value).toLocaleString('ko-KR') + '원', inquiry: false, cls: '' };
    }
    return { text: '가격 문의', inquiry: true, cls: 'inquiry' };
  }
  function priceText(product) {
    return fmtPrice(product).text;
  }
  function displayBrand(product) {
    return product.brand_norm || product.brand || product.manufacturer ||
      (product.source && product.source.site_label) || '브랜드 미확인';
  }
  function categoryLabel(product) {
    if (product.category && product.category.name) return product.category.name;
    if (product.category_path && product.category_path.length) return product.category_path[product.category_path.length - 1];
    return '미분류';
  }
  function siteLabel(product) {
    return (product.source && (product.source.site_label || product.source.site)) || '공급처';
  }
  function productUrl(id) { return '#/product/' + encodeURIComponent(id); }
  function findProduct(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }
  function listUrl(overrides) {
    var r = state.route;
    var params = [];
    var q = overrides && 'q' in overrides ? overrides.q : r.q;
    var brands = overrides && 'brands' in overrides ? overrides.brands : r.brands;
    var cats = overrides && 'cats' in overrides ? overrides.cats : r.cats;
    var sites = overrides && 'sites' in overrides ? overrides.sites : r.sites;
    var sort = overrides && 'sort' in overrides ? overrides.sort : r.sort;
    if (q) params.push('q=' + encodeURIComponent(q));
    if (brands && brands.length) params.push('brand=' + encodeURIComponent(brands.join('|')));
    if (cats && cats.length) params.push('cat=' + encodeURIComponent(cats.join('|')));
    if (sites && sites.length) params.push('site=' + encodeURIComponent(sites.join('|')));
    if (sort && sort !== 'recent') params.push('sort=' + encodeURIComponent(sort));
    return '#/products' + (params.length ? '?' + params.join('&') : '');
  }
  function countBy(list, keyFn) {
    var map = {};
    list.forEach(function (item) {
      var key = keyFn(item);
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
    });
    return map;
  }
  function updatedAt(product) {
    return (product.source && product.source.updated_at) || '';
  }
  function recentCompare(a, b) {
    var at = updatedAt(a), bt = updatedAt(b);
    if (at === bt) return a.name.localeCompare(b.name, 'ko');
    return at < bt ? 1 : -1;
  }
  function showToast(message) {
    var box = document.getElementById('cgiToast');
    if (!box) return;
    box.textContent = message;
    box.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('is-on'); }, 2400);
  }

  /* --------------------------------------------------------------- images */
  /* 공급처 페이지에서 함께 수집된 카테고리/브랜드 배너·이벤트 이미지를 갤러리에서 제외한다.
     데이터 원본(products.js)은 그대로 두고, 렌더링용 복사본에서만 정리한다. */
  var BANNER_IMAGE_RE = /(?:^|[/_.-])(?:banner|events?|promo(?:tion)?|sale|notice|firmware|warranty|popup|maintenance|experience|brandpage|brand[_-]?top|anniversary|anniv)\d*(?:[/_.-]|$)/i;
  var BRAND_HEADER_RE = /(?:^|\/)(?:copy-[\d-]+-)?data_[^/]+$/i;

  function imageRank(url) {
    if (/\/web\/product\/small\//.test(url)) return 0;
    if (/\/web\/product\/extra\/small\//.test(url)) return 1;
    if (/\/web\/product\/extra\/big\//.test(url)) return 2;
    if (/\/web\/product\/big\//.test(url)) return 3;
    if (/\/web\/product\//.test(url)) return 4;
    if (/NNEditor/.test(url)) return 6;
    return 5;
  }
  function cleanImages(images) {
    var seen = {}, out = [];
    (images || []).forEach(function (raw) {
      var url = decodeUrl(raw);
      if (!/^https?:\/\//i.test(url)) return;
      if (BANNER_IMAGE_RE.test(url) || BRAND_HEADER_RE.test(url)) return;
      var key = absoluteUrl(url);
      if (seen[key] || state.failedImages[key]) return;
      seen[key] = true;
      out.push(url);
    });
    out.sort(function (a, b) { return imageRank(a) - imageRank(b); });
    var productShots = out.filter(function (url) { return /\/web\/product\//i.test(url); });
    if (productShots.length) out = productShots; // 상세 설명용 장문 마케팅 이미지는 갤러리에서 제외
    return out.slice(0, 8);
  }
  function imageHtml(product, className) {
    if (!product.images.length) {
      return '<div class="' + className + ' no-image"><span class="no-image-logo">CGI</span><span>이미지 준비 중</span></div>';
    }
    return '<img class="' + className + '" src="' + esc(product.images[0]) + '" alt="' + esc(product.name) + '" loading="lazy" decoding="async">';
  }
  function fallbackBlock(className) {
    return '<div class="' + className + ' no-image"><span class="no-image-logo">CGI</span><span>이미지 준비 중</span></div>';
  }

  /* ------------------------------------------------------------- data load */
  function loadProducts() {
    var params = new URLSearchParams(location.search);
    var dataParam = params.get('data');
    if (dataParam) {
      return fetch(dataParam).then(function (res) {
        if (!res.ok) throw new Error('데이터 파일을 읽지 못했습니다: ' + res.status);
        return res.json();
      }).then(function (rows) {
        state.products = (rows.products || rows).map(prepare);
        if (rows.meta) state.meta = Object.assign(state.meta, rows.meta);
        return state.products;
      });
    }
    var rows = window.CGI_PRODUCTS || [];
    state.products = rows.map(prepare);
    if (window.CGI_PRODUCT_META) state.meta = Object.assign(state.meta, window.CGI_PRODUCT_META);
    return Promise.resolve(state.products);
  }

  function prepare(product) {
    var p = Object.assign({}, product);
    p.specs = p.specs || [];
    p.options = p.options || [];
    p.source = p.source || {};
    p.images = cleanImages(p.images);
    p._search = norm([p.name, p.model, p.brand, p.brand_raw, p.manufacturer, categoryLabel(p),
      (p.category_path || []).join(' '),
      (p.specs || []).map(function (s) { return s.label + ' ' + s.value; }).join(' ')].join(' '));
    p._cat = categoryLabel(p);
    p._brand = displayBrand(p);
    return p;
  }

  /* --------------------------------------------------------------- filter */
  function filteredProducts() {
    var r = state.route;
    var q = norm(r.q);
    var brandSet = {}, catSet = {}, siteSet = {};
    r.brands.forEach(function (b) { brandSet[b] = true; });
    r.cats.forEach(function (c) { catSet[c] = true; });
    r.sites.forEach(function (s) { siteSet[s] = true; });

    var list = state.products.filter(function (p) {
      if (q && p._search.indexOf(q) === -1) return false;
      if (r.brands.length && !brandSet[p._brand]) return false;
      if (r.cats.length && !catSet[p._cat]) return false;
      if (r.sites.length && !siteSet[p.source.site]) return false;
      return true;
    });

    var sort = r.sort || 'recent';
    list.sort(function (a, b) {
      if (sort === 'price_asc' || sort === 'price_desc') {
        var av = a.price && a.price.value !== null && a.price.value !== undefined ? a.price.value : null;
        var bv = b.price && b.price.value !== null && b.price.value !== undefined ? b.price.value : null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return sort === 'price_asc' ? av - bv : bv - av;
      }
      if (sort === 'name') return a.name.localeCompare(b.name, 'ko');
      return recentCompare(a, b);
    });
    return list;
  }

  /* ------------------------------------------------------------- fragments */
  function cardHtml(product) {
    var price = fmtPrice(product);
    var badge = price.inquiry
      ? '<span class="badge inquiry">가격 문의</span>'
      : '<span class="badge">공개 판매가</span>';
    return '' +
      '<a class="product-card" href="' + esc(productUrl(product.id)) + '" data-product-id="' + esc(product.id) + '">' +
        '<div class="thumb">' + badge + imageHtml(product, 'card-img') + '</div>' +
        '<div class="card-body">' +
          '<span class="card-brand">' + esc(displayBrand(product)) + '</span>' +
          '<h3 class="card-name">' + esc(product.name) + '</h3>' +
          (product.model && product.model !== product.name ? '<span class="card-model">' + esc(product.model) + '</span>' : '') +
          '<div class="card-foot">' +
            '<span class="price ' + price.cls + '">' + esc(price.text) + '</span>' +
            '<span class="card-site">' + esc(siteLabel(product)) + '</span>' +
          '</div>' +
        '</div>' +
      '</a>';
  }

  function gridHtml(list) {
    if (!list.length) {
      return '<div class="empty-state">' +
        '<div class="empty-icon" aria-hidden="true">?</div>' +
        '<h3>검색 결과가 없습니다</h3>' +
        '<p>검색어 또는 필터 조건을 바꿔 다시 시도해 주세요.</p>' +
        '<div class="empty-actions">' +
          '<button class="btn btn-primary" data-action="reset-filters">필터 초기화</button>' +
          '<a class="btn btn-secondary" href="#/">홈으로</a>' +
        '</div>' +
      '</div>';
    }
    return '<div class="product-grid">' + list.map(cardHtml).join('') + '</div>';
  }

  function orderedFacetValues(counts, selected) {
    var values = Object.keys(counts);
    values.sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a.localeCompare(b, 'ko');
    });
    if (selected && selected.length) {
      values.sort(function (a, b) {
        var as = selected.indexOf(a) !== -1 ? 0 : 1;
        var bs = selected.indexOf(b) !== -1 ? 0 : 1;
        return as - bs;
      });
    }
    return values;
  }

  function facetBlock(title, name, values, counts, selected) {
    if (!values.length) return '';
    var rows = values.map(function (value, idx) {
      var id = 'f-' + name + '-' + idx;
      var checked = selected.indexOf(value) !== -1 ? ' checked' : '';
      return '<label for="' + id + '">' +
        '<input type="checkbox" id="' + id + '" data-facet="' + name + '" value="' + esc(value) + '"' + checked + '>' +
        '<span>' + esc(value) + '</span>' +
        '<span class="cnt">' + Number(counts[value] || 0).toLocaleString('ko-KR') + '</span>' +
      '</label>';
    }).join('');
    return '<details class="filter-group" open>' +
      '<summary><span>' + esc(title) + '</span><span class="facet-total">' + values.length + '</span></summary>' +
      '<div class="filter-body">' +
        (values.length > 10
          ? '<input type="search" class="facet-search" data-facet-search="' + name + '" placeholder="' + esc(title) + ' 검색" aria-label="' + esc(title) + ' 검색" autocomplete="off">'
          : '') +
        '<div class="filter-list">' + rows + '</div>' +
      '</div>' +
    '</details>';
  }

  function chipHtml(label, count, kind) {
    var overrides = { q: '', brands: [], cats: [], sites: [] };
    if (kind === 'brand') overrides.brands = [label];
    else overrides.cats = [label];
    return '<a class="chip" href="' + esc(listUrl(overrides)) + '">' + esc(label) +
      '<span class="cnt">' + Number(count || 0).toLocaleString('ko-KR') + '</span></a>';
  }

  function chipSection(title, values, counts, kind, limit) {
    if (!values.length) return '';
    var top = values.slice(0, limit);
    var rest = values.slice(limit);
    return '<section class="section">' +
      '<div class="section-head"><h2>' + esc(title) + '</h2><a class="more" href="#/products">전체 상품 →</a></div>' +
      '<div class="chip-row">' + top.map(function (v) { return chipHtml(v, counts[v], kind); }).join('') + '</div>' +
      (rest.length
        ? '<details class="chip-more"><summary>' + esc(title) + ' 전체 보기 (' + values.length + ')</summary>' +
            '<div class="chip-row">' + rest.map(function (v) { return chipHtml(v, counts[v], kind); }).join('') + '</div></details>'
        : '') +
    '</section>';
  }

  function pickFeatured(limit) {
    var priority = ['SHURE', 'GENELEC', 'ALLEN&HEATH', 'PRESONUS', 'KLOTZ', 'NEUTRIK', 'APOGEE', 'ARTURIA'];
    var candidates = state.products.filter(function (p) {
      return p.images.length && p.price && p.price.state === 'public';
    }).sort(recentCompare);
    var chosen = [], usedId = {}, usedBrand = {};
    priority.forEach(function (brand) {
      if (chosen.length >= limit) return;
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i]._brand === brand && !usedBrand[brand]) {
          chosen.push(candidates[i]);
          usedBrand[brand] = true;
          usedId[candidates[i].id] = true;
          break;
        }
      }
    });
    candidates.forEach(function (p) {
      if (chosen.length >= limit) return;
      if (usedId[p.id] || usedBrand[p._brand]) return;
      chosen.push(p);
      usedBrand[p._brand] = true;
      usedId[p.id] = true;
    });
    if (chosen.length < limit) {
      state.products.forEach(function (p) {
        if (chosen.length >= limit) return;
        if (!usedId[p.id] && p.images.length) {
          chosen.push(p);
          usedId[p.id] = true;
        }
      });
    }
    return chosen.slice(0, limit);
  }

  function servicesHtml(mode) {
    var services = window.CGI_SERVICES || [];
    var selected = mode === 'cart' ? (state.quoteCartServices || []) : (state.quoteServices || []);
    return services.map(function (svc) {
      var id = 'svc-' + mode + '-' + svc.id;
      var checked = selected.indexOf(svc.id) !== -1 ? ' checked' : '';
      return '<label class="service-check" for="' + esc(id) + '">' +
        '<input type="checkbox" id="' + esc(id) + '" value="' + esc(svc.id) + '" ' +
          (mode === 'cart' ? 'data-cart-service' : 'data-detail-service') + checked + '>' +
        '<span class="service-copy"><strong>' + esc(svc.name) + '</strong><span>' + esc(svc.description) + '</span></span>' +
      '</label>';
    }).join('');
  }

  function bindServiceInputs(mode) {
    var selector = mode === 'cart' ? 'input[data-cart-service]' : 'input[data-detail-service]';
    Array.prototype.forEach.call(app.querySelectorAll(selector), function (input) {
      input.addEventListener('change', function () {
        if (mode === 'cart') window.cgiToggleQuoteService(input.value, input.checked);
        else window.cgiToggleService(input.value, input.checked);
      });
    });
  }

  /* --------------------------------------------------------------- views */
  function renderHome() {
    var total = state.products.length;
    var brandCounts = countBy(state.products, function (p) { return p._brand; });
    var catCounts = countBy(state.products, function (p) { return p._cat; });
    var brands = orderedFacetValues(brandCounts, []);
    var cats = orderedFacetValues(catCounts, []);
    var priced = state.products.filter(function (p) { return p.price && p.price.state === 'public'; }).length;
    var inquiry = state.products.filter(function (p) { return !p.price || p.price.state !== 'public'; }).length;
    var featured = pickFeatured(8);

    app.innerHTML =
      '<section class="hero">' +
        '<p class="hero-eyebrow">CGI B2B CATALOG</p>' +
        '<h1>CGI 상품 카탈로그</h1>' +
        '<p class="hero-copy">음향·영상·조명 장비를 브랜드와 카테고리로 찾고, 필요한 상품을 견적 목록에 담아 요청하세요.</p>' +
        '<form class="hero-search" data-action="hero-search">' +
          '<input type="search" name="q" placeholder="상품명·모델명·브랜드 검색" aria-label="상품 검색">' +
          '<button type="submit">상품 검색</button>' +
        '</form>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>추천 상품</h2><a class="more" href="#/products">전체 상품 보기 →</a></div>' +
        gridHtml(featured) +
      '</section>' +

      '<dl class="stat-row">' +
        '<div class="stat-card"><dt>전체 상품</dt><dd>' + total.toLocaleString('ko-KR') + '<small>브랜드·카테고리 기준</small></dd></div>' +
        '<div class="stat-card"><dt>취급 브랜드</dt><dd>' + brands.length + '<small>카탈로그 등록 브랜드</small></dd></div>' +
        '<div class="stat-card"><dt>공개 판매가</dt><dd>' + priced.toLocaleString('ko-KR') + '<small>공급처 공개 가격 기준</small></dd></div>' +
        '<div class="stat-card"><dt>가격 문의</dt><dd>' + inquiry.toLocaleString('ko-KR') + '<small>담당자 확인 후 안내</small></dd></div>' +
      '</dl>' +

      chipSection('브랜드별 찾기', brands, brandCounts, 'brand', HOME_CHIP_LIMIT) +
      chipSection('카테고리별 찾기', cats, catCounts, 'cat', HOME_CHIP_LIMIT) +

      '<section class="home-cta">' +
        '<div><h2>원하는 상품을 찾지 못하셨나요?</h2><p>상품명·모델명으로 검색하거나 CGI 담당자에게 문의해 주세요.</p></div>' +
        '<a class="btn btn-primary" href="tel:0625768100">062) 576-8100</a>' +
      '</section>';
  }

  function renderList() {
    var r = state.route;
    var list = filteredProducts();
    var brandCounts = countBy(state.products, function (p) { return p._brand; });
    var catCounts = countBy(state.products, function (p) { return p._cat; });
    var siteCounts = countBy(state.products, function (p) { return p.source.site; });
    var brandValues = orderedFacetValues(brandCounts, r.brands);
    var catValues = orderedFacetValues(catCounts, r.cats);
    var siteValues = orderedFacetValues(siteCounts, r.sites);

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (r.page > pages) r.page = pages;
    var start = (r.page - 1) * PER_PAGE;
    var pageItems = list.slice(start, start + PER_PAGE);

    var activeChips = [];
    r.brands.forEach(function (b) { activeChips.push({ kind: 'brands', value: b, label: '브랜드: ' + b }); });
    r.cats.forEach(function (c) { activeChips.push({ kind: 'cats', value: c, label: '카테고리: ' + c }); });
    r.sites.forEach(function (s) {
      var label = (state.meta.source_labels && state.meta.source_labels[s]) || s;
      activeChips.push({ kind: 'sites', value: s, label: '공급처: ' + label });
    });
    if (r.q) activeChips.push({ kind: 'q', value: '', label: '검색: ' + r.q });

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><span>상품 목록</span></div>' +
      '<header class="page-head">' +
        '<p class="page-eyebrow">Products</p>' +
        '<h1>' + (r.q ? '상품 검색' : '전체 상품') + '</h1>' +
        '<p class="page-sub">' + (r.q ? '“' + esc(r.q) + '” 검색 결과 ' + list.length.toLocaleString('ko-KR') + '건입니다.' : '브랜드와 카테고리로 원하는 장비를 찾아보세요.') + '</p>' +
      '</header>' +
      '<div class="list-layout">' +
        '<aside>' +
          '<button class="filter-toggle" data-action="toggle-filters" aria-expanded="false" aria-controls="filterPanel">필터 열기</button>' +
          '<div class="filter-panel" id="filterPanel">' +
            facetBlock('브랜드', 'brand', brandValues, brandCounts, r.brands) +
            facetBlock('카테고리', 'cat', catValues, catCounts, r.cats) +
            facetBlock('공급처', 'site', siteValues, siteCounts, r.sites) +
            '<button class="filter-reset" data-action="reset-filters">필터 초기화</button>' +
          '</div>' +
        '</aside>' +
        '<div>' +
          '<div class="list-toolbar">' +
            '<span class="result-count"><b>' + list.length.toLocaleString('ko-KR') + '</b>건' + (r.q ? ' · “' + esc(r.q) + '”' : '') + '</span>' +
            '<select class="sort-select" id="sortSelect" aria-label="정렬">' +
              '<option value="recent"' + (r.sort === 'recent' ? ' selected' : '') + '>최신 등록순</option>' +
              '<option value="price_asc"' + (r.sort === 'price_asc' ? ' selected' : '') + '>가격 낮은순</option>' +
              '<option value="price_desc"' + (r.sort === 'price_desc' ? ' selected' : '') + '>가격 높은순</option>' +
              '<option value="name"' + (r.sort === 'name' ? ' selected' : '') + '>상품명순</option>' +
            '</select>' +
          '</div>' +
          (activeChips.length ? '<div class="active-filters">' + activeChips.map(function (chip) {
            return '<span class="active-filter">' + esc(chip.label) +
              '<button data-remove="' + chip.kind + '" data-value="' + esc(chip.value) + '" aria-label="' + esc(chip.label) + ' 제거">×</button></span>';
          }).join('') + '</div>' : '') +
          gridHtml(pageItems) +
          paginationHtml(r.page, pages) +
        '</div>' +
      '</div>';

    if (window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
      var panel = document.getElementById('filterPanel');
      var toggle = document.querySelector('[data-action="toggle-filters"]');
      if (panel) panel.setAttribute('hidden', '');
      if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '필터 열기'; }
    }
  }

  function paginationHtml(current, total) {
    if (total <= 1) return '';
    var items = [];
    items.push('<button data-page="' + (current - 1) + '"' + (current === 1 ? ' disabled' : '') + '>이전</button>');
    var start = Math.max(1, current - 2);
    var end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    for (var i = start; i <= end; i++) {
      items.push('<button data-page="' + i + '" class="' + (i === current ? 'is-current' : '') + '" aria-current="' + (i === current ? 'page' : 'false') + '">' + i + '</button>');
    }
    items.push('<button data-page="' + (current + 1) + '"' + (current === total ? ' disabled' : '') + '>다음</button>');
    return '<nav class="pagination" aria-label="페이지네이션">' + items.join('') + '</nav>';
  }

  function renderDetail(id) {
    state.quoteServices = [];
    var product = findProduct(id);
    if (!product) {
      app.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">?</div>' +
        '<h3>상품을 찾을 수 없습니다</h3><p>삭제되었거나 주소가 잘못된 상품입니다.</p>' +
        '<div class="empty-actions"><a class="btn btn-primary" href="#/products">상품 목록으로</a></div></div>';
      return;
    }
    var price = fmtPrice(product);
    var images = product.images;
    var specRows = (product.specs || []).filter(function (s) { return s.label && s.value; });

    var thumbs = images.map(function (img, idx) {
      return '<button type="button" class="' + (idx === 0 ? 'is-active' : '') + '" data-gallery-index="' + idx + '" data-img-url="' + esc(img) + '" aria-label="이미지 ' + (idx + 1) + '">' +
        '<img src="' + esc(img) + '" alt="' + esc(product.name) + ' 이미지 ' + (idx + 1) + '" loading="lazy" decoding="async"></button>';
    }).join('');
    var mainImg = images.length
      ? '<img id="galleryMain" src="' + esc(images[0]) + '" data-img-url="' + esc(images[0]) + '" alt="' + esc(product.name) + '" decoding="async">'
      : fallbackBlock('gallery-no-image');

    var optionsHtml = '';
    if (product.options && product.options.length) {
      optionsHtml = '<div class="detail-block"><h3>옵션 정보</h3><table class="spec-table"><tbody>' +
        product.options.map(function (opt) {
          return '<tr><th>' + esc(opt.name) + '</th><td>' + esc(opt.price_text) +
            (opt.availability ? ' · ' + esc(opt.availability) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    var sourceUrl = product.source && product.source.url ? product.source.url : '';
    var originalLink = sourceUrl
      ? '<a href="' + esc(sourceUrl) + '" target="_blank" rel="noopener noreferrer">공급처 상품 페이지에서 확인 ↗</a>'
      : '확인 중';

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><a href="' + esc(listUrl({ q: '', brands: [], cats: [], sites: [] })) + '">상품 목록</a><span>›</span><span>' + esc(product.name) + '</span></div>' +
      '<div class="detail-grid">' +
        '<div>' +
          '<div class="gallery-main">' + mainImg + '</div>' +
          (thumbs ? '<div class="gallery-thumbs">' + thumbs + '</div>' : '') +
        '</div>' +
        '<div>' +
          '<h1 class="detail-title">' + esc(product.name) + '</h1>' +
          '<p class="detail-sub">' +
            esc(displayBrand(product)) +
            (product.manufacturer && product.manufacturer !== displayBrand(product) ? ' · 제조사 ' + esc(product.manufacturer) : '') +
            (product.model ? ' · 모델 ' + esc(product.model) : '') +
            ' · ' + esc(product._cat) +
          '</p>' +
          '<div class="detail-price-row">' +
            '<span class="detail-price ' + price.cls + '">' + esc(price.text) + '</span>' +
            '<span class="detail-price-note">' + (price.inquiry
              ? '공급처에 공개된 판매가가 없어 담당자가 확인 후 안내합니다.'
              : '공급처 공개 판매가 기준이며, 최종 견적은 CGI 확인 후 안내합니다.') + '</span>' +
          '</div>' +

          '<div class="detail-block"><h3>추가 서비스 (선택)</h3>' +
            '<p class="detail-price-note">설치·출장·유지보수가 필요하면 선택하세요. 요청 후 담당자가 확인합니다.</p>' +
            '<div class="service-checks">' + servicesHtml('detail') + '</div>' +
          '</div>' +

          '<div class="detail-cta">' +
            '<button type="button" class="btn btn-primary btn-lg" data-action="quote-now" data-product-id="' + esc(product.id) + '">견적 요청하기</button>' +
            '<button type="button" class="btn btn-secondary btn-lg" data-action="add-to-cart" data-product-id="' + esc(product.id) + '">견적 목록에 추가</button>' +
          '</div>' +
          '<p class="detail-cta-note">견적 요청 시 선택한 서비스가 함께 접수됩니다. 최종 금액은 담당자 확인 후 안내합니다.</p>' +

          (specRows.length ? '<table class="spec-table"><tbody>' + specRows.map(function (s) {
            return '<tr><th>' + esc(s.label) + '</th><td>' + esc(s.value) + '</td></tr>';
          }).join('') + '</tbody></table>' : '') +
          optionsHtml +
          '<div class="detail-block"><h3>판매 정보</h3><div class="source-box"><dl>' +
            '<dt>공급처</dt><dd>' + esc(siteLabel(product)) + '</dd>' +
            '<dt>카테고리</dt><dd>' + esc(product._cat) + '</dd>' +
            '<dt>원본 상품</dt><dd>' + originalLink + '</dd>' +
          '</dl></div></div>' +
          '<a class="back-link" href="' + esc(listUrl({})) + '">← 목록으로 돌아가기</a>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-cta">' +
        '<div class="mobile-cta-price"><small>공개 판매가</small><strong>' + esc(price.text) + '</strong></div>' +
        '<button type="button" class="btn btn-primary" data-action="quote-now" data-product-id="' + esc(product.id) + '">견적 요청</button>' +
      '</div>';

    bindServiceInputs('detail');
  }

  function renderQuote(id, serviceIds) {
    var product = findProduct(id);
    if (!product) {
      app.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">?</div><h3>상품을 찾을 수 없습니다</h3></div>';
      return;
    }
    if (serviceIds && serviceIds.length) {
      state.quoteCartServices = serviceIds.filter(function (sid) {
        return (window.CGI_SERVICES || []).some(function (svc) { return svc.id === sid; });
      });
      saveQuoteCartServices();
    }
    addToQuoteCart(product.id, 1, true);
    location.replace('#/quote-cart');
  }

  /* --------------------------------------------------------------- cart */
  function loadQuoteCart() {
    try {
      var raw = localStorage.getItem('cgiQuoteCart');
      var parsed = raw ? JSON.parse(raw) : [];
      state.quoteCart = Array.isArray(parsed) ? parsed.filter(function (item) {
        return item && typeof item.id === 'string' && item.id;
      }).map(function (item) {
        return { id: item.id, qty: Math.max(1, parseInt(item.qty, 10) || 1) };
      }) : [];
    } catch (e) {
      state.quoteCart = [];
    }
  }
  function saveQuoteCart() {
    try { localStorage.setItem('cgiQuoteCart', JSON.stringify(state.quoteCart)); } catch (e) {}
  }
  function loadQuoteCartServices() {
    try {
      var parsed = JSON.parse(localStorage.getItem('cgiQuoteCartServices') || '[]');
      state.quoteCartServices = Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === 'string'; }) : [];
    } catch (e) {
      state.quoteCartServices = [];
    }
  }
  function saveQuoteCartServices() {
    try { localStorage.setItem('cgiQuoteCartServices', JSON.stringify(state.quoteCartServices || [])); } catch (e) {}
  }
  function addToQuoteCart(productId, qty, silent) {
    qty = Math.max(1, parseInt(qty || '1', 10) || 1);
    var existing = null;
    for (var i = 0; i < state.quoteCart.length; i++) {
      if (state.quoteCart[i].id === productId) { existing = state.quoteCart[i]; break; }
    }
    if (existing) existing.qty += qty;
    else state.quoteCart.push({ id: productId, qty: qty });
    saveQuoteCart();
    if (!silent) showToast('견적 목록에 추가했습니다. 상단 ‘견적 목록’에서 확인하세요.');
  }
  function removeFromQuoteCart(productId) {
    state.quoteCart = state.quoteCart.filter(function (x) { return x.id !== productId; });
    saveQuoteCart();
  }
  function updateQuoteCartQty(productId, qty) {
    qty = Math.max(1, parseInt(qty || '1', 10) || 1);
    for (var i = 0; i < state.quoteCart.length; i++) {
      if (state.quoteCart[i].id === productId) { state.quoteCart[i].qty = qty; break; }
    }
    saveQuoteCart();
    return qty;
  }
  function cartItems() {
    var items = state.quoteCart.map(function (c) {
      return { cart: c, product: findProduct(c.id) };
    }).filter(function (x) { return x.product; });
    return items;
  }
  function cartItemCount(items) {
    return items.reduce(function (sum, x) { return sum + (x.cart.qty || 1); }, 0);
  }
  function snapshotCartForm() {
    var form = document.getElementById('quoteCartForm');
    if (!form) return null;
    var snap = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (el.name) snap[el.name] = el.value;
    });
    return snap;
  }
  function restoreCartForm(snap) {
    if (!snap) return;
    var form = document.getElementById('quoteCartForm');
    if (!form) return;
    Object.keys(snap).forEach(function (name) {
      var el = form.elements[name];
      if (el) el.value = snap[name];
    });
  }

  function renderQuoteCart() {
    var snap = snapshotCartForm();
    if (snap) {
      requestAnimationFrame(function () { restoreCartForm(snap); });
    }
    var items = cartItems();
    var quoteText = buildQuoteCartText(items);
    window.cgiLastQuoteCartText = quoteText;

    if (!items.length) {
      app.innerHTML =
        '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><span>견적 목록</span></div>' +
        '<header class="page-head"><p class="page-eyebrow">Quote</p><h1>견적 목록</h1></header>' +
        '<div class="empty-state">' +
          '<div class="empty-icon" aria-hidden="true">＋</div>' +
          '<h3>견적 목록이 비어 있습니다</h3>' +
          '<p>관심 상품을 담으면 한 번에 견적을 요청할 수 있습니다.</p>' +
          '<div class="empty-actions"><a class="btn btn-primary" href="#/products">상품 둘러보기</a></div>' +
        '</div>';
      return;
    }

    var rows = items.map(function (x) {
      var p = x.product;
      var price = fmtPrice(p);
      return '<tr class="cart-row" data-cart-id="' + esc(p.id) + '">' +
        '<td class="c-product" data-label="상품">' +
          '<div class="cart-product">' +
            '<div class="cart-thumb">' + imageHtml(p, 'cart-img') + '</div>' +
            '<div class="cart-info">' +
              '<span class="card-brand">' + esc(displayBrand(p)) + '</span>' +
              '<a class="cart-name" href="' + esc(productUrl(p.id)) + '">' + esc(p.name) + '</a>' +
              '<span class="cart-cat">' + esc(p._cat) + '</span>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td class="c-price" data-label="공개가">' +
          '<span class="cell-label">공개가</span>' +
          '<span class="price ' + price.cls + '">' + esc(price.text) + '</span>' +
        '</td>' +
        '<td class="c-qty" data-label="수량">' +
          '<span class="cell-label">수량</span>' +
          '<div class="qty-stepper">' +
            '<button type="button" data-qty-step="-1" aria-label="수량 줄이기">−</button>' +
            '<input type="number" min="1" inputmode="numeric" value="' + x.cart.qty + '" data-qty-id="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' 수량">' +
            '<button type="button" data-qty-step="1" aria-label="수량 늘리기">＋</button>' +
          '</div>' +
        '</td>' +
        '<td class="c-remove">' +
          '<button type="button" class="cart-remove" data-remove-id="' + esc(p.id) + '" aria-label="' + esc(p.name) + ' 삭제">삭제</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><span>견적 목록</span></div>' +
      '<header class="page-head">' +
        '<p class="page-eyebrow">Quote</p>' +
        '<h1>견적 목록</h1>' +
        '<p class="page-sub">' + items.length.toLocaleString('ko-KR') + '개 상품 · 총 ' + cartItemCount(items) + '점</p>' +
      '</header>' +
      '<div class="cart-layout">' +
        '<div>' +
          '<section class="cart-panel">' +
            '<div class="cart-panel-head"><h2>담은 상품</h2><span>수량을 확인해 주세요</span></div>' +
            '<table class="spec-table cart-table">' +
              '<thead><tr><th>상품</th><th>공개가</th><th>수량</th><th><span class="sr-only">삭제</span></th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
            '<details class="cart-summary">' +
              '<summary>요청 내용 미리보기 · 복사/다운로드</summary>' +
              '<div class="cart-summary-body">' +
                '<pre id="quoteCartText" class="quote-text">' + esc(quoteText) + '</pre>' +
                '<div class="cart-summary-actions">' +
                  '<button type="button" class="btn btn-secondary" data-action="copy-cart">요약 복사</button>' +
                  '<button type="button" class="btn btn-secondary" data-action="download-json">JSON</button>' +
                  '<button type="button" class="btn btn-secondary" data-action="download-csv">CSV</button>' +
                '</div>' +
              '</div>' +
            '</details>' +
            '<div class="cart-total-line"><span>최종 금액</span><strong>담당자 확인 후 안내</strong></div>' +
          '</section>' +
        '</div>' +
        '<aside class="cart-request">' +
          '<div class="cart-panel">' +
            '<h2>견적 요청</h2>' +
            '<p class="panel-sub">담당자가 내용을 확인한 뒤 연락드립니다.</p>' +
            '<div class="cart-service-block">' +
              '<h3>추가 서비스 (선택)</h3>' +
              '<div class="service-checks">' + servicesHtml('cart') + '</div>' +
            '</div>' +
            '<form id="quoteCartForm" class="quote-form" style="margin-top:16px">' +
              '<div class="form-grid">' +
                '<label>회사/기관명 <input type="text" name="company" autocomplete="organization" required></label>' +
                '<label>담당자명 <input type="text" name="name" autocomplete="name" required></label>' +
                '<label>연락처 <input type="tel" name="phone" autocomplete="tel" required></label>' +
                '<label>이메일 <input type="email" name="email" autocomplete="email"></label>' +
              '</div>' +
              '<label>배송/설치 장소 <input type="text" name="location" placeholder="예: 광주광역시 ○○구"></label>' +
              '<label>요청 사항 <textarea name="note" rows="4" placeholder="설치 환경, 일정, 수량 등을 입력하세요."></textarea></label>' +
              '<button type="submit" class="btn btn-primary btn-block">견적 요청 보내기</button>' +
              '<p class="form-note">입력하신 정보는 견적 응대 목적으로만 사용됩니다.</p>' +
              '<div id="quoteCartResult" class="quote-result" role="status"></div>' +
            '</form>' +
          '</div>' +
        '</aside>' +
      '</div>' +
      '<a class="back-link" href="#/products">← 상품 더 보기</a>';

    bindServiceInputs('cart');
    var form = document.getElementById('quoteCartForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitQuoteCart(form, items);
      });
    }
  }

  function submitQuoteCart(form, items) {
    var data = new FormData(form);
    var request = {
      id: 'Q-' + Date.now(),
      createdAt: new Date().toISOString(),
      company: data.get('company') || '',
      name: data.get('name') || '',
      phone: data.get('phone') || '',
      email: data.get('email') || '',
      location: data.get('location') || '',
      note: data.get('note') || '',
      services: (state.quoteCartServices || []).slice(),
      items: items.map(function (x) {
        var p = x.product;
        var price = fmtPrice(p);
        return {
          id: p.id,
          name: p.name,
          brand: displayBrand(p),
          category: p._cat,
          qty: x.cart.qty,
          publicPrice: price.inquiry ? null : price.text
        };
      })
    };
    window.cgiLastQuoteCartRequest = request;
    var result = document.getElementById('quoteCartResult');
    var submit = form.querySelector('button[type="submit"]');
    var apiUrl = (window.CGI_SITE_CONFIG && window.CGI_SITE_CONFIG.quoteApiUrl) || '';
    var done = function (message, cls) {
      if (result) result.innerHTML = '<p class="' + (cls || 'result-ok') + '">' + message + '</p>';
    };
    var setBusy = function (busy) {
      if (!submit) return;
      submit.disabled = busy;
      submit.textContent = busy ? '접수 중…' : '견적 요청 보내기';
    };

    if (apiUrl) {
      setBusy(true);
      fetch(apiUrl + '/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (response) {
        request.id = response.id || request.id;
        window.cgiLastQuoteCartRequest = request;
        done('견적 요청이 접수되었습니다. 접수번호: <strong>' + esc(request.id) + '</strong>');
      }).catch(function (err) {
        try {
          var list = JSON.parse(localStorage.getItem('cgiQuoteRequests') || '[]');
          list.unshift(request);
          localStorage.setItem('cgiQuoteRequests', JSON.stringify(list));
        } catch (e) {}
        done('서버 접수에 실패해 이 브라우저에 임시 저장했습니다. 담당자에게 직접 전달해 주세요. (' + esc(err.message) + ')', 'result-warn');
      }).then(function () {
        setBusy(false);
      });
    } else {
      try {
        var list = JSON.parse(localStorage.getItem('cgiQuoteRequests') || '[]');
        list.unshift(request);
        localStorage.setItem('cgiQuoteRequests', JSON.stringify(list));
      } catch (e) {}
      done('견적 요청이 저장되었습니다. 요약을 복사해 담당자에게 전달해 주세요.');
    }

    var pre = document.getElementById('quoteCartText');
    if (pre) pre.textContent = buildQuoteCartText(items, request);
    window.cgiLastQuoteCartText = buildQuoteCartText(items, request);
  }

  function serviceName(id) {
    var services = window.CGI_SERVICES || [];
    for (var i = 0; i < services.length; i++) {
      if (services[i].id === id) return services[i].name;
    }
    return id;
  }

  function buildQuoteCartText(items, request) {
    var lines = [];
    lines.push('[CGI 견적 요청]');
    if (request) {
      lines.push('요청번호: ' + request.id);
      lines.push('요청일시: ' + new Date(request.createdAt).toLocaleString('ko-KR'));
      lines.push('회사/기관: ' + request.company);
      lines.push('담당자: ' + request.name);
      lines.push('연락처: ' + request.phone);
      lines.push('이메일: ' + request.email);
      lines.push('배송/설치 장소: ' + request.location);
      lines.push('요청 사항: ' + request.note);
      lines.push('추가 서비스: ' + ((request.services || []).map(serviceName).join(', ') || '없음'));
    }
    lines.push('');
    lines.push('상품 목록:');
    items.forEach(function (x, idx) {
      var p = x.product;
      lines.push((idx + 1) + '. ' + p.name + ' | ' + displayBrand(p) + ' | ' + p._cat +
        ' | 수량 ' + x.cart.qty + ' | 공개가 ' + priceText(p));
    });
    lines.push('');
    lines.push('※ 공개 판매가는 참고 정보이며, 최종 금액은 CGI 담당자가 확인 후 안내합니다.');
    return lines.join('\n');
  }

  /* --------------------------------------------------------------- about */
  function renderAbout() {
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><span>이용 안내</span></div>' +
      '<header class="page-head">' +
        '<p class="page-eyebrow">Guide</p>' +
        '<h1>이용 안내</h1>' +
        '<p class="page-sub">상품 확인부터 견적 요청까지 안내드립니다.</p>' +
      '</header>' +
      '<div class="about-card">' +
        '<h2>CGI 상품 카탈로그</h2>' +
        '<p>㈜시지아이가 취급하는 음향·영상·조명 장비를 한곳에서 살펴보는 B2B 카탈로그입니다. 브랜드·카테고리로 상품을 찾고, 필요한 상품을 견적 목록에 담아 한 번에 요청할 수 있습니다.</p>' +
        '<h2>가격과 재고</h2>' +
        '<ul>' +
          '<li>공개 판매가는 공급처 공개 정보를 기준으로 표시하며, 실제 판매가와 다를 수 있습니다.</li>' +
          '<li>가격이 공개되지 않은 상품은 추정하지 않고 <strong>가격 문의</strong>로 표시합니다.</li>' +
          '<li>재고·배송 일정은 실시간 정보가 아니며, 담당자 확인 후 안내합니다.</li>' +
        '</ul>' +
        '<h2>견적 요청 방법</h2>' +
        '<ul>' +
          '<li>상품 상세에서 수량과 추가 서비스를 확인한 뒤 <strong>견적 요청하기</strong>를 선택합니다.</li>' +
          '<li>견적 목록에서 회사·담당자 정보를 입력하고 요청을 보냅니다.</li>' +
          '<li>담당자가 내용을 확인한 뒤 연락드립니다.</li>' +
        '</ul>' +
        '<h2>문의</h2>' +
        '<dl class="about-contact">' +
          '<div><dt>전화</dt><dd><a href="tel:0625768100">062) 576-8100</a></dd></div>' +
          '<div><dt>팩스</dt><dd>062) 576-8181</dd></div>' +
          '<div><dt>주소</dt><dd>광주광역시 광산구 하남산단천변좌로 19, 광주드림파크 111호</dd></div>' +
          '<div><dt>회사</dt><dd>주식회사 시지아이 (CGI Inc.)</dd></div>' +
        '</dl>' +
        '<div class="about-actions">' +
          '<a class="btn btn-primary" href="#/products">상품 보기</a>' +
          '<a class="btn btn-secondary" href="../website/index.html" data-home-link>회사 홈페이지</a>' +
        '</div>' +
      '</div>';
  }

  /* --------------------------------------------------------------- router */
  function parseHash() {
    var hash = location.hash || '#/';
    var raw = hash.replace(/^#/, '');
    var query = '';
    var qIndex = raw.indexOf('?');
    if (qIndex !== -1) { query = raw.slice(qIndex + 1); raw = raw.slice(0, qIndex); }
    var params = new URLSearchParams(query);
    var parts = raw.split('/').filter(Boolean);
    var route = { view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'recent', page: 1, id: null };
    if (parts[0] === 'products') {
      route.view = 'list';
      route.q = params.get('q') || '';
      route.brands = (params.get('brand') || '').split('|').filter(Boolean);
      route.cats = (params.get('cat') || '').split('|').filter(Boolean);
      route.sites = (params.get('site') || '').split('|').filter(Boolean);
      route.sort = params.get('sort') || 'recent';
      route.page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
    } else if (parts[0] === 'product' && parts[1]) {
      route.view = 'detail';
      route.id = decodeURIComponent(parts[1]);
    } else if (parts[0] === 'quote' && parts[1]) {
      route.view = 'quote';
      route.id = decodeURIComponent(parts[1]);
      route.services = (params.get('services') || '').split('|').filter(Boolean);
    } else if (parts[0] === 'quote-cart') {
      route.view = 'quote-cart';
    } else if (parts[0] === 'about') {
      route.view = 'about';
    }
    return route;
  }

  function updateHeader() {
    var view = state.route.view;
    var links = document.querySelectorAll('.header-nav a[data-nav]');
    for (var i = 0; i < links.length; i++) {
      var nav = links[i].getAttribute('data-nav');
      var active = nav === view ||
        (view === 'detail' && nav === 'list') ||
        (view === 'quote' && nav === 'quote');
      links[i].classList.toggle('is-active', active);
      if (active) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }
    var search = document.getElementById('headerSearch');
    if (search) search.value = view === 'list' ? state.route.q : '';
  }

  function updateTitle() {
    var view = state.route.view;
    var title = 'CGI 상품 카탈로그 | (주)시지아이';
    if (view === 'list') title = (state.route.q ? '상품 검색' : '전체 상품') + ' | CGI 상품 카탈로그';
    else if (view === 'detail') {
      var p = findProduct(state.route.id);
      title = (p ? p.name : '상품') + ' | CGI 상품 카탈로그';
    } else if (view === 'quote-cart') title = '견적 목록 | CGI';
    else if (view === 'quote') title = '견적 요청 | CGI';
    else if (view === 'about') title = '이용 안내 | CGI';
    document.title = title;
  }

  function render() {
    state.route = parseHash();
    applySiteConfig();
    updateHeader();
    if (state.route.view === 'home') renderHome();
    else if (state.route.view === 'list') renderList();
    else if (state.route.view === 'detail') renderDetail(state.route.id);
    else if (state.route.view === 'quote') renderQuote(state.route.id, state.route.services || []);
    else if (state.route.view === 'quote-cart') renderQuoteCart();
    else renderAbout();
    updateTitle();
    document.body.setAttribute('data-view', state.route.view);
    if (lastView !== state.route.view) {
      window.scrollTo(0, 0);
      lastView = state.route.view;
    }
  }

  /* ------------------------------------------- 쇼핑몰 ↔ 홈페이지 연결 설정 */
  function applySiteConfig() {
    var cfg = window.CGI_SITE_CONFIG || {};
    if (!cfg.homepageUrl) return;
    var links = document.querySelectorAll('[data-home-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', cfg.homepageUrl);
    }
  }

  /* --------------------------------------------------------------- events */
  function navigate(url) { location.hash = url.replace(/^#/, ''); }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form.id === 'searchForm') {
      event.preventDefault();
      var q = (form.elements.q && form.elements.q.value || '').trim();
      navigate('#/products' + (q ? '?q=' + encodeURIComponent(q) : ''));
    } else if (form.getAttribute('data-action') === 'hero-search') {
      event.preventDefault();
      var value = (form.elements.q && form.elements.q.value || '').trim();
      navigate('#/products' + (value ? '?q=' + encodeURIComponent(value) : ''));
    }
  });

  document.addEventListener('click', function (event) {
    var target = event.target.closest
      ? event.target.closest('[data-action], [data-page], [data-remove], [data-gallery-index], [data-remove-id], [data-qty-step]')
      : null;
    if (!target) return;

    if (target.hasAttribute('data-qty-step')) {
      var row = target.closest('[data-cart-id]');
      if (!row) return;
      var input = row.querySelector('input[data-qty-id]');
      var id = row.getAttribute('data-cart-id');
      var current = parseInt(input && input.value, 10) || 1;
      var next = Math.max(1, current + Number(target.getAttribute('data-qty-step')));
      if (input) input.value = next;
      updateQuoteCartQty(id, next);
      refreshCartPreview();
      return;
    }

    if (target.hasAttribute('data-remove-id')) {
      removeFromQuoteCart(target.getAttribute('data-remove-id'));
      renderQuoteCart();
      return;
    }

    if (target.hasAttribute('data-action')) {
      var action = target.getAttribute('data-action');
      if (action === 'reset-filters') {
        navigate('#/products');
        return;
      }
      if (action === 'toggle-filters') {
        var panel = document.getElementById('filterPanel');
        if (panel) {
          var hidden = panel.hasAttribute('hidden');
          if (hidden) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', '');
          target.setAttribute('aria-expanded', hidden ? 'true' : 'false');
          target.textContent = hidden ? '필터 닫기' : '필터 열기';
        }
        return;
      }
      var productId = target.getAttribute('data-product-id');
      if (action === 'add-to-cart' && productId) {
        addToQuoteCart(productId, 1);
        return;
      }
      if (action === 'quote-now' && productId) {
        addToQuoteCart(productId, 1, true);
        state.quoteCartServices = (state.quoteServices || []).slice();
        saveQuoteCartServices();
        navigate('#/quote-cart');
        return;
      }
      if (action === 'copy-cart') { window.cgiCopyQuoteCart(); return; }
      if (action === 'download-json') { window.cgiDownloadQuoteCart(); return; }
      if (action === 'download-csv') { window.cgiDownloadQuoteCartCsv(); return; }
      if (action === 'copy-quote') { window.cgiCopyQuote(); return; }
    }

    if (target.hasAttribute('data-page')) {
      var page = target.getAttribute('data-page');
      var params = new URLSearchParams();
      var r = state.route;
      if (r.q) params.set('q', r.q);
      if (r.brands.length) params.set('brand', r.brands.join('|'));
      if (r.cats.length) params.set('cat', r.cats.join('|'));
      if (r.sites.length) params.set('site', r.sites.join('|'));
      if (r.sort && r.sort !== 'recent') params.set('sort', r.sort);
      params.set('page', page);
      navigate('#/products?' + params.toString());
      return;
    }

    if (target.hasAttribute('data-remove')) {
      var kind = target.getAttribute('data-remove');
      var value = target.getAttribute('data-value');
      var nextRoute = Object.assign({}, state.route);
      if (kind === 'q') nextRoute.q = '';
      else nextRoute[kind] = nextRoute[kind].filter(function (v) { return v !== value; });
      nextRoute.page = 1;
      var q = nextRoute.q ? '?q=' + encodeURIComponent(nextRoute.q) : '';
      var extra = [];
      if (nextRoute.brands.length) extra.push('brand=' + encodeURIComponent(nextRoute.brands.join('|')));
      if (nextRoute.cats.length) extra.push('cat=' + encodeURIComponent(nextRoute.cats.join('|')));
      if (nextRoute.sites.length) extra.push('site=' + encodeURIComponent(nextRoute.sites.join('|')));
      navigate('#/products' + q + (extra.length ? (q ? '&' : '?') + extra.join('&') : ''));
      return;
    }

    if (target.hasAttribute('data-gallery-index')) {
      var idx = parseInt(target.getAttribute('data-gallery-index'), 10);
      var product = findProduct(state.route.id);
      if (!product || !product.images[idx]) return;
      var main = document.getElementById('galleryMain');
      if (main) {
        main.src = product.images[idx];
        main.setAttribute('data-img-url', product.images[idx]);
        main.alt = product.name + ' 이미지 ' + (idx + 1);
      }
      var thumbs = document.querySelectorAll('.gallery-thumbs button');
      for (var t = 0; t < thumbs.length; t++) {
        thumbs[t].classList.toggle('is-active', t === idx);
      }
    }
  });

  document.addEventListener('change', function (event) {
    var el = event.target;
    if (el.id === 'sortSelect') {
      var params = new URLSearchParams();
      var r = state.route;
      if (r.q) params.set('q', r.q);
      if (r.brands.length) params.set('brand', r.brands.join('|'));
      if (r.cats.length) params.set('cat', r.cats.join('|'));
      if (r.sites.length) params.set('site', r.sites.join('|'));
      if (el.value && el.value !== 'recent') params.set('sort', el.value);
      navigate('#/products' + (params.toString() ? '?' + params.toString() : ''));
      return;
    }
    if (el.getAttribute && el.getAttribute('data-facet')) {
      var facetKey = { brand: 'brands', cat: 'cats', site: 'sites' };
      var facet = el.getAttribute('data-facet');
      var field = facetKey[facet] || facet;
      var next = Object.assign({}, state.route);
      next[field] = (next[field] || []).slice();
      var idx = next[field].indexOf(el.value);
      if (el.checked) { if (idx === -1) next[field].push(el.value); }
      else if (idx !== -1) { next[field].splice(idx, 1); }
      next.page = 1;
      var p2 = new URLSearchParams();
      if (next.q) p2.set('q', next.q);
      if (next.brands.length) p2.set('brand', next.brands.join('|'));
      if (next.cats.length) p2.set('cat', next.cats.join('|'));
      if (next.sites.length) p2.set('site', next.sites.join('|'));
      if (next.sort && next.sort !== 'recent') p2.set('sort', next.sort);
      navigate('#/products' + (p2.toString() ? '?' + p2.toString() : ''));
      return;
    }
    if (el.getAttribute && el.hasAttribute('data-qty-id')) {
      var value = updateQuoteCartQty(el.getAttribute('data-qty-id'), el.value);
      el.value = value;
      refreshCartPreview();
    }
  });

  document.addEventListener('input', function (event) {
    var el = event.target;
    if (!el.getAttribute || !el.getAttribute('data-facet-search')) return;
    var group = el.closest('.filter-group');
    if (!group) return;
    var q = el.value.trim().toLowerCase();
    Array.prototype.forEach.call(group.querySelectorAll('.filter-list label'), function (label) {
      label.hidden = !!q && (label.textContent || '').toLowerCase().indexOf(q) === -1;
    });
  });

  function refreshCartPreview() {
    var items = cartItems();
    var text = buildQuoteCartText(items);
    var pre = document.getElementById('quoteCartText');
    if (pre) pre.textContent = text;
    window.cgiLastQuoteCartText = text;
  }

  /* ---------------------------------------------------- image error fallback */
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    var src = decodeUrl(img.getAttribute('src') || img.currentSrc || '');
    if (!src) return;
    var abs = absoluteUrl(src);
    state.failedImages[abs] = true;

    if (img.classList.contains('card-img')) {
      var card = img.closest('[data-product-id]');
      if (card) {
        var p = findProduct(card.getAttribute('data-product-id'));
        if (p) p.images = p.images.filter(function (u) { return absoluteUrl(u) !== abs; });
      }
      img.outerHTML = fallbackBlock('card-img');
      return;
    }
    if (img.classList.contains('cart-img')) {
      img.outerHTML = fallbackBlock('cart-img');
      return;
    }
    if (img.id === 'galleryMain') {
      advanceGallery(abs);
      return;
    }
    if (img.closest('.gallery-thumbs')) {
      var btn = img.closest('button');
      if (btn) btn.hidden = true;
    }
  }, true);

  function advanceGallery(failedAbs) {
    var product = findProduct(state.route.id);
    if (!product) return;
    product.images = product.images.filter(function (u) { return absoluteUrl(u) !== failedAbs; });
    var thumbs = document.querySelectorAll('.gallery-thumbs button');
    for (var i = 0; i < thumbs.length; i++) {
      if (absoluteUrl(decodeUrl(thumbs[i].getAttribute('data-img-url'))) === failedAbs) thumbs[i].hidden = true;
    }
    var main = document.getElementById('galleryMain');
    if (!main) return;
    if (product.images.length) {
      main.src = product.images[0];
      main.setAttribute('data-img-url', product.images[0]);
      main.alt = product.name;
      for (var j = 0; j < thumbs.length; j++) {
        thumbs[j].classList.toggle('is-active',
          !thumbs[j].hidden && absoluteUrl(decodeUrl(thumbs[j].getAttribute('data-img-url'))) === absoluteUrl(product.images[0]));
      }
    } else {
      main.outerHTML = fallbackBlock('gallery-no-image');
    }
  }

  /* ------------------------------------------------------------ public API */
  window.cgiToggleService = function (id, checked) {
    state.quoteServices = state.quoteServices || [];
    var idx = state.quoteServices.indexOf(id);
    if (checked && idx === -1) state.quoteServices.push(id);
    if (!checked && idx !== -1) state.quoteServices.splice(idx, 1);
  };

  window.cgiToggleQuoteService = function (id, checked) {
    state.quoteCartServices = state.quoteCartServices || [];
    var idx = state.quoteCartServices.indexOf(id);
    if (checked && idx === -1) state.quoteCartServices.push(id);
    if (!checked && idx !== -1) state.quoteCartServices.splice(idx, 1);
    saveQuoteCartServices();
  };

  window.cgiRequestQuote = function (productId) {
    var services = state.quoteServices || [];
    location.hash = '#/quote/' + encodeURIComponent(productId) + (services.length ? '?services=' + encodeURIComponent(services.join('|')) : '');
  };

  window.cgiAddToQuoteCart = function (productId) {
    addToQuoteCart(productId, 1);
  };

  window.cgiRequestQuoteToCart = function (productId) {
    addToQuoteCart(productId, 1, true);
    state.quoteCartServices = (state.quoteServices || []).slice();
    saveQuoteCartServices();
    navigate('#/quote-cart');
  };

  window.cgiCopyQuote = function () {
    var text = window.cgiLastQuote || '';
    copyText(text, '견적 요약을 복사했습니다.');
  };

  window.cgiCopyQuoteCart = function () {
    var text = window.cgiLastQuoteCartText || '';
    copyText(text, '견적 요약을 복사했습니다.');
  };

  function copyText(text, message) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(message);
      }).catch(function () { showToast('복사하지 못했습니다.'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast(message); }
      catch (e) { showToast('복사하지 못했습니다.'); }
      document.body.removeChild(ta);
    }
  }

  window.cgiDownloadQuoteCart = function () {
    var request = window.cgiLastQuoteCartRequest;
    if (!request) {
      showToast('먼저 견적 요청을 보내주세요.');
      return;
    }
    var blob = new Blob([JSON.stringify(request, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = request.id + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  window.cgiDownloadQuoteCartCsv = function () {
    var request = window.cgiLastQuoteCartRequest;
    if (!request) {
      showToast('먼저 견적 요청을 보내주세요.');
      return;
    }
    var lines = [];
    lines.push('요청번호,요청일시,회사,담당자,연락처,이메일,장소,서비스,상품명,브랜드,카테고리,수량,공개가');
    request.items.forEach(function (it) {
      lines.push([request.id, request.createdAt, request.company, request.name, request.phone, request.email,
        request.location, (request.services || []).map(serviceName).join('|'), it.name, it.brand, it.category, it.qty, it.publicPrice || '']
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = request.id + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  window.addEventListener('hashchange', render);

  /* ----------------------------------------------------------------- boot */
  loadProducts().then(function () {
    loadQuoteCart();
    loadQuoteCartServices();
    if (loadingBox && loadingBox.parentNode) loadingBox.parentNode.removeChild(loadingBox);
    render();
    document.body.setAttribute('data-cgi-ready', '1');
  }).catch(function (error) {
    if (loadingBox) loadingBox.textContent = '상품 데이터를 불러오지 못했습니다: ' + error.message;
    document.body.setAttribute('data-cgi-ready', 'error');
  });
})();
