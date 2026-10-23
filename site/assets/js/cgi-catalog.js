/* ==========================================================================
   CGI 상품 카탈로그 — 프런트엔드 로더 (이슈 #11)
   - 정적 HTML/CSS/JS만으로 동작 (빌드 스텝 없음)
   - 데이터: window.CGI_PRODUCTS (data/products.js) 또는 ?data=<경로>.json 으로 교체
   - 라우팅: #/ , #/products?... , #/product/<id> , #/about
   ========================================================================== */
(function () {
  'use strict';

  var PER_PAGE = 12;
  var app = document.getElementById('app');
  var loadingBox = document.getElementById('loadingBox');

  var state = {
    products: [],
    meta: { product_count: 0, brands: [], sources: [], supplier_catalog_totals: {}, data_origin: [] },
    route: { view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'recent', page: 1, id: null },
    quoteCart: [],
    quoteServices: []
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
  function fmtPrice(product) {
    if (!product.price) return { text: '가격 미확인', inquiry: true, cls: 'inquiry' };
    if (product.price.state === 'public' && product.price.value !== null) {
      return { text: product.price.value.toLocaleString('ko-KR') + '원', inquiry: false, cls: '' };
    }
    if (product.price.state === 'inquiry') return { text: '가격 문의', inquiry: true, cls: 'inquiry' };
    return { text: '가격 미확인', inquiry: true, cls: 'inquiry' };
  }
  function displayBrand(product) {
    return product.brand_norm || product.source.site_label || '브랜드 미확인';
  }
  function categoryLabel(product) {
    if (product.category && product.category.name) return product.category.name;
    if (product.category_path && product.category_path.length) return product.category_path[product.category_path.length - 1];
    return '미분류';
  }
  function siteLabel(product) { return product.source.site_label || product.source.site; }
  function productUrl(id) { return '#/product/' + encodeURIComponent(id); }
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
      if (!map[key]) map[key] = 0;
      map[key] += 1;
    });
    return map;
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
    p.images = (p.images || []).filter(Boolean);
    p._search = norm([p.name, p.model, p.brand, p.brand_raw, p.manufacturer, categoryLabel(p),
      (p.category_path || []).join(' '), (p.specs || []).map(function (s) { return s.label + ' ' + s.value; }).join(' ')].join(' '));
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
        if (av === null) return 1;   // 가격 미확인은 항상 뒤로
        if (bv === null) return -1;
        return sort === 'price_asc' ? av - bv : bv - av;
      }
      if (sort === 'name') return a.name.localeCompare(b.name, 'ko');
      var at = a.source.updated_at || '';
      var bt = b.source.updated_at || '';
      if (at === bt) return a.name.localeCompare(b.name, 'ko');
      return at < bt ? 1 : -1;
    });
    return list;
  }

  /* ------------------------------------------------------------- fragments */
  function imageHtml(product, className) {
    if (!product.images.length) {
      return '<div class="' + className + ' no-image">이미지 없음</div>';
    }
    var src = product.images[0];
    return '<img class="' + className + '" src="' + esc(src) + '" alt="' + esc(product.name) + '" loading="lazy" ' +
      'onerror="this.outerHTML=\'&lt;div class=&quot;' + className + ' no-image&quot;&gt;이미지 없음&lt;/div&gt;\'">';
  }

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
        '<h3>검색 결과가 없습니다</h3>' +
        '<p>검색어 또는 필터 조건을 바꿔 다시 시도해 주세요.</p>' +
        '<button class="btn-search" data-action="reset-filters">필터 초기화</button>' +
      '</div>';
    }
    return '<div class="product-grid">' + list.map(cardHtml).join('') + '</div>';
  }

  function facetBlock(title, name, values, counts, selected) {
    if (!values.length) return '';
    var rows = values.map(function (value) {
      var id = 'f-' + name + '-' + values.indexOf(value);
      var checked = selected.indexOf(value) !== -1 ? ' checked' : '';
      return '<label for="' + id + '"><input type="checkbox" id="' + id + '" data-facet="' + name + '" value="' + esc(value) + '"' + checked + '>' +
        '<span>' + esc(value) + '</span><span class="cnt">' + (counts[value] || 0) + '</span></label>';
    }).join('');
    return '<div class="filter-group"><h3>' + title + '</h3><div class="filter-list">' + rows + '</div></div>';
  }

  /* --------------------------------------------------------------- views */
  function renderHome() {
    var total = state.products.length;
    var brands = Object.keys(countBy(state.products, function (p) { return p._brand; })).sort();
    var cats = Object.keys(countBy(state.products, function (p) { return p._cat; })).sort();
    var priced = state.products.filter(function (p) { return p.price && p.price.state === 'public'; }).length;
    var inquiry = total - priced;
    var totals = state.meta.supplier_catalog_totals || {};
    var totalKeys = Object.keys(totals);
    var totalLine = totalKeys.map(function (site) {
      var label = (state.meta.source_labels && state.meta.source_labels[site]) || site;
      var entry = totals[site];
      var count = (entry && typeof entry === 'object') ? entry.count : entry;
      return label + ' ' + Number(count).toLocaleString('ko-KR') + '건';
    }).join(' · ');

    var recent = state.products.slice().sort(function (a, b) {
      return (a.source.updated_at || '') < (b.source.updated_at || '') ? 1 : -1;
    }).slice(0, 8);

    app.innerHTML =
      '<section class="hero">' +
        '<h1>CGI 상품 카탈로그</h1>' +
        '<p>공급처 공개 페이지에서 수집한 공개 정보로 구성한 상품 카탈로그입니다. 브랜드·카테고리로 찾고, 원본 상품 페이지로 바로 이동할 수 있습니다.</p>' +
        '<form class="hero-search" data-action="hero-search">' +
          '<input type="search" name="q" placeholder="상품명·모델명·브랜드 검색" aria-label="상품 검색" value="' + esc(state.route.q) + '">' +
          '<button type="submit">검색</button>' +
        '</form>' +
      '</section>' +

      '<dl class="stat-row">' +
        '<div class="stat-card"><dt>표시 중인 상품</dt><dd>' + total + '<small>공급처 공개 수집 기준</small></dd></div>' +
        '<div class="stat-card"><dt>브랜드</dt><dd>' + brands.length + '<small>표시 가능한 브랜드</small></dd></div>' +
        '<div class="stat-card"><dt>공개 판매가</dt><dd>' + priced + '<small>가격 미공개 ' + inquiry + '건은 가격 문의</small></dd></div>' +
        '<div class="stat-card"><dt>공급처 카탈로그 규모</dt><dd>' + totalKeys.length + '곳<small>' + esc(totalLine || '확인 중') + ' · 공급처 전체 규모이며 CGI 판매 가능 수량 아님</small></dd></div>' +
      '</dl>' +

      '<section class="section">' +
        '<div class="section-head"><h2>브랜드로 찾기</h2><a class="more" href="#/products">전체 상품 보기 →</a></div>' +
        '<div class="chip-row">' + brands.map(function (b) {
          return '<a class="chip" href="' + esc(listUrl({ brands: [b], cats: [], sites: [], q: '' })) + '">' + esc(b) + '</a>';
        }).join('') + '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>카테고리로 찾기</h2></div>' +
        '<div class="chip-row">' + cats.map(function (c) {
          return '<a class="chip" href="' + esc(listUrl({ cats: [c], brands: [], sites: [], q: '' })) + '">' + esc(c) + '</a>';
        }).join('') + '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>최근 수집 상품</h2><a class="more" href="#/products">더 보기 →</a></div>' +
        gridHtml(recent) +
      '</section>';
  }

  function renderList() {
    var r = state.route;
    var list = filteredProducts();
    var brandCounts = countBy(state.products, function (p) { return p._brand; });
    var catCounts = countBy(state.products, function (p) { return p._cat; });
    var siteCounts = countBy(state.products, function (p) { return p.source.site; });
    var brandValues = Object.keys(brandCounts).sort();
    var catValues = Object.keys(catCounts).sort();
    var siteValues = Object.keys(siteCounts).sort();

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (r.page > pages) r.page = pages;
    var start = (r.page - 1) * PER_PAGE;
    var pageItems = list.slice(start, start + PER_PAGE);

    var activeChips = [];
    r.brands.forEach(function (b) { activeChips.push({ kind: 'brands', value: b, label: '브랜드: ' + b }); });
    r.cats.forEach(function (c) { activeChips.push({ kind: 'cats', value: c, label: '카테고리: ' + c }); });
    r.sites.forEach(function (s) {
      var label = (state.meta.source_labels && state.meta.source_labels[s]) || s;
      activeChips.push({ kind: 'sites', value: s, label: '출처: ' + label });
    });
    if (r.q) activeChips.push({ kind: 'q', value: '', label: '검색: ' + r.q });

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a> › 상품 목록</div>' +
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
            '<span class="result-count"><b>' + list.length + '</b>건 표시' + (r.q ? ' · 검색어 “' + esc(r.q) + '”' : '') + '</span>' +
            '<select class="sort-select" id="sortSelect" aria-label="정렬">' +
              '<option value="recent"' + (r.sort === 'recent' ? ' selected' : '') + '>최신 수집순</option>' +
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

    // 모바일에서는 필터를 접힌 상태로 시작한다
    if (window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
      var panel = document.getElementById('filterPanel');
      var toggle = document.querySelector('[data-action="toggle-filters"]');
      if (panel && !panel.hasAttribute('hidden')) panel.setAttribute('hidden', '');
      if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '필터 열기'; }
    }
  }

  function paginationHtml(current, total) {
    if (total <= 1) return '';
    var items = [];
    var prev = '<button data-page="' + (current - 1) + '"' + (current === 1 ? ' disabled' : '') + '>이전</button>';
    var next = '<button data-page="' + (current + 1) + '"' + (current === total ? ' disabled' : '') + '>다음</button>';
    items.push(prev);
    var start = Math.max(1, current - 2);
    var end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    for (var i = start; i <= end; i++) {
      items.push('<button data-page="' + i + '" class="' + (i === current ? 'is-current' : '') + '" aria-current="' + (i === current ? 'page' : 'false') + '">' + i + '</button>');
    }
    items.push(next);
    return '<nav class="pagination" aria-label="페이지네이션">' + items.join('') + '</nav>';
  }

  function renderDetail(id) {
    state.quoteServices = [];
    var product = null;
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) { product = state.products[i]; break; }
    }
    if (!product) {
      app.innerHTML = '<div class="empty-state"><h3>상품을 찾을 수 없습니다</h3>' +
        '<p>삭제되었거나 주소가 잘못된 상품입니다.</p><a class="btn-search" href="#/products">목록으로 돌아가기</a></div>';
      return;
    }
    var price = fmtPrice(product);
    var specRows = (product.specs || []).filter(function (s) { return s.label && s.value; });
    var thumbs = product.images.map(function (img, idx) {
      return '<button class="' + (idx === 0 ? 'is-active' : '') + '" data-gallery-index="' + idx + '" aria-label="이미지 ' + (idx + 1) + '">' +
        '<img src="' + esc(img) + '" alt="' + esc(product.name) + ' 이미지 ' + (idx + 1) + '" onerror="this.style.visibility=\'hidden\'"></button>';
    }).join('');
    var mainImg = product.images.length
      ? '<img id="galleryMain" src="' + esc(product.images[0]) + '" alt="' + esc(product.name) + '" onerror="this.outerHTML=\'&lt;div class=&quot;no-image&quot;&gt;이미지 없음&lt;/div&gt;\'">'
      : '<div class="no-image">이미지 없음</div>';

    var optionsHtml = '';
    if (product.options && product.options.length) {
      optionsHtml = '<div class="detail-block"><h3>옵션 정보</h3><table class="spec-table"><tbody>' +
        product.options.map(function (opt) {
          return '<tr><th>' + esc(opt.name) + '</th><td>' + esc(opt.price_text) +
            (opt.availability ? ' · ' + esc(opt.availability) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a> › <a href="' + esc(listUrl({ q: '', brands: [], cats: [], sites: [] })) + '">상품 목록</a> › ' + esc(product.name) +
        ' &nbsp;<a class="home-link" href="../website/index.html" data-home-link>← 회사 홈페이지</a></div>' +
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
              ? '공급처에 공개된 판매가가 없어 문의로 표기합니다.'
              : '공급처 공개 판매가 기준 · 변동될 수 있음') + '</span>' +
          '</div>' +
          (specRows.length ? '<table class="spec-table"><tbody>' + specRows.map(function (s) {
            return '<tr><th>' + esc(s.label) + '</th><td>' + esc(s.value) + '</td></tr>';
          }).join('') + '</tbody></table>' : '') +
          optionsHtml +
          '<div class="detail-block"><h3>서비스 선택 (견적 요청)</h3>' +
            '<p class="detail-price-note">고객 확정 전 금액은 표시하지 않습니다. 필요한 서비스를 선택한 뒤 견적을 요청하세요.</p>' +
            '<div class="service-checks">' +
              (window.CGI_SERVICES || []).map(function (svc) {
                return '<label class="service-check"><input type="checkbox" value="' + esc(svc.id) + '" onchange="window.cgiToggleService(\'' + esc(svc.id) + '\', this.checked)"> ' +
                  '<strong>' + esc(svc.name) + '</strong><br><span>' + esc(svc.description) + '</span></label>';
              }).join('') +
            '</div>' +
            '<button type="button" class="btn-search" onclick="window.cgiAddToQuoteCart(\'' + esc(product.id) + '\')">견적 목록에 추가</button> ' +
            '<button type="button" class="btn-search" onclick="window.cgiRequestQuote(\'' + esc(product.id) + '\')">단일 견적 요청</button>' +
            '<div id="quoteResult" class="quote-result"></div>' +
          '</div>' +
          optionsHtml +
          '<div class="detail-block"><h3>원본 상품 정보 출처</h3><div class="source-box"><dl>' +
            '<dt>공급처</dt><dd>' + esc(siteLabel(product)) + ' (' + esc(product.source.site) + ')</dd>' +
            '<dt>원본 상품 ID</dt><dd>' + esc(product.source.product_id) + '</dd>' +
            '<dt>원본 페이지</dt><dd><a href="' + esc(product.source.url) + '" target="_blank" rel="noopener noreferrer">' + esc(product.source.url) + '</a></dd>' +
            (product.source.list_url ? '<dt>목록 페이지</dt><dd><a href="' + esc(product.source.list_url) + '" target="_blank" rel="noopener noreferrer">' + esc(product.source.list_url) + '</a></dd>' : '') +
            '<dt>수집 방법</dt><dd>' + esc(product.source.extraction_method || '확인 필요') + '</dd>' +
            '<dt>검증 상태</dt><dd>' + esc(product.source.verification_status || '확인 필요') + '</dd>' +
            '<dt>수집 시각</dt><dd>' + esc(product.source.updated_at || '확인 필요') + '</dd>' +
            '<dt>카테고리</dt><dd>' + esc(product.category.path || product._cat) + (product.category.registered_count ? ' (공급처 등록 ' + product.category.registered_count.toLocaleString('ko-KR') + '건)' : '') + '</dd>' +
          '</dl></div></div>' +
          '<a class="back-link" href="' + esc(listUrl({})) + '">← 목록으로 돌아가기</a>' +
        '</div>' +
      '</div>';
  }


  function renderQuote(id, serviceIds) {
    var product = null;
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) { product = state.products[i]; break; }
    }
    if (!product) {
      app.innerHTML = '<div class="empty-state"><h3>?�품??찾을 ???�습?�다</h3></div>';
      return;
    }
    var services = (window.CGI_SERVICES || []).filter(function (svc) {
      return serviceIds.indexOf(svc.id) !== -1;
    });
    if (!services.length) services = window.CGI_SERVICES || [];
    var serviceNames = services.map(function (s) { return s.name; }).join(', ');
    var quoteText =
      '[CGI 견적 요청]\n' +
      '상품: ' + product.name + ' (' + product.id + ')\n' +
      '브랜드: ' + (product.brand_norm || product.brand) + '\n' +
      '모델: ' + (product.model || '-') + '\n' +
      '카테고리: ' + (product._cat || '-') + '\n' +
      '공개 판매가: ' + (product.price && product.price.inquiry ? '가격 문의' : (product.price ? product.price.text : '-')) + '\n' +
      '요청 서비스: ' + serviceNames + '\n' +
      '공급처 원본: ' + (product.source ? product.source.url : '-') + '\n' +
      '※ 금액은 고객 확정 전 미표시. CGI 확인 후 안내.';

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">??/a> ??<a href="#/products">?�품 목록</a> ??견적 요청</div>' +
      '<div class="detail-grid">' +
        '<div>' +
          '<h1 class="detail-title">견적 요청</h1>' +
          '<p class="detail-sub">' + esc(product.name) + ' · ' + esc(product._cat) + '</p>' +
          '<div class="detail-block"><h3>선택 서비스</h3><ul>' +
            services.map(function (s) { return '<li><strong>' + esc(s.name) + '</strong> - ' + esc(s.description) + '</li>'; }).join('') +
          '</ul></div>' +
          '<div class="detail-block"><h3>요청자 정보</h3>' +
            '<form id="quoteForm" class="quote-form">' +
              '<label>회사/기관명 <input type="text" name="company" required></label>' +
              '<label>담당자명 <input type="text" name="name" required></label>' +
              '<label>연락처 <input type="tel" name="phone" required></label>' +
              '<label>이메일 <input type="email" name="email"></label>' +
              '<label>요청 내용 <textarea name="note" rows="4" placeholder="설치 환경, 일정, 수량 등을 입력하세요."></textarea></label>' +
              '<button type="submit" class="btn-search">견적 요청 보내기</button>' +
            '</form>' +
            '<div id="quoteResult" class="quote-result"></div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="detail-block"><h3>요청 요약 (복사용)</h3>' +
            '<pre id="quoteText" class="quote-text">' + esc(quoteText) + '</pre>' +
            '<button type="button" class="btn-search" onclick="window.cgiCopyQuote()">요약 복사</button>' +
          '</div>' +
          '<a class="back-link" href="#/product/' + encodeURIComponent(product.id) + '">??상품으로 ?�아가�?/a>' +
        '</div>' +
      '</div>';

    var form = document.getElementById('quoteForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var data = new FormData(form);
        var body = quoteText + '\n\n[요청자 정보]\n' +
          '회사/기관: ' + (data.get('company') || '') + '\n' +
          '담당자: ' + (data.get('name') || '') + '\n' +
          '연락처: ' + (data.get('phone') || '') + '\n' +
          '이메일: ' + (data.get('email') || '') + '\n' +
          '요청 내용: ' + (data.get('note') || '');
        var result = document.getElementById('quoteResult');
        if (result) result.innerHTML = '<p class="detail-price-note">견적 요청이 준비되었습니다. 아래 내용을 복사해 CGI 담당자에게 전달하세요.</p>';
        var pre = document.getElementById('quoteText');
        if (pre) pre.textContent = body;
        window.cgiLastQuote = body;
      });
    }
    window.cgiLastQuote = quoteText;
  }

  window.cgiToggleService = function (id, checked) {
    state.quoteServices = state.quoteServices || [];
    var idx = state.quoteServices.indexOf(id);
    if (checked && idx === -1) state.quoteServices.push(id);
    if (!checked && idx !== -1) state.quoteServices.splice(idx, 1);
  };

  window.cgiRequestQuote = function (productId) {
    var services = state.quoteServices && state.quoteServices.length ? state.quoteServices : [];
    if (!services.length) {
      alert('최소 1개의 서비스를 선택하세요.');
      return;
    }
    location.hash = '#/quote/' + encodeURIComponent(productId) + '?services=' + encodeURIComponent(services.join('|'));
  };

  window.cgiCopyQuote = function () {
    var text = window.cgiLastQuote || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };


  function loadQuoteCart() {
    try {
      var raw = localStorage.getItem('cgiQuoteCart');
      state.quoteCart = raw ? JSON.parse(raw) : [];
    } catch (e) {
      state.quoteCart = [];
    }
    if (!Array.isArray(state.quoteCart)) state.quoteCart = [];
  }

  function saveQuoteCart() {
    try { localStorage.setItem('cgiQuoteCart', JSON.stringify(state.quoteCart)); } catch (e) {}
  }

  function addToQuoteCart(productId, qty) {
    qty = Math.max(1, parseInt(qty || '1', 10) || 1);
    var existing = null;
    for (var i = 0; i < state.quoteCart.length; i++) {
      if (state.quoteCart[i].id === productId) { existing = state.quoteCart[i]; break; }
    }
    if (existing) {
      existing.qty += qty;
    } else {
      state.quoteCart.push({ id: productId, qty: qty });
    }
    saveQuoteCart();
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
  }

  function renderQuoteCart() {
    var items = state.quoteCart.map(function (c) {
      var p = null;
      for (var i = 0; i < state.products.length; i++) {
        if (state.products[i].id === c.id) { p = state.products[i]; break; }
      }
      return { cart: c, product: p };
    }).filter(function (x) { return x.product; });

    var services = window.CGI_SERVICES || [];
    var serviceChecks = services.map(function (svc) {
      return '<label class="service-check"><input type="checkbox" value="' + esc(svc.id) + '" onchange="window.cgiToggleQuoteService(\'' + esc(svc.id) + '\', this.checked)"> ' +
        '<strong>' + esc(svc.name) + '</strong><br><span>' + esc(svc.description) + '</span></label>';
    }).join('');

    var rows = items.map(function (x) {
      var p = x.product;
      var priceText = (p.price && p.price.inquiry) ? '가격 문의' : (p.price ? p.price.text : '-');
      return '<tr>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td>' + esc(p.brand_norm || p.brand) + '</td>' +
        '<td>' + esc(p._cat) + '</td>' +
        '<td><input type="number" min="1" value="' + x.cart.qty + '" data-qty-id="' + esc(p.id) + '" style="width:70px"></td>' +
        '<td>' + esc(priceText) + '</td>' +
        '<td><button type="button" class="btn-search" data-remove-id="' + esc(p.id) + '">삭제</button></td>' +
        '</tr>';
    }).join('');

    var quoteText = buildQuoteCartText(items);

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">??/a> ??<a href="#/products">?�품 목록</a> ??견적 요청 목록</div>' +
      '<div class="detail-block"><h3>견적 요청 상품 목록</h3>' +
        (items.length ? '<table class="spec-table"><thead><tr><th>상품명</th><th>브랜드</th><th>카테고리</th><th>수량</th><th>공개가</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p>견적 목록이 비어 있습니다. 상품 상세에서 "견적 목록에 추가"를 선택하세요.</p>') +
      '</div>' +
      '<div class="detail-block"><h3>서비스 선택</h3><div class="service-checks">' + serviceChecks + '</div></div>' +
      '<div class="detail-block"><h3>요청 정보</h3>' +
        '<form id="quoteCartForm" class="quote-form">' +
          '<label>회사/기관명 <input type="text" name="company" required></label>' +
          '<label>담당자명 <input type="text" name="name" required></label>' +
          '<label>연락처 <input type="tel" name="phone" required></label>' +
          '<label>이메일 <input type="email" name="email"></label>' +
          '<label>배송/설치 장소 <input type="text" name="location"></label>' +
          '<label>요청 사항 <textarea name="note" rows="4"></textarea></label>' +
          '<button type="submit" class="btn-search">견적 요청 생성</button>' +
        '</form>' +
        '<div id="quoteCartResult" class="quote-result"></div>' +
      '</div>' +
      '<div class="detail-block"><h3>견적 요청 요약 (복사/다운로드)</h3>' +
        '<pre id="quoteCartText" class="quote-text">' + esc(quoteText) + '</pre>' +
        '<button type="button" class="btn-search" onclick="window.cgiCopyQuoteCart()">요약 복사</button> ' +
        '<button type="button" class="btn-search" onclick="window.cgiDownloadQuoteCart()">JSON 다운로드</button> ' +
        '<button type="button" class="btn-search" onclick="window.cgiDownloadQuoteCartCsv()">CSV 다운로드</button>' +
      '</div>' +
      '<a class="back-link" href="#/products">??목록으로 돌아가기</a>';

    // quantity change handlers
    Array.prototype.forEach.call(document.querySelectorAll('input[data-qty-id]'), function (inp) {
      inp.addEventListener('change', function () {
        updateQuoteCartQty(inp.getAttribute('data-qty-id'), inp.value);
        renderQuoteCart();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('button[data-remove-id]'), function (btn) {
      btn.addEventListener('click', function () {
        removeFromQuoteCart(btn.getAttribute('data-remove-id'));
        renderQuoteCart();
      });
    });

    var form = document.getElementById('quoteCartForm');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
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
          services: state.quoteCartServices || [],
          items: items.map(function (x) {
            return { id: x.product.id, name: x.product.name, brand: x.product.brand_norm || x.product.brand, category: x.product._cat, qty: x.cart.qty, publicPrice: (x.product.price && x.product.price.inquiry) ? null : (x.product.price ? x.product.price.text : null) };
          })
        };
        window.cgiLastQuoteCartRequest = request;
        // save to localStorage list of requests
        try {
          var list = JSON.parse(localStorage.getItem('cgiQuoteRequests') || '[]');
          list.unshift(request);
          localStorage.setItem('cgiQuoteRequests', JSON.stringify(list));
        } catch (e) {}
        var result = document.getElementById('quoteCartResult');
        if (result) result.innerHTML = '<p class="detail-price-note">견적 요청이 저장되었습니다. JSON/CSV로 다운로드하거나 담당자에게 전달하세요.</p>';
        var pre = document.getElementById('quoteCartText');
        if (pre) pre.textContent = buildQuoteCartText(items, request);
        window.cgiLastQuoteCartText = buildQuoteCartText(items, request);
      });
    }
    window.cgiLastQuoteCartText = quoteText;
  }

  function buildQuoteCartText(items, request) {
    var lines = [];
    lines.push('[CGI 견적 요청]');
    if (request) {
      lines.push('요청번호: ' + request.id);
      lines.push('요청일시: ' + request.createdAt);
      lines.push('회사/기관: ' + request.company);
      lines.push('담당자: ' + request.name);
      lines.push('연락처: ' + request.phone);
      lines.push('이메일: ' + request.email);
      lines.push('배송/설치 장소: ' + request.location);
      lines.push('요청 사항: ' + request.note);
      lines.push('요청 서비스: ' + (request.services || []).join(', '));
    }
    lines.push('');
    lines.push('상품 목록:');
    items.forEach(function (x, idx) {
      var p = x.product;
      var priceText = (p.price && p.price.inquiry) ? '가격 문의' : (p.price ? p.price.text : '-');
      lines.push((idx+1) + '. ' + p.name + ' | ' + (p.brand_norm || p.brand) + ' | ' + p._cat + ' | 수량 ' + x.cart.qty + ' | 공개가 ' + priceText);
    });
    lines.push('');
    lines.push('※ 금액은 고객 확정 전 미표시. CGI 담당자가 견적서를 작성합니다.');
    return lines.join('\n');
  }

  window.cgiToggleQuoteService = function (id, checked) {
    state.quoteCartServices = state.quoteCartServices || [];
    var idx = state.quoteCartServices.indexOf(id);
    if (checked && idx === -1) state.quoteCartServices.push(id);
    if (!checked && idx !== -1) state.quoteCartServices.splice(idx, 1);
  };

  window.cgiCopyQuoteCart = function () {
    var text = window.cgiLastQuoteCartText || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  window.cgiDownloadQuoteCart = function () {
    var request = window.cgiLastQuoteCartRequest;
    if (!request) {
      alert('먼저 견적 요청을 생성하세요.');
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
      alert('먼저 견적 요청을 생성하세요.');
      return;
    }
    var lines = [];
    lines.push('요청번호,요청일시,회사,담당자,연락처,이메일,장소,서비스,상품ID,상품명,브랜드,카테고리,수량,공개가');
    request.items.forEach(function (it) {
      lines.push([request.id,request.createdAt,request.company,request.name,request.phone,request.email,request.location,(request.services||[]).join('|'),it.id,it.name,it.brand,it.category,it.qty,it.publicPrice||''].map(function (v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
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

  window.cgiAddToQuoteCart = function (productId) {
    addToQuoteCart(productId, 1);
    alert('견적 목록에 추가했습니다.');
  };

  function renderAbout() {
    var totals = state.meta.supplier_catalog_totals || {};
    var totalLine = Object.keys(totals).map(function (site) {
      var label = (state.meta.source_labels && state.meta.source_labels[site]) || site;
      var entry = totals[site];
      var count = (entry && typeof entry === 'object') ? entry.count : entry;
      var src = (entry && typeof entry === 'object') ? entry.source : '';
      return label + ' ' + Number(count).toLocaleString('ko-KR') + '건 (' + src + ')';
    }).join(' / ');
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a> › 안내</div>' +
      '<div class="about-card">' +
        '<h2>이 카탈로그는 무엇인가</h2>' +
        '<p>공급처(三아사운드·삼아스토어) 공개 페이지에서 수집한 <b>공개 정보만</b>으로 구성한 CGI 자체 미리보기 카탈로그입니다. ' +
        '삼아스토어의 메뉴·탐색 방식을 참고하되, 상표·로고·화면을 복제하지 않았고 공식 삼아스토어가 아닙니다.</p>' +
        '<h2>표시 수량에 대한 정확성 안내</h2>' +
        '<ul>' +
          '<li>현재 표시되는 상품 <b>' + state.products.length + '건</b>은 공개 수집 <b>샘플</b>입니다.</li>' +
          '<li>공급처 카탈로그 규모: ' + esc(totalLine || '확인 중') + ' — 이는 <b>공급처 전체 카탈로그 규모이며 CGI가 판매할 수 있는 수량이 아닙니다.</b></li>' +
          '<li>가격이 공개되지 않은 상품은 추정하지 않고 <b>가격 문의</b>로 표시합니다.</li>' +
          '<li>재고·배송은 실시간 정보가 아니며 원본 확인이 필요합니다.</li>' +
        '</ul>' +
        '<h2>전체 카탈로그로 교체 방법</h2>' +
        '<ul>' +
          '<li>수집 결과가 JSON/CSV로 준비되면 <code>python tools/build_catalog_data.py --master-csv …</code> 로 <code>site/data/products.json</code> 과 <code>products.js</code> 를 재생성합니다.</li>' +
          '<li>데이터 파일만 교체하려면 <code>index.html?data=data/products.json</code> 처럼 <code>?data=</code> 로 다른 JSON 을 지정할 수 있습니다.</li>' +
          '<li>스키마: <code>docs/CGI_CATALOG_SITE.md</code> 의 데이터 계층 참고.</li>' +
        '</ul>' +
        '<h2>네이버 스마트스토어 연계 준비 상태</h2>' +
        '<ul>' +
          '<li>공급처 공개 판매가·모델명·옵션·이미지·출처가 그대로 보존되어 있어, 개설 후 등록 자료 매핑에 그대로 사용할 수 있습니다.</li>' +
          '<li>정확한 매핑 규칙과 홈 연결 방법은 <code>docs/CGI_CATALOG_SITE.md</code> 에 정리되어 있습니다.</li>' +
          '<li>현재는 실사이트 개설·상품 게시·주문·결제·ERP 변경을 수행하지 않습니다.</li>' +
        '</ul>' +
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
    var route = {
      view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'recent', page: 1, id: null
    };
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

  function render() {
    state.route = parseHash();
    applySiteConfig();
    var nav = document.querySelectorAll('.header-nav a');
    for (var i = 0; i < nav.length; i++) {
      nav[i].classList.toggle('is-active', nav[i].getAttribute('data-nav') === state.route.view ||
        (state.route.view === 'detail' && nav[i].getAttribute('data-nav') === 'list'));
    }
    if (state.route.view === 'home') renderHome();
    else if (state.route.view === 'list') renderList();
    else if (state.route.view === 'detail') renderDetail(state.route.id);
    else if (state.route.view === 'quote') renderQuote(state.route.id, state.route.services || []);
    else if (state.route.view === 'quote-cart') renderQuoteCart();
    else renderAbout();
    renderFooterSources();
    if (location.hash === '#/products') window.scrollTo(0, 0);
  }

  /* ------------------------------------------- 쇼핑몰 ↔ 홈페이지 연결 설정 */
  function siteConfig() {
    return window.CGI_SITE_CONFIG || {};
  }

  /* config.js 의 homepageUrl 을 모든 '회사 홈페이지' 링크에 적용한다.
     (HTML 에는 기본값이 들어 있어 JS 없이도 동작한다) */
  function applySiteConfig() {
    var cfg = siteConfig();
    if (!cfg.homepageUrl) return;
    var links = document.querySelectorAll('[data-home-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', cfg.homepageUrl);
      if (cfg.homepageLabel && links[i].hasAttribute('data-home-label')) {
        links[i].textContent = cfg.homepageLabel;
      }
    }
  }

  function renderFooterSources() {
    var list = document.getElementById('footerSources');
    if (!list) return;
    var origins = state.meta.data_origin || [];
    if (!origins.length) { list.innerHTML = '<li>수집 샘플(공개 정보)</li>'; return; }
    list.innerHTML = origins.map(function (o) { return '<li>' + esc(o) + '</li>'; }).join('');
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
    var target = event.target.closest ? event.target.closest('[data-action], [data-page], [data-remove], [data-gallery-index]') : null;
    if (!target) return;

    if (target.hasAttribute('data-action')) {
      var action = target.getAttribute('data-action');
      if (action === 'reset-filters') {
        navigate('#/products' + (state.route.q ? '?q=' + encodeURIComponent(state.route.q) : ''));
        return;
      }
      if (action === 'toggle-filters') {
        var panel = document.getElementById('filterPanel');
        if (panel) {
          var hidden = panel.hasAttribute('hidden');
          if (hidden) { panel.removeAttribute('hidden'); } else { panel.setAttribute('hidden', ''); }
          target.setAttribute('aria-expanded', hidden ? 'true' : 'false');
          target.textContent = hidden ? '필터 닫기' : '필터 열기';
        }
        return;
      }
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
      var next = Object.assign({}, state.route);
      if (kind === 'q') next.q = '';
      else next[kind] = next[kind].filter(function (v) { return v !== value; });
      next.page = 1;
      var q = next.q ? '?q=' + encodeURIComponent(next.q) : '';
      var extra = [];
      if (next.brands.length) extra.push('brand=' + encodeURIComponent(next.brands.join('|')));
      if (next.cats.length) extra.push('cat=' + encodeURIComponent(next.cats.join('|')));
      if (next.sites.length) extra.push('site=' + encodeURIComponent(next.sites.join('|')));
      navigate('#/products' + q + (extra.length ? '&' + extra.join('&') : ''));
      return;
    }

    if (target.hasAttribute('data-gallery-index')) {
      var idx = parseInt(target.getAttribute('data-gallery-index'), 10);
      var product = null;
      for (var i = 0; i < state.products.length; i++) {
        if (state.products[i].id === state.route.id) { product = state.products[i]; break; }
      }
      if (!product || !product.images[idx]) return;
      var main = document.getElementById('galleryMain');
      if (main) {
        main.src = product.images[idx];
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
    }
  });

  window.addEventListener('hashchange', render);

  /* ----------------------------------------------------------------- boot */
  loadProducts().then(function () {
    loadQuoteCart();
    if (loadingBox && loadingBox.parentNode) loadingBox.parentNode.removeChild(loadingBox);
    render();
    document.body.setAttribute('data-cgi-ready', '1');
  }).catch(function (error) {
    if (loadingBox) {
      loadingBox.textContent = '상품 데이터를 불러오지 못했습니다: ' + error.message;
    }
    document.body.setAttribute('data-cgi-ready', 'error');
  });
})();
