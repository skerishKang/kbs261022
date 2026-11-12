/* ==========================================================================
   CGI 상품 카탈로그 — 프런트엔드
   - 정적 HTML/CSS/JS (빌드 없음)
   - 라우팅: #/ · #/products?... · #/product/<id> · #/quote-cart · #/about
   - 데이터: window.CGI_PRODUCTS (data/products.js) 또는 ?data=<json>
   - 원본 데이터는 수정하지 않고, 화면 렌더링 단계에서 이미지·표시 정보를 정리한다.
   ========================================================================== */
(function () {
  'use strict';

  var PER_PAGE = 24; // 한 쪽 24개 (#213 D2)
  var HOME_CHIP_LIMIT = 10;
  var app = document.getElementById('app');
  var loadingBox = document.getElementById('loadingBox');
  var lastView = null;
  var toastTimer = null;

  var state = {
    products: [],
    meta: { product_count: 0, source_labels: {}, supplier_catalog_totals: {} },
    route: { view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'featured', page: 1, id: null },
    quoteCart: [],
    quoteServices: [],
    quoteCartServices: [],
    failedImages: {},
    brandSet: {}
  };

  /* ---------------------------------------------------------------- utils */
  /* 회사정보는 website/assets/company.js(2025년 지명원 기준)를 우선 읽고,
     파일이 없거나 배포 경로가 다를 때만 아래 값으로 대체한다. */
  var CO = window.CGI_COMPANY || null;

  function cVal(path, fallback) {
    var cur = CO;
    if (!cur) { return fallback; }
    path.split('.').forEach(function (k) { cur = (cur && typeof cur === 'object') ? cur[k] : undefined; });
    return (cur === undefined || cur === null || cur === '') ? fallback : cur;
  }

  function companyTels() {
    var t = CO && CO.contact && CO.contact.tels;
    return (Array.isArray(t) && t.length) ? t : [{ num: '062) 576-8100', dial: '0625768100' }];
  }

  function companyContactHtml() {
    var telHtml = companyTels().map(function (t) {
      return '<a href="tel:' + esc(t.dial) + '">' + esc(t.num) + '</a>';
    }).join(' &nbsp;·&nbsp; ');
    var zip = cVal('hq.zip', '57248');
    return '<dl class="about-contact">' +
      '<div><dt>전화</dt><dd>' + telHtml + '</dd></div>' +
      '<div><dt>팩스</dt><dd>' + esc(cVal('contact.fax', '062) 576-8181')) + '</dd></div>' +
      '<div><dt>본사</dt><dd>[' + esc(zip) + '] ' + esc(cVal('hq.addrFull', '전라남도 장성군 남면 나노산단로 102 (삼태리)')) + '</dd></div>' +
      '<div><dt>회사</dt><dd>' + esc(cVal('identity.nameKo', '주식회사 시지아이')) +
        ' (' + esc(cVal('identity.nameEn', 'CGI Inc.')) + ')</dd></div>' +
      '</dl>';
  }

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
  /* '기타' 묶음(비브랜드) 상품은 카드·상세의 브랜드 줄을 비운다 (#216 H3).
     필터·칩에는 '그 외'라는 이름으로 남긴다. */
  function brandDisplay(product) {
    var b = displayBrand(product);
    return b === '기타' ? '' : b;
  }
  function brandLabel(value) {
    return value === '기타' ? '그 외' : value;
  }
  function categoryLabel(product) {
    if (product.category && product.category.name) return product.category.name;
    if (product.category_path && product.category_path.length) return product.category_path[product.category_path.length - 1];
    return '미분류';
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
    if (sort && sort !== 'featured') params.push('sort=' + encodeURIComponent(sort));
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
  /* 추천순 (#209 A5): 대표 상품(이미지·공개가·상태 태그 없음)을 앞에 두고,
     리퍼·단순개봉·전시·박스손상 등 상태 태그 상품은 뒤로 보낸다. */
  function featuredRank(p) {
    if (splitConditionTag(p.name).tag) return 1;
    if (!p.images.length) return 1;
    if (!isPublicPriced(p)) return 1;
    return 0;
  }
  /* 대분류 우선순위 (#213 D1) — 홈 칩·필터·추천순 정렬이 모두 이 순서를 쓴다. */
  var CATEGORY_ORDER = [
    '스피커', '믹서·프로세서', '마이크·무선', '네트워크·회의영상', '레코딩·인터페이스',
    '이어폰·헤드폰', '음향 튜닝·방음', '스탠드·거치', '케이블·커넥터', '악기·앰프',
    '소프트웨어·플러그인', '액세서리·소모품', '특가·기획',
  ];
  function catOrder(cat) {
    var i = CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? CATEGORY_ORDER.length : i;
  }
  /* 고정 추천(#213 D1): site/data/featured.json 의 상품 id 는 맨 앞에 온다.
     대표 상품을 정해 받으면 이 파일에 넣는다. */
  function featuredFixedRank(p) {
    return state.featuredIds && state.featuredIds.indexOf(p.id) !== -1 ? 0 : 1;
  }
  function featuredCompare(a, b) {
    var d = featuredFixedRank(a) - featuredFixedRank(b);
    if (d) return d;
    d = featuredRank(a) - featuredRank(b);
    if (d) return d;
    // 같은 브랜드가 연달아 나오지 않게: 브랜드 안 가격 높은 순 순번 (#213 D1)
    d = (a._brandSeq || 0) - (b._brandSeq || 0);
    if (d) return d;
    d = catOrder(a._cat) - catOrder(b._cat);
    if (d) return d;
    var ca = (state.brandCounts && state.brandCounts[a._brand]) || 0;
    var cb = (state.brandCounts && state.brandCounts[b._brand]) || 0;
    if (ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name, 'ko');
  }
  /* 정렬 보조값: 브랜드별 순번·브랜드 상품 수. 상품 준비가 끝난 뒤 한 번 계산한다. */
  function computeSortAux() {
    var byBrand = {};
    state.products.forEach(function (p) {
      var b = p._brand;
      if (!b) return;
      (byBrand[b] = byBrand[b] || []).push(p);
    });
    Object.keys(byBrand).forEach(function (b) {
      byBrand[b].sort(function (x, y) {
        var px = x.price && x.price.state === 'public' ? Number(x.price.value) : -1;
        var py = y.price && y.price.state === 'public' ? Number(y.price.value) : -1;
        if (px !== py) return py - px;
        return x.name.localeCompare(y.name, 'ko');
      });
      byBrand[b].forEach(function (p, i) { p._brandSeq = i; });
    });
    state.brandCounts = countBy(state.products, function (p) { return p._brand; });
  }
  /* featured.json 은 선택 파일이다 — 없어도 목록은 정상 동작한다. */
  function loadFeaturedSet() {
    var url = new URL('data/featured.json', location.href).toString();
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      return res.ok ? res.json() : [];
    }).then(function (rows) {
      state.featuredIds = Array.isArray(rows) ? rows : [];
    }).catch(function () {
      state.featuredIds = [];
    });
  }
  function showToast(message, action) {
    var box = document.getElementById('cgiToast');
    if (!box) return;
    box.innerHTML = '';
    var text = document.createElement('span');
    text.textContent = message;
    box.appendChild(text);
    if (action && action.label && action.href) {
      var link = document.createElement('a');
      link.className = 'toast-action';
      link.href = action.href;
      link.textContent = action.label;
      box.appendChild(link);
    }
    box.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('is-on'); }, 3200);
  }
  function hideToast() {
    var box = document.getElementById('cgiToast');
    if (!box) return;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    box.classList.remove('is-on');
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
  // 공급처 서버 hotlink 이미지는 결려 로드 실패가 발생한다 — 빈 칸 대신
  // 중립 플레이스홀더로 폴백한다 (추가 네트워크 요청 없음).
  function imageHtml(product, className, priority) {
    if (!product.images.length) {
      return '<div class="' + className + ' no-image"><span class="no-image-logo">CGI</span><span>이미지 준비 중</span></div>';
    }
    return '<img class="' + className + '" src="' + esc(product.images[0]) + '" alt="' + esc(product.name) +
      '" width="400" height="400" loading="' + (priority ? 'eager' : 'lazy') + '" decoding="async"' +
      (priority ? ' fetchpriority="high"' : '') + ' onerror="window.cgiHandleImageError(this)">';
  }
  window.cgiHandleImageError = function (img) {
    if (!img || !img.parentNode) return;
    var placeholder = document.createElement('div');
    placeholder.className = (img.className || 'card-img') + ' no-image';
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', (img.alt || '상품') + ' 이미지 준비 중');
    placeholder.innerHTML = '<span class="no-image-logo">CGI</span><span>이미지 준비 중</span>';
    img.parentNode.replaceChild(placeholder, img);
  }
  function fallbackBlock(className) {
    return '<div class="' + className + ' no-image"><span class="no-image-logo">CGI</span><span>이미지 준비 중</span></div>';
  }

  /* ------------------------------------------------------------- data load */
  /**
   * ?data= 는 같은 오리진의 data/ 하위 .json 만 허용한다. 외부 URL·상위 경로·
   * 비JSON 은 조용히 무시하고 기본 경량 목록으로 돌아간다(SSRF/피싱 방지).
   */
  function allowedDataUrl(raw) {
    if (!raw) return null;
    try {
      var url = new URL(raw, location.href);
      if (url.origin !== location.origin) return null;
      var dataBase = new URL('data/', location.href).pathname;
      if (url.pathname.indexOf(dataBase) !== 0) return null;
      if (!/\.json$/i.test(url.pathname)) return null;
      return url.toString();
    } catch (e) {
      return null;
    }
  }

  function applyCatalog(rows) {
    var list = (rows && rows.products) || rows || [];
    state.products = list.map(prepare);
    computeSortAux();
    if (rows && rows.meta) state.meta = Object.assign(state.meta, rows.meta);
    // cgi-order.js · cgi-staff.js 는 window.CGI_PRODUCTS 를 그대로 쓴다.
    window.CGI_PRODUCTS = state.products;
    return state.products;
  }

  function loadProducts() {
    // A page may preload the list (file:// or a test harness). Otherwise the
    // light catalog.json is fetched.
    if (Array.isArray(window.CGI_PRODUCTS) && window.CGI_PRODUCTS.length) {
      state.products = window.CGI_PRODUCTS.map(prepare);
      computeSortAux();
      if (window.CGI_PRODUCT_META) state.meta = Object.assign(state.meta, window.CGI_PRODUCT_META);
      return loadFeaturedSet().then(function () { return state.products; });
    }
    var dataUrl = allowedDataUrl(new URLSearchParams(location.search).get('data'));
    if (dataUrl) {
      return fetch(dataUrl).then(function (res) {
        if (!res.ok) throw new Error('데이터 파일을 읽지 못했습니다: ' + res.status);
        return res.json();
      }).then(applyCatalog).then(function (products) {
        return loadFeaturedSet().then(function () { return products; });
      });
    }
    var url = new URL('data/catalog.json', location.href).toString();
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('상품 목록을 읽지 못했습니다: ' + res.status);
      return res.json();
    }).then(applyCatalog).then(function (products) {
      return loadFeaturedSet().then(function () { return products; });
    });
  }

  var detailCache = {};

  /** 상세 분할 파일(part-XXXX.json)을 한 번만 읽어 상품에 병합한다. */
  function loadDetail(product) {
    if (!product) return Promise.resolve(null);
    if (product._detailLoaded || !product.shard) {
      product._detailLoaded = true;
      return Promise.resolve(product);
    }
    var shardNumber = String(product.shard).replace(/[^0-9]/g, '');
    if (!shardNumber) {
      product._detailLoaded = true;
      return Promise.resolve(product);
    }
    var key = 'data/details/part-' + shardNumber.padStart(4, '0') + '.json';
    var pending = detailCache[key];
    if (!pending) {
      pending = fetch(new URL(key, location.href).toString()).then(function (res) {
        if (!res.ok) throw new Error('상세 데이터를 읽지 못했습니다: ' + res.status);
        return res.json();
      });
      detailCache[key] = pending;
    }
    return pending.then(function (payload) {
      var rows = (payload && payload.products) || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id !== product.id) continue;
        var d = rows[i];
        if (d.images && d.images.length) product.images = cleanImages(d.images);
        product.specs = d.specs || [];
        product.options = d.options || [];
        product.source = Object.assign({}, product.source, d.source || {});
        break;
      }
      product._detailLoaded = true;
      return product;
    }).catch(function () {
      // 상세 파일을 못 읽어도 목록 정보로 화면을 유지한다(전체 페이지 실패 방지).
      product._detailLoaded = true;
      return product;
    });
  }

  function prepare(product) {
    var p = Object.assign({}, product);
    p.specs = p.specs || [];
    p.options = p.options || [];
    p.source = p.source || {};
    p.images = cleanImages(p.images);
    p._search = norm(p.search_text || [p.name, p.model, p.brand, p.brand_raw, p.manufacturer, categoryLabel(p),
      (p.category_path || []).join(' '),
      (p.specs || []).map(function (s) { return s.label + ' ' + s.value; }).join(' ')].join(' '));
    p._cat = mapCategory(categoryLabel(p));
    p._brand = displayBrand(p);
    state.brandSet[p._brand.toUpperCase()] = true;
    return p;
  }

  /* 공급처 분류 211종을 대분류로 묶는다 (#209 B1). 매핑표는 site/data/category_map.js.
     원본 분류는 _search(검색 대상)에 그대로 남고, 화면·필터는 대분류만 쓴다. */
  var CAT_MAP = window.CGI_CATEGORY_MAP || null;
  function mapCategory(label) {
    if (!CAT_MAP) return label;
    var name = String(label || '');
    if (CAT_MAP.exact && Object.prototype.hasOwnProperty.call(CAT_MAP.exact, name)) return CAT_MAP.exact[name];
    var rules = CAT_MAP.rules || [];
    for (var i = 0; i < rules.length; i++) {
      var keywords = rules[i].keywords || [];
      for (var j = 0; j < keywords.length; j++) {
        if (name.indexOf(keywords[j]) !== -1) return rules[i].group;
      }
      var exactKeywords = rules[i].exactKeywords || [];
      for (var k = 0; k < exactKeywords.length; k++) {
        if (name === exactKeywords[k]) return rules[i].group;
      }
    }
    return CAT_MAP.fallback || label;
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

    var sort = r.sort || 'featured';
    // 검색어와 함께 기본 정렬이면 '추천순'이 아니라 관련도순으로 보인다.
    var useRelevance = !!q && (sort === 'featured' || sort === 'recent');
    var relevance = function (p) {
      var s = 0;
      var name = norm(p.name), model = norm(p.model), brand = norm(p._brand);
      if (model && model === q) s += 100;
      if (name.indexOf(q) === 0) s += 60;
      else if (name.indexOf(q) !== -1) s += 40;
      if (brand && (q.indexOf(brand) !== -1 || brand.indexOf(q) !== -1)) s += 30;
      q.split(' ').forEach(function (t) { if (t.length >= 2 && p._search.indexOf(t) !== -1) s += 5; });
      return s;
    };
    list.sort(function (a, b) {
      if (useRelevance) {
        var d = relevance(b) - relevance(a);
        if (d) return d;
        return recentCompare(a, b);
      }
      if (sort === 'price_asc' || sort === 'price_desc') {
        var av = a.price && a.price.value !== null && a.price.value !== undefined ? a.price.value : null;
        var bv = b.price && b.price.value !== null && b.price.value !== undefined ? b.price.value : null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return sort === 'price_asc' ? av - bv : bv - av;
      }
      if (sort === 'name') return a.name.localeCompare(b.name, 'ko');
      if (sort === 'featured') return featuredCompare(a, b);
      return recentCompare(a, b);
    });
    return list;
  }

  /* ------------------------------------------------------------- fragments */
  /* #126: 상품명 선두 [태그] 중 실제 상품 상태만 분리해 배지로 표시한다(표시 전용).
   * 브랜드명·한정판 등 상태가 아닌 접두사는 원본 상품명 그대로 노출한다. */
  var CONDITION_TAGS = ['박스손상', '리퍼비쉬', '전시상품', '전시제품', '전시/단종 클리어런스', '단순개봉', '교환상품', '미세흠집', '입고후발송', '커버 무료증정'];
  function splitConditionTag(name) {
    var s = String(name || '');
    var m = s.match(/^(?:\[([^\]]+)\]|\(([^)]+)\))\s*/);
    var tag = m && (m[1] || m[2]);
    if (tag && CONDITION_TAGS.indexOf(tag) !== -1) {
      return { tag: tag, name: s.slice(m[0].length) };
    }
    return { tag: null, name: s };
  }
  /* 테스트·디버깅 노출 (브라우저 동작 불변) */
  window.cgiDebug = window.cgiDebug || {};
  window.cgiDebug.splitConditionTag = splitConditionTag;
  window.cgiDebug.CONDITION_TAGS = CONDITION_TAGS;
  window.cgiDebug.renderLegalInfo = renderLegalInfo;
  window.cgiDebug.featuredCompare = featuredCompare;
  window.cgiDebug.CATEGORY_ORDER = CATEGORY_ORDER;
  window.cgiDebug.orderedCategoryValues = orderedCategoryValues;
  window.cgiDebug.applyCatalog = applyCatalog;

  function cardHtml(product, priority) {
    var price = fmtPrice(product);
    var badge = price.inquiry ? '<span class="badge inquiry">가격 문의</span>' : '';
    var cond = splitConditionTag(product.name);
    return '' +
      '<a class="product-card" href="' + esc(productUrl(product.id)) + '" data-product-id="' + esc(product.id) + '">' +
        '<div class="thumb">' + badge + imageHtml(product, 'card-img', priority) + '</div>' +
        '<div class="card-body">' +
          '<span class="card-brand">' + esc(brandDisplay(product)) + '</span>' +
          (cond.tag ? '<div class="card-flags"><span class="badge cond">' + esc(cond.tag) + '</span></div>' : '') +
          '<h3 class="card-name">' + esc(cond.name) + '</h3>' +
          (product.model && product.model !== product.name ? '<span class="card-model">' + esc(product.model) + '</span>' : '') +
          '<div class="card-foot">' +
            '<span class="price ' + price.cls + '">' + esc(price.text) + '</span>' +
          '</div>' +
        '</div>' +
      '</a>';
  }

  function gridHtml(list, priority) {
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
    return '<div class="product-grid">' + list.map(function (product) { return cardHtml(product, priority); }).join('') + '</div>';
  }

  function orderedFacetValues(counts, selected) {
    var values = Object.keys(counts);
    // "기타…" 계열은 분류 잡음이라 항상 뒤로 밀는다 — 시지아이 주력 브랜드가 상위.
    var otherRank = function (v) { return /^기타/.test(v) ? 1 : 0; };
    values.sort(function (a, b) {
      if (otherRank(a) !== otherRank(b)) return otherRank(a) - otherRank(b);
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
  /* 대분류는 개수순이 아니라 우선순위 순서로 나열한다 (#213 D1). */
  function orderedCategoryValues(counts, selected) {
    var values = Object.keys(counts);
    values.sort(function (a, b) {
      var oa = catOrder(a), ob = catOrder(b);
      if (oa !== ob) return oa - ob;
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

  /** 카테고리 필터 표시 그룹핑(표시 전용): 값이 브랜드명과 동일하면 공급처 브랜드 코너로 묶는다.
   *  원본 데이터·식별자·필터 동작(체크박스/검색)은 변경하지 않는다. */
  function catGroupFn(value) {
    // 대분류 재편(#209 B1)으로 브랜드명 분류 코너는 더는 만들지 않는다.
    return '일반 카테고리';
  }

  function facetBlock(title, name, values, counts, selected, groupFn) {
    if (!values.length) return '';
    var sections = [];
    var sectionIndex = {};
    values.forEach(function (value) {
      var g = groupFn ? groupFn(value) : null;
      if (!(g in sectionIndex)) { sectionIndex[g] = sections.length; sections.push({ label: g, values: [] }); }
      sections[sectionIndex[g]].values.push(value);
    });
    if (groupFn) {
      var pri = { '일반 카테고리': 0 };
      sections.sort(function (a, b) {
        return (pri[a.label] !== undefined ? pri[a.label] : 1) - (pri[b.label] !== undefined ? pri[b.label] : 1);
      });
    }
    var rows = '';
    var rowIdx = 0;
    sections.forEach(function (sec) {
      if (groupFn && sec.label !== null) {
        rows += '<div class="filter-subhead">' + esc(sec.label) + '<span class="subhead-cnt">' + sec.values.length + '</span></div>';
      }
      rows += sec.values.map(function (value) {
        var id = 'f-' + name + '-' + (rowIdx++);
        var checked = selected.indexOf(value) !== -1 ? ' checked' : '';
        var labelText = title === '브랜드' ? brandLabel(value) : value;
        return '<label for="' + id + '">' +
          '<input type="checkbox" id="' + id + '" data-facet="' + name + '" value="' + esc(value) + '"' + checked + '>' +
          '<span>' + esc(labelText) + '</span>' +
          '<span class="cnt">' + Number(counts[value] || 0).toLocaleString('ko-KR') + '</span>' +
        '</label>';
      }).join('');
    });
    var facetTotal = title === '브랜드' && values.indexOf('기타') !== -1 ? values.length - 1 : values.length;
    return '<details class="filter-group" open>' +
      '<summary><span>' + esc(title) + '</span><span class="facet-total">' + facetTotal + '</span></summary>' +
      '<div class="filter-body">' +
        (values.length > 10
          ? '<input type="search" class="facet-search" data-facet-search="' + name + '" placeholder="' + esc(title) + ' 검색" aria-label="' + esc(title) + ' 검색" autocomplete="off">'
          : '') +
        '<div class="filter-list">' + rows + '</div>' +
      '</div>' +
    '</details>';
  }

  function chipHtml(label, count, kind, urlValue) {
    var overrides = { q: '', brands: [], cats: [], sites: [] };
    if (kind === 'brand') overrides.brands = [urlValue || label];
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
      '<div class="chip-row">' + top.map(function (v) { return chipHtml(kind === 'brand' ? brandLabel(v) : v, counts[v], kind, kind === 'brand' ? v : undefined); }).join('') + '</div>' +
      (rest.length
        ? '<details class="chip-more"><summary>' + esc(title) + ' 전체 보기 (' + (kind === 'brand' ? values.length - 1 : values.length) + ')</summary>' +
            '<div class="chip-row">' + rest.map(function (v) { return chipHtml(kind === 'brand' ? brandLabel(v) : v, counts[v], kind, kind === 'brand' ? v : undefined); }).join('') + '</div></details>'
        : '') +
    '</section>';
  }

  var FEATURED_MIN_PRICE = 50000; // 홈 추천은 일정 가격 이상 대표 상품에서만 (#209 A5)
  function pickFeatured(limit) {
    var priority = ['SHURE', 'GENELEC', 'ALLEN&HEATH', 'PRESONUS', 'KLOTZ', 'NEUTRIK', 'APOGEE', 'ARTURIA'];
    var candidates = state.products.filter(function (p) {
      // 박스손상·리퍼 등 상태 태그 상품은 추천에서 제외 — 첫 화면은 정상 재고 면모.
      return p.images.length && p.price && p.price.state === 'public' &&
        Number(p.price.value) >= FEATURED_MIN_PRICE && !splitConditionTag(p.name).tag;
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
    var cats = orderedCategoryValues(catCounts, []);
    // '취급 브랜드' 수는 실제 브랜드만 세고, 비브랜드 묶음 '기타'는 뺀다 (#213 D4)
    // — 홈페이지 브랜드 목록 수와 같게 맞춘다.
    var brandStat = brands.filter(function (b) { return b !== '기타'; }).length;
    var priced = state.products.filter(function (p) { return p.price && p.price.state === 'public'; }).length;
    var featured = pickFeatured(8);
    var quickCategories = cats.slice(0, 4).map(function (v) { return chipHtml(v, catCounts[v], 'cat'); }).join('');
    var quickBrands = brands.slice(0, 4).map(function (v) { return chipHtml(brandLabel(v), brandCounts[v], 'brand', v); }).join('');

    app.innerHTML =
      '<section class="hero">' +
        '<p class="hero-eyebrow">CGI B2B CATALOG</p>' +
        '<h1>CGI 상품 카탈로그</h1>' +
        '<p class="hero-copy">음향·영상·조명 장비를 브랜드와 카테고리로 찾고, 필요한 상품을 견적 목록에 담아 요청하세요.</p>' +
        '<div class="hero-quicklinks" aria-label="대표 카테고리와 브랜드 바로가기">' +
          '<div class="hero-quick-group"><span class="hero-quick-label">카테고리</span>' + quickCategories + '</div>' +
          '<div class="hero-quick-group"><span class="hero-quick-label">브랜드</span>' + quickBrands + '</div>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>추천 상품</h2><a class="more" href="#/products">전체 상품 보기 →</a></div>' +
        gridHtml(featured, true) +
      '</section>' +

      '<dl class="stat-row">' +
        '<div class="stat-card"><dt>전체 상품</dt><dd>' + total.toLocaleString('ko-KR') + '<small>브랜드·카테고리 기준</small></dd></div>' +
        '<div class="stat-card"><dt>취급 브랜드</dt><dd>' + brandStat + '<small>카탈로그 등록 브랜드</small></dd></div>' +
        '<div class="stat-card"><dt>가격 공개 상품</dt><dd>' + priced.toLocaleString('ko-KR') + '<small>가격은 변동될 수 있습니다</small></dd></div>' +
      '</dl>' +

      chipSection('브랜드별 찾기', brands, brandCounts, 'brand', HOME_CHIP_LIMIT) +
      chipSection('카테고리별 찾기', cats, catCounts, 'cat', HOME_CHIP_LIMIT) +

      '<section class="home-cta">' +
        '<div><h2>원하는 상품을 찾지 못하셨나요?</h2><p>상품명·모델명으로 검색하거나 CGI 담당자에게 문의해 주세요.</p></div>' +
        '<a class="btn btn-primary" href="tel:' + esc(companyTels()[0].dial) + '">' + esc(companyTels()[0].num) + '</a>' +
      '</section>';
  }

  function renderList() {
    var r = state.route;
    var list = filteredProducts();
    var brandCounts = countBy(state.products, function (p) { return p._brand; });
    var catCounts = countBy(state.products, function (p) { return p._cat; });
    var siteCounts = countBy(state.products, function (p) { return p.source.site; });
    var brandValues = orderedFacetValues(brandCounts, r.brands);
    var catValues = orderedCategoryValues(catCounts, r.cats);
    var siteValues = orderedFacetValues(siteCounts, r.sites);

    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (r.page > pages) r.page = pages;
    var start = (r.page - 1) * PER_PAGE;
    var pageItems = list.slice(start, start + PER_PAGE);

    var activeChips = [];
    r.brands.forEach(function (b) { activeChips.push({ kind: 'brands', value: b, label: '브랜드: ' + b }); });
    r.cats.forEach(function (c) { activeChips.push({ kind: 'cats', value: c, label: '카테고리: ' + c }); });
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
            facetBlock('카테고리', 'cat', catValues, catCounts, r.cats, catGroupFn) +
            '<button class="filter-reset" data-action="reset-filters">필터 초기화</button>' +
          '</div>' +
        '</aside>' +
        '<div>' +
          '<div class="list-toolbar">' +
            '<span class="result-count"><b>' + list.length.toLocaleString('ko-KR') + '</b>건' + (r.q ? ' · “' + esc(r.q) + '”' : '') + '</span>' +
            '<select class="sort-select" id="sortSelect" aria-label="정렬">' +
              '<option value="featured"' + (r.sort === 'featured' ? ' selected' : '') + '>추천순</option>' +
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
    items.push('<button data-page="1"' + (current === 1 ? ' disabled' : '') + ' aria-label="첫 쪽">처음</button>');
    items.push('<button data-page="' + (current - 1) + '"' + (current === 1 ? ' disabled' : '') + ' aria-label="이전 쪽">이전</button>');
    var start = Math.max(1, current - 2);
    var end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    for (var i = start; i <= end; i++) {
      items.push('<button data-page="' + i + '" class="' + (i === current ? 'is-current' : '') + '" aria-current="' + (i === current ? 'page' : 'false') + '">' + i + '</button>');
    }
    items.push('<button data-page="' + (current + 1) + '"' + (current === total ? ' disabled' : '') + ' aria-label="다음 쪽">다음</button>');
    items.push('<button data-page="' + total + '"' + (current === total ? ' disabled' : '') + ' aria-label="끝 쪽">끝</button>');
    return '<nav class="pagination" aria-label="페이지네이션">' +
      '<span class="page-indicator" aria-live="polite">' + current + ' / ' + total + '쪽</span>' +
      items.join('') + '</nav>';
  }

  /* 상세 수량 (#213 D3): −/＋ 스테퍼와 직접 입력. 담기·견적 요청·고정 바의 견적 요청이
     모두 이 값을 쓴다. */
  function readDetailQty() {
    var input = document.getElementById('detailQty');
    if (!input) return 1;
    var n = parseInt(String(input.value).replace(/[^0-9]/g, ''), 10);
    return Math.min(999, Math.max(1, n || 1));
  }
  function stepDetailQty(delta) {
    var input = document.getElementById('detailQty');
    if (!input) return;
    var n = parseInt(String(input.value).replace(/[^0-9]/g, ''), 10) || 1;
    n = Math.min(999, Math.max(1, n + delta));
    input.value = String(n);
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
    // 목록 데이터에는 사양·옵션·전체 이미지가 없다. 상세 진입 때 해당 분할 파일만
    // 읽고, 그동안은 로딩 화면을 보여 준다.
    if (product.shard && !product._detailLoaded) {
      app.innerHTML = '<div class="loading" id="detailLoading">상품 정보를 불러오는 중입니다…</div>';
      loadDetail(product).then(function () { renderDetailBody(product); });
      return;
    }
    renderDetailBody(product);
  }

  function renderDetailBody(product) {
    var price = fmtPrice(product);
    var images = product.images;
    var specRows = (product.specs || []).filter(function (s) { return s.label && s.value; });
    // 타 몰에서 수집된 잔여 UI 문구(배송·옵션 선택 안내)는 사양이 아니다 — 표시 제외.
    var JUNK_SPEC_RE = /정기배송\s*할인|\[필수\]\s*옵션|옵션을 선택해\s*주세요/;
    specRows = specRows.filter(function (s) {
      return !JUNK_SPEC_RE.test(String(s.label)) && !JUNK_SPEC_RE.test(String(s.value));
    });
    // 공급처 사이트의 배송 정책·소비자가·원산지는 CGI 판매 정보가 아니다 — 표시 제외 (#209 A3).
    var SUPPLIER_SPEC_RE = /^(배송비|소비자가|원산지)$/;
    specRows = specRows.filter(function (s) {
      return !SUPPLIER_SPEC_RE.test(String(s.label || '').trim());
    });

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
    // 공급처 상품 페이지로 나가는 링크는 고객 유출 경로라 고객 화면에서 제거한다.
    // (staff 화면과 원본 데이터의 출처 URL은 그대로 보존.)
    var originalLink = '최종 가격·재고는 CGI 확인 후 안내';

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">홈</a><span>›</span><a href="' + esc(listUrl({ q: '', brands: [], cats: [], sites: [] })) + '">상품 목록</a><span>›</span><span>' + esc(product.name) + '</span></div>' +
      '<div class="detail-grid">' +
        '<div>' +
          '<div class="gallery-main">' + mainImg + '</div>' +
          (thumbs ? '<div class="gallery-thumbs">' + thumbs + '</div>' : '') +
        '</div>' +
        '<div>' +
          (splitConditionTag(product.name).tag ? '<div class="detail-flags"><span class="badge cond">' + esc(splitConditionTag(product.name).tag) + '</span></div>' : '') +
          '<h1 class="detail-title">' + esc(splitConditionTag(product.name).name) + '</h1>' +
          '<p class="detail-sub">' +
            esc(brandDisplay(product)) +
            (product.manufacturer && product.manufacturer !== brandDisplay(product) ? ' · 제조사 ' + esc(product.manufacturer) : '') +
            (product.model ? ' · 모델 ' + esc(product.model) : '') +
            ' · ' + esc(product._cat) +
          '</p>' +
          '<div class="detail-price-row">' +
            '<span class="detail-price ' + price.cls + '">' + esc(price.text) + '</span>' +
            '<span class="detail-price-note">' + (price.inquiry
              ? '이 상품의 가격은 담당자 확인 후 안내드립니다.'
              : '가격은 변동될 수 있으며, 최종 견적은 CGI 확인 후 안내합니다.') + '</span>' +
          '</div>' +

          '<div class="detail-block"><h3>추가 서비스 (선택)</h3>' +
            '<p class="detail-price-note">설치·출장·유지보수가 필요하면 선택하세요. 요청 후 담당자가 확인합니다.</p>' +
            '<div class="service-checks">' + servicesHtml('detail') + '</div>' +
          '</div>' +

          '<div class="detail-cta">' +
            '<div class="qty-row">' +
              '<label class="qty-label" for="detailQty">수량</label>' +
              '<div class="qty-stepper">' +
                '<button type="button" class="qty-btn" data-action="qty-step" data-detail-qty-step="-1" aria-label="수량 줄이기">−</button>' +
                '<input type="text" inputmode="numeric" class="qty-input" id="detailQty" value="1" maxlength="3" aria-label="수량">' +
                '<button type="button" class="qty-btn" data-action="qty-step" data-detail-qty-step="1" aria-label="수량 늘리기">＋</button>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="btn btn-primary btn-lg" data-action="quote-now" data-product-id="' + esc(product.id) + '">견적 요청하기</button>' +
            '<button type="button" class="btn btn-secondary btn-lg" data-action="add-to-cart" data-product-id="' + esc(product.id) + '">견적 목록에 추가</button>' +
          '</div>' +
          '<p class="detail-cta-note">견적 요청 시 선택한 서비스가 함께 접수됩니다. 최종 금액은 담당자 확인 후 안내합니다.</p>' +

          (specRows.length ? '<table class="spec-table"><tbody>' + specRows.map(function (s) {
            return '<tr><th>' + esc(s.label) + '</th><td>' + esc(s.value) + '</td></tr>';
          }).join('') + '</tbody></table>' : '') +
          optionsHtml +
          '<div class="detail-block"><h3>판매 정보</h3><div class="source-box"><dl>' +
            '<dt>판매자</dt><dd>(주)시지아이 — 가격·재고·배송은 CGI 담당자 확인 후 안내</dd>' +
            '<dt>배송 안내</dt><dd>배송비·배송 일정은 CGI 기준으로 안내됩니다. 담당자 확인 후 확정됩니다.</dd>' +
            '<dt>카테고리</dt><dd>' + esc(product._cat) + '</dd>' +
          '</dl></div></div>' +
          '<a class="back-link" href="' + esc(listUrl({})) + '">← 목록으로 돌아가기</a>' +
        '</div>' +
      '</div>' +
      '<div class="mobile-cta">' +
        '<div class="mobile-cta-price"><small>가격</small><strong>' + esc(price.text) + '</strong></div>' +
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
    if (!silent) showToast('견적 목록에 추가했습니다.', { label: '견적 목록 보기', href: '#/quote-cart' });
    updateHeaderCartCount();
  }
  function removeFromQuoteCart(productId) {
    state.quoteCart = state.quoteCart.filter(function (x) { return x.id !== productId; });
    saveQuoteCart();
    updateHeaderCartCount();
  }
  function updateQuoteCartQty(productId, qty) {
    qty = Math.max(1, parseInt(qty || '1', 10) || 1);
    for (var i = 0; i < state.quoteCart.length; i++) {
      if (state.quoteCart[i].id === productId) { state.quoteCart[i].qty = qty; break; }
    }
    saveQuoteCart();
    updateHeaderCartCount();
    return qty;
  }
  /* 머리말 장바구니 아이콘 개수 (#209 A4): PC·휴대폰 모두 항상 보인다. */
  function updateHeaderCartCount() {
    var el = document.querySelector('[data-cart-count]');
    if (!el) return;
    var count = cartItemCount(cartItems());
    el.textContent = count > 99 ? '99+' : String(count);
    el.hidden = count === 0;
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
  function cartSummaryText(items) {
    return items.length.toLocaleString('ko-KR') + '개 상품 · 총 ' + cartItemCount(items) + '점';
  }
  /* ---- 주문·결제 분기 (issue #67): 모든 상품이 공개가이면 결제 주문 가능 ---- */
  function isPublicPriced(product) {
    return !!(product && product.price && product.price.state === 'public' &&
      product.price.value !== null && product.price.value !== undefined);
  }
  function allPublicPrice(items) {
    return !!items && items.length > 0 && items.every(function (x) { return isPublicPriced(x.product); });
  }
  function cartTotal(items) {
    return items.reduce(function (sum, x) {
      return isPublicPriced(x.product) ? sum + Number(x.product.price.value) * (x.cart.qty || 1) : sum;
    }, 0);
  }
  function money(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }

  function fmtDateTime(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    try {
      return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toLocaleString('ko-KR');
    }
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
        '<td class="c-price" data-label="가격">' +
          '<span class="cell-label">가격</span>' +
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
        '<p class="page-sub" id="cartSummary">' + cartSummaryText(items) + '</p>' +
      '</header>' +
      '<div class="cart-layout ' + (allPublicPrice(items) ? 'is-payable' : 'is-inquiry') + '">' +
        '<div class="cart-left">' +
        '<div class="cart-main">' +
          '<section class="cart-panel">' +
            '<div class="cart-panel-head"><h2>담은 상품</h2><span>수량을 확인해 주세요</span></div>' +
            '<table class="spec-table cart-table">' +
              '<thead><tr><th>상품</th><th>가격</th><th>수량</th><th><span class="sr-only">삭제</span></th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
            '<details class="cart-summary">' +
              '<summary>요청 내용 미리보기 · 복사</summary>' +
              '<div class="cart-summary-body">' +
                '<pre id="quoteCartText" class="quote-text">' + esc(quoteText) + '</pre>' +
                '<div class="cart-summary-actions">' +
                  '<button type="button" class="btn btn-secondary" data-action="copy-cart">요약 복사</button>' +
                '</div>' +
              '</div>' +
            '</details>' +
          '</section>' +
        '</div>' +
        (allPublicPrice(items)
          ? '<div class="cart-pay-cta is-primary">' +
              '<div class="cart-total-line"><span>주문 금액</span><strong id="cartTotalValue">' + money(cartTotal(items)) + '</strong></div>' +
              '<a class="btn btn-primary btn-block cart-pay-btn" href="#/checkout">결제 주문으로 계속</a>' +
              '<button type="button" class="cart-alt-link" data-scroll-quote-form>견적 요청으로 접수</button>' +
            '</div>'
          : '<div class="cart-pay-cta cart-pay-inquiry">' +
              '<div class="cart-total-line"><span>최종 금액</span><strong>담당자 확인 후 안내</strong></div>' +
              '<p class="form-note">일부 상품이 판매가 미확정 상태라 결제 대신 견적 요청으로 접수됩니다.</p>' +
            '</div>') +
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
              '<div class="form-grid">' +
                '<label>세금계산서 발행 <select name="invoice_type"><option value="">선택 안 함</option><option value="tax_invoice">세금계산서(일반과세)</option><option value="cash_receipt">현금영수증</option></select></label>' +
                '<label>사업자등록번호 <input type="text" name="biz_no" inputmode="numeric" maxlength="12" placeholder="000-00-00000 (세금계산서 시 필수)"></label>' +
                '<label>나라장터 기관코드 <input type="text" name="agency_no" maxlength="40" placeholder="선택 — 관공서·학교·군 구매 담당자"></label>' +
              '</div>' +
              '<p class="form-note">규격서·도면 등 첨부 파일이 있으면 접수 후 담당자 안내 메일로 보내주세요 (이 폼에서는 파일 업로드를 받지 않습니다).</p>' +
              '<label>요청 사항 <textarea name="note" rows="4" placeholder="설치 환경, 일정, 수량 등을 입력하세요."></textarea></label>' +
              '<label class="auth-check"><input type="checkbox" name="privacyConsent"> <span>[필수] 견적 응대 목적의 개인정보(회사·담당자·연락처·설치 장소) 수집·이용에 동의합니다. 목적 외 사용 금지, 문의 후 보관은 담당자 확인 범위로 한정합니다.</span></label>' +
              (allPublicPrice(items)
                ? '<button type="submit" class="btn btn-block cart-quote-submit">견적 요청으로 접수</button>'
                : '<button type="submit" class="btn btn-primary btn-block">견적 요청 보내기</button>') +
              '<p class="form-note">입력하신 정보는 견적 응대 목적으로만 사용됩니다.</p>' +
              '<div id="quoteCartResult" class="quote-result" role="status"></div>' +
            '</form>' +
          '</div>' +
        '</aside>' +
      '</div>' +
      '<a class="back-link" href="#/products">← 상품 더 보기</a>';

    bindServiceInputs('cart');
    var scrollBtn = app.querySelector('[data-scroll-quote-form]');
    if (scrollBtn) scrollBtn.addEventListener('click', function () {
      var target = document.getElementById('quoteCartForm');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
    if (!form.querySelector('input[name="privacyConsent"]').checked) {
      var warn = document.getElementById('quoteCartResult');
      if (warn) warn.innerHTML = '<p class="form-error">개인정보 수집·이용 동의(필수)에 체크해 주세요.</p>';
      return;
    }
    var invoiceType = String(data.get('invoice_type') || '');
    var bizNo = String(data.get('biz_no') || '').replace(/[^0-9]/g, '');
    if (invoiceType === 'tax_invoice' && bizNo.length !== 10) {
      var warn2 = document.getElementById('quoteCartResult');
      if (warn2) warn2.innerHTML = '<p class="form-error">세금계산서 발행에는 사업자등록번호 10자리가 필요합니다.</p>';
      return;
    }
    var request = {
      id: 'Q-' + Date.now(),
      createdAt: new Date().toISOString(),
      company: data.get('company') || '',
      name: data.get('name') || '',
      phone: data.get('phone') || '',
      email: data.get('email') || '',
      location: data.get('location') || '',
      note: data.get('note') || '',
      privacy_consent: true,
      invoice_type: invoiceType || null,
      biz_no: bizNo || null,
      agency_no: String(data.get('agency_no') || '').trim() || null,
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
      if (result) result.innerHTML = '<div class="' + (cls || 'result-ok') + '">' + message + '</div>';
    };
    var setBusy = function (busy) {
      if (!submit) return;
      submit.disabled = busy;
      submit.textContent = busy ? '접수 중…' : '견적 요청 보내기';
    };

    if (apiUrl) {
      setBusy(true);
      // 로그인 회원은 /api/me/quotes 로 접수해 회원 계정에 연결된다.
      var isMember = !!(window.CGI_AUTH && window.CGI_AUTH.isLoggedIn());
      var quoteInit = {
        method: 'POST',
        headers: isMember
          ? { 'Content-Type': 'application/json', 'X-CSRF-Token': window.location.origin }
          : { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      };
      if (isMember) quoteInit.credentials = 'include';
      fetch(apiUrl + (isMember ? '/api/me/quotes' : '/api/quotes'), quoteInit).then(function (res) {
        if (!res.ok) {
          // 403 email not verified must not fall through to the local-storage
          // "saved on this browser" path: the request never reached the server.
          return res.json().catch(function () { return {}; }).then(function (data) {
            var err = new Error((data && data.error) || ('HTTP ' + res.status));
            err.status = res.status;
            err.data = data || {};
            throw err;
          });
        }
        return res.json();
      }).then(function (response) {
        request.id = response.id || request.id;
        window.cgiLastQuoteCartRequest = request;
        done(
          '<p class="receipt-title">견적 요청이 접수되었습니다.</p>' +
          '<p class="receipt-no"><span>접수번호</span><strong>' + esc(request.id) + '</strong></p>' +
          '<div class="receipt-actions">' +
            '<button type="button" class="btn btn-secondary btn-small" data-action="copy-receipt">접수번호 복사</button>' +
            '<span class="receipt-time">' + esc(fmtDateTime(request.createdAt)) + ' 접수</span>' +
          '</div>' +
          '<p class="receipt-note">담당자가 내용을 확인한 뒤 입력하신 연락처로 안내드립니다.</p>'
        );
      }).catch(function (err) {
        if (err && err.data && err.data.error === 'email not verified') {
          done('<p class="form-error">인증 메일을 확인해 주세요. 메일함의 인증 링크를 누른 뒤 다시 요청해 주세요.</p>' +
            '<p><a class="btn btn-secondary btn-small" href="#/auth/verify">인증 메일 재전송</a></p>', 'result-warn');
          return;
        }
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
        ' | 수량 ' + x.cart.qty + ' | 가격 ' + priceText(p));
    });
    lines.push('');
    lines.push('※ 최종 금액은 CGI 담당자가 확인 후 안내합니다.');
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
          '<li>가격은 변동될 수 있으며, 최종 판매가는 담당자 확인 후 안내됩니다.</li>' +
          '<li>가격이 표시되지 않은 상품은 <strong>가격 문의</strong>로 확인하실 수 있습니다.</li>' +
          '<li>재고·배송 일정은 담당자 확인 후 안내드립니다.</li>' +
        '</ul>' +
        '<h2>바로 구매 (가격 공개 상품)</h2>' +
        '<ul>' +
          '<li>가격이 공개된 상품은 <strong>담기 → 결제 주문 → 결제</strong> 흐름으로 바로 주문하실 수 있습니다.</li>' +
          '<li>상품 상세에서 수량과 추가 서비스를 정해 <strong>견적 목록에 추가</strong>를 누릅니다.</li>' +
          '<li>견적 목록에서 주문 금액을 확인하고 <strong>결제 주문으로 계속</strong>을 누르면 주문이 만들어집니다.</li>' +
          '<li>주문 화면에서 결제 수단을 선택해 결제를 진행합니다. 결제 완료 후 주문 내역에서 확인할 수 있습니다.</li>' +
        '</ul>' +
        '<h2>견적 요청 방법</h2>' +
        '<ul>' +
          '<li>상품 상세에서 수량과 추가 서비스를 확인한 뒤 <strong>견적 요청하기</strong>를 선택합니다.</li>' +
          '<li>견적 목록에서 회사·담당자 정보를 입력하고 요청을 보냅니다.</li>' +
          '<li>담당자가 내용을 확인한 뒤 연락드립니다.</li>' +
        '</ul>' +
        '<h2>문의</h2>' +
        companyContactHtml() +
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
    var route = { view: 'home', q: '', brands: [], cats: [], sites: [], sort: 'featured', page: 1, id: null };
    if (parts[0] === 'products') {
      route.view = 'list';
      route.q = params.get('q') || '';
      route.brands = (params.get('brand') || '').split('|').filter(Boolean);
      route.cats = (params.get('cat') || '').split('|').filter(Boolean);
      route.sites = (params.get('site') || '').split('|').filter(Boolean);
      route.sort = params.get('sort') || 'featured';
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
    } else if (parts[0] === 'checkout') {
      route.view = 'checkout';
    } else if (parts[0] === 'order' && parts[1]) {
      route.view = 'order';
      route.id = decodeURIComponent(parts[1]);
    } else if (parts[0] === 'about') {
      route.view = 'about';
    } else if (parts[0] === 'login') {
      route.view = 'login';
    } else if (parts[0] === 'signup') {
      route.view = 'signup';
    } else if (parts[0] === 'forgot-password') {
      route.view = 'forgot-password';
    } else if (parts[0] === 'my-page') {
      route.view = 'my-page';
      route.tab = parts[1] || 'profile';
    } else if (parts[0] === 'auth' && parts[1] === 'verify') {
      route.view = 'auth-verify';
    } else if (parts[0] === 'auth' && parts[1] === 'reset') {
      route.view = 'auth-reset';
    } else if (parts[0] === 'auth' && parts[1] === 'google-consent') {
      route.view = 'google-consent';
      route.token = params.get('token') || '';
    }
    return route;
  }

  function authHeaderEl() {
    var guest = document.querySelector('[data-auth-guest]');
    var member = document.querySelector('.auth-links-member');
    var logged = !!(window.CGI_AUTH && window.CGI_AUTH.isLoggedIn());
    var nodes = document.querySelectorAll('[data-auth-guest]');
    for (var i = 0; i < nodes.length; i++) nodes[i].hidden = logged;
    if (member) member.hidden = !logged;
    if (logged) {
      var user = window.CGI_AUTH.me();
      var nameEl = document.querySelector('[data-auth-name]');
      if (nameEl && user) nameEl.textContent = user.name || user.email || '회원';
      var badgeEl = document.querySelector('[data-auth-verified-badge]');
      if (badgeEl && user) {
        var verified = user.email_verified;
        badgeEl.textContent = verified ? '인증됨' : '인증 대기';
        badgeEl.className = verified ? 'auth-badge-verified' : 'auth-badge-unverified';
        badgeEl.hidden = false;
        badgeEl.href = verified ? '#/my-page/profile' : '#/auth/verify';
      }
    }
    return logged;
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
    }     else if (view === 'quote-cart') title = '견적 목록 | CGI';
    else if (view === 'quote') title = '견적 요청 | CGI';
    else if (view === 'checkout') title = '주문 접수 | CGI';
    else if (view === 'order') title = '주문 상세 | CGI';
    else if (view === 'about') title = '이용 안내 | CGI';
    document.title = title;
  }

  function render() {
    var nicepayHandled = window.CGI_ORDER && typeof window.CGI_ORDER.handleNicepayRedirect === 'function' && window.CGI_ORDER.handleNicepayRedirect(app);
    if (nicepayHandled) {
      applySiteConfig();
      updateHeader();
      updateTitle();
      return;
    }
    state.route = parseHash();
    hideToast(); // 화면이 바뀌면 담기 안내를 지운다 (#209 A4)
    applySiteConfig();
    updateHeader();
    updateHeaderCartCount();
    var view = state.route.view;
    if (view === 'home') renderHome();
    else if (view === 'list') renderList();
    else if (view === 'detail') renderDetail(state.route.id);
    else if (view === 'quote') renderQuote(state.route.id, state.route.services || []);
    else if (view === 'quote-cart') renderQuoteCart();
    else if (view === 'checkout' && window.CGI_ORDER) window.CGI_ORDER.renderCheckout(app);
    else if (view === 'order' && window.CGI_ORDER) window.CGI_ORDER.renderOrderDetail(app, state.route.id);
    else if (view === 'login') renderLogin(app);
    else if (view === 'signup') renderSignup(app);
    else if (view === 'forgot-password') renderForgotPassword(app);
    else if (view === 'auth-verify') renderAuthVerify(app);
    else if (view === 'auth-reset') renderAuthReset(app);
    else if (view === 'google-consent') renderGoogleConsent(app);
    else if (view === 'my-page') renderMyPage(app);
    else renderAbout();
    // 뷰 렌더로 새로 만들어진 [data-home-link](이용 안내 등)에도 정본 URL을 적용한다.
    applySiteConfig();
    if (view !== 'login' && view !== 'signup') window.cgiSyncAuthHeader && window.cgiSyncAuthHeader();
    updateTitle();
    document.body.setAttribute('data-view', view);
    if (lastView !== view) {
      window.scrollTo(0, 0);
      lastView = view;
    }
  }

  /* ------------------------------------------- 쇼핑몰 ↔ 홈페이지 연결 설정 */
  function applySiteConfig() {
    var cfg = window.CGI_SITE_CONFIG || {};
    renderLegalInfo(cfg);
    if (!cfg.homepageUrl) return;
    var links = document.querySelectorAll('[data-home-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('href', cfg.homepageUrl);
    }
  }

  /* 전자상거래법 필수 표기(사업자등록번호·통신판매업신고·개인정보보호책임자).
     값은 config.js legal 블록에서 주입된다. 확정된 항목만 표기하고, 비어 있는 항목은
     "확인 예정" 같은 자리 문구 없이 그 항목 자체를 만들지 않는다(2026-11-03 대표 결정). */
  function renderLegalInfo(cfg) {
    var el = document.querySelector('[data-legal-info]');
    if (!el) return;
    var legal = cfg.legal || {};
    function text(v) { return String(v || '').trim(); }
    var bizRegNo = text(legal.bizRegNo);
    var mailOrderNo = text(legal.mailOrderNo);
    var mailOrderEl = document.querySelector('[data-mail-order-no]');
    var mailOrderRow = document.querySelector('[data-mail-order-row]');
    var officerName = text(legal.privacyOfficerName);
    var officerPhone = text(legal.privacyOfficerPhone);
    var officerEmail = text(legal.privacyOfficerEmail);
    if (mailOrderEl) mailOrderEl.textContent = mailOrderNo;
    if (mailOrderRow) mailOrderRow.hidden = !mailOrderNo;
    var parts = ['© 주식회사 시지아이'];
    if (bizRegNo) parts.push('사업자등록번호 ' + esc(bizRegNo));
    if (mailOrderNo) parts.push('통신판매업신고 ' + esc(mailOrderNo));
    var officerContact = [officerPhone, officerEmail].filter(Boolean).join(', ');
    if (officerName) parts.push('개인정보보호책임자 ' + esc(officerName + (officerContact ? ' (' + officerContact + ')' : '')));
    parts.push('<a href="terms.html" style="color:inherit">이용약관</a>');
    parts.push('<a href="privacy.html" style="color:inherit">개인정보처리방침</a>');
    parts.push('<a href="returns.html" style="color:inherit">교환·반품·환불 안내</a>');
    el.innerHTML = parts.join(' · ');
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
      if (action === 'logout') {
        (window.CGI_AUTH ? window.CGI_AUTH.logout() : Promise.resolve(true)).then(function () {
          window.cgiSyncAuthHeader && window.cgiSyncAuthHeader();
          showToast('로그아웃했습니다.');
          navigate('#/');
        });
        return;
      }
      if (action === 'delete-account') {
        if (!window.confirm('정말 계정을 삭제할까요? 모든 배송지와 세션이 함께 삭제됩니다.')) return;
        (window.CGI_AUTH ? window.CGI_AUTH.deleteAccount() : Promise.resolve(false)).then(function (ok) {
          if (ok) {
            window.cgiSyncAuthHeader && window.cgiSyncAuthHeader();
            showToast('계정이 삭제되었습니다.');
            navigate('#/');
          } else {
            showToast('계정 삭제에 실패했습니다. 진행 중인 주문이 있는지 확인하세요.');
          }
        });
        return;
      }
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
      if (action === 'qty-step') {
        stepDetailQty(Number(target.getAttribute('data-detail-qty-step')) || 0);
        return;
      }
      if (action === 'add-to-cart' && productId) {
        addToQuoteCart(productId, readDetailQty());
        return;
      }
      if (action === 'quote-now' && productId) {
        addToQuoteCart(productId, readDetailQty(), true);
        state.quoteCartServices = (state.quoteServices || []).slice();
        saveQuoteCartServices();
        navigate('#/quote-cart');
        return;
      }
      if (action === 'copy-cart') { window.cgiCopyQuoteCart(); return; }
      if (action === 'copy-receipt') { window.cgiCopyReceiptNumber(); return; }
      if (action === 'toggle-quote') { toggleQuoteDetail(target); return; }
      if (action === 'reload-quotes') { renderMyQuotes(document.getElementById('myPageBody')); return; }
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
    // 미리보기·헤더 집계·주문 금액은 모두 같은 상태에서 계산해 함께 그려야 한다.
    var items = cartItems();
    var text = buildQuoteCartText(items);
    var pre = document.getElementById('quoteCartText');
    if (pre) pre.textContent = text;
    window.cgiLastQuoteCartText = text;
    var summary = document.getElementById('cartSummary');
    if (summary) summary.textContent = cartSummaryText(items);
    var total = document.getElementById('cartTotalValue');
    if (total) total.textContent = money(cartTotal(items));
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

  /* ------------------------------------------- customer account views (#69) */
  var AUTH = window.CGI_AUTH || null;

  function authApi() { return AUTH; }

  window.cgiSyncAuthHeader = function () {
    if (!authApi()) return;
    var headerNav = document.querySelector('#siteNav');
    var current = state.route.view;
    if (current === 'login' || current === 'signup') {
      var links = document.querySelectorAll('[data-auth-guest], .auth-links-member');
      for (var i = 0; i < links.length; i++) links[i].hidden = true;
      return;
    }
    if (authApi().isLoggedIn()) {
      var guest = document.querySelectorAll('[data-auth-guest]');
      for (var g = 0; g < guest.length; g++) guest[g].hidden = true;
      var member = document.querySelector('.auth-links-member');
      if (member) member.hidden = false;
      var u = authApi().me();
      var nameEl = document.querySelector('[data-auth-name]');
      if (nameEl && u) nameEl.textContent = u.name || u.email || '회원';
      var adminLinks = document.querySelectorAll('[data-auth-admin]');
      var isAdmin = !!(u && (u.role === 'admin' || u.role === 'superadmin' || u.is_admin));
      for (var a = 0; a < adminLinks.length; a++) adminLinks[a].hidden = !isAdmin;
      var badgeEl = document.querySelector('[data-auth-verified-badge]');
      if (badgeEl && u) {
        var verified = u.email_verified;
        badgeEl.textContent = verified ? '인증됨' : '인증 대기';
        badgeEl.className = verified ? 'auth-badge-verified' : 'auth-badge-unverified';
        badgeEl.hidden = false;
        badgeEl.href = verified ? '#/my-page/profile' : '#/auth/verify';
      }
      var navLinks = document.querySelectorAll('.header-nav a[data-nav="my-page"]');
      for (var n = 0; n < navLinks.length; n++) {
        navLinks[n].hidden = false;
        navLinks[n].classList.toggle('is-active', current === 'my-page');
      }
    } else {
      var loggedOut = document.querySelectorAll('[data-auth-guest]');
      for (var l = 0; l < loggedOut.length; l++) loggedOut[l].hidden = false;
      var memberHidden = document.querySelector('.auth-links-member');
      if (memberHidden) memberHidden.hidden = true;
      var badgeHidden = document.querySelector('[data-auth-verified-badge]');
      if (badgeHidden) badgeHidden.hidden = true;
      var myNav = document.querySelectorAll('.header-nav a[data-nav="my-page"]');
      for (var m = 0; m < myNav.length; m++) { myNav[m].hidden = true; myNav[m].classList.remove('is-active'); }
    }
  };

  function authShell(title, inner, wide) {
    return '<section class="auth-page' + (wide ? ' auth-wide' : '') + '">' +
      '<div class="auth-card">' +
        '<h2>' + esc(title) + '</h2>' +
        inner +
      '</div>' +
    '</section>';
  }

  function authAlert(message, type) {
    if (!message) return '';
    return '<p class="auth-alert auth-alert-' + (type || 'error') + '">' + esc(message) + '</p>';
  }

  function authField(labelText, name, type, value, opts) {
    opts = opts || {};
    var attrs = 'name="' + esc(name) + '" type="' + esc(type) + '"';
    if (value) attrs += ' value="' + esc(value) + '"';
    if (opts.required !== false) attrs += ' required';
    if (opts.autocomplete) attrs += ' autocomplete="' + esc(opts.autocomplete) + '"';
    if (opts.placeholder) attrs += ' placeholder="' + esc(opts.placeholder) + '"';
    if (opts.maxLength) attrs += ' maxlength="' + esc(opts.maxLength) + '"';
    if (opts.min) attrs += ' minlength="' + esc(opts.min) + '"';
    return '<label class="auth-field">' +
      '<span class="auth-label">' + esc(labelText) + '</span>' +
      '<input class="auth-input" ' + attrs + '>' +
      (opts.hint ? '<small class="auth-hint">' + (opts.hint.charAt(0) === '<' ? opts.hint : esc(opts.hint)) + '</small>' : '') +
    '</label>';
  }

  function renderAuthPage(app) {
    var p = authApi();
    app.innerHTML = authShell('로그인',
      authAlert(!p ? '로그인 서비스를 사용할 수 없습니다. API 주소를 확인하세요.' : '') +
      '<p class="auth-muted">회원가입이 필요해요. 로그인하시면 주문 내역과 배송지를 관리할 수 있어요.</p>' +
      '<a class="btn btn-primary btn-block" href="#/signup">회원가입</a>', true);
  }

  function renderLogin(app) {
    var p = authApi();
    if (p && p.isLoggedIn()) { navigate('#/'); return; }
    var html = authShell('로그인',
      '<form id="loginForm" class="auth-form" novalidate>' +
        authField('이메일', 'email', 'email', '', { autocomplete: 'email', required: true }) +
        authField('비밀번호', 'password', 'password', '', { autocomplete: 'current-password', required: true }) +
        '<button type="submit" class="btn btn-primary btn-block" data-auth-submit="login">로그인</button>' +
      '</form>' +
      '<div class="auth-divider"><span>또는</span></div>' +
      '<button type="button" class="btn btn-google btn-block" data-auth-submit="google">' +
        '<svg viewBox="0 0 24 24"><path d="M12 11h3.02c.69-1.02 1.42-1.58 2.44-1.64v-2.87c-1.13-.12-2.61.38-3.8 1.66L12 6.6v4.4z" fill="#4285F4"/><path d="M11.4 14.5l-3.5 2.5c-1.17-.82-1.92-2.24-1.92-3.89 0-.7.18-1.38.5-1.97L2.56 7.6A8.5 8.5 0 0 0 1 12.1c0 4.1 2.9 7.53 6.8 8.35l4.6-5.95z" fill="#34A853"/><path d="M20.1 8.5c-.38-.7-.86-1.32-1.42-1.83L15.9 5.6 11.4 8.1l4.2 3.2c.9-.5 1.5-1.36 1.76-2.4l2.74-1.4z" fill="#FBBC05"/><path d="M11.4 14.5l4.2 3.2c1.6-.9 2.8-2.4 3.2-4.1.24-1 .18-2-.1-2.9h-3.1c-.14 1.5-.87 2.6-1.7 3.2l-2.5-.4z" fill="#EA4335"/></svg>' +
        'Google로 계속하기' +
      '</button>' +
      '<div class="auth-alt">' +
        '<a href="#/forgot-password">비밀번호를 잊어버렸어요</a> · <a href="#/signup">회원가입</a>' +
      '</div>', true);
    app.innerHTML = html;
    var form = document.getElementById('loginForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var email = form.elements.email.value.trim();
        var password = form.elements.password.value;
        var submit = form.querySelector('[data-auth-submit="login"]');
        if (!email || !password) { showToast('이메일과 비밀번호를 입력해 주세요.'); return; }
        submit.disabled = true;
        submit.textContent = '로그인 중…';
        p.login({ email: email, password: password }).then(function (ok) {
          submit.disabled = false;
          submit.textContent = '로그인';
          if (!ok) {
            app.innerHTML = authShell('로그인',
              authAlert('이메일 또는 비밀번호가 올바르지 않습니다.', 'error') +
              '<form id="loginForm" class="auth-form">' +
                authField('이메일', 'email', 'email', email) +
                authField('비밀번호', 'password', 'password', '') +
                '<button type="submit" class="btn btn-primary btn-block" data-auth-submit="login">다시 로그인</button>' +
              '</form>' +
              '<div class="auth-divider"><span>또는</span></div>' +
              '<button type="button" class="btn btn-google btn-block" data-auth-submit="google">' +
                '<svg viewBox="0 0 24 24"><path d="M12 11h3.02c.69-1.02 1.42-1.58 2.44-1.64v-2.87c-1.13-.12-2.61.38-3.8 1.66L12 6.6v4.4z" fill="#4285F4"/><path d="M11.4 14.5l-3.5 2.5c-1.17-.82-1.92-2.24-1.92-3.89 0-.7.18-1.38.5-1.97L2.56 7.6A8.5 8.5 0 0 0 1 12.1c0 4.1 2.9 7.53 6.8 8.35l4.6-5.95z" fill="#34A853"/><path d="M20.1 8.5c-.38-.7-.86-1.32-1.42-1.83L15.9 5.6 11.4 8.1l4.2 3.2c.9-.5 1.5-1.36 1.76-2.4l2.74-1.4z" fill="#FBBC05"/><path d="M11.4 14.5l4.2 3.2c1.6-.9 2.8-2.4 3.2-4.1.24-1 .18-2-.1-2.9h-3.1c-.14 1.5-.87 2.6-1.7 3.2l-2.5-.4z" fill="#EA4335"/></svg>' +
                'Google로 계속하기' +
              '</button>' +
              '<div class="auth-alt"><a href="#/forgot-password">비밀번호를 잊어버렸어요</a> · <a href="#/signup">회원가입</a></div>', true);
            rebindLogin(app);
            rebindGoogle(app);
            return;
          }
          window.cgiSyncAuthHeader();
          showToast('로그인했습니다.');
          navigate('#/');
        });
      });
    }
    rebindGoogle(app);
  }

  function rebindGoogle(app) {
    var btn = app.querySelector('[data-auth-submit="google"]');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Google로 로그인 중…';
      authApi().googleLogin();
    });
  }

  function renderSignup(app) {
    var p = authApi();
    app.innerHTML = authShell('회원가입',
      '<form id="signupForm" class="auth-form" novalidate>' +
        authField('이메일', 'email', 'email', '', { autocomplete: 'email', hint: '<span data-email-check></span>' }) +
        authField('성명', 'name', 'text', '', { autocomplete: 'name', maxLength: 40 }) +
        authField('연락처', 'phone', 'tel', '', { autocomplete: 'tel', required: false, placeholder: '010-0000-0000' }) +
        authField('회사명 (선택)', 'company', 'text', '', { autocomplete: 'organization', required: false, maxLength: 100 }) +
        authField('비밀번호', 'password', 'password', '', { autocomplete: 'new-password', min: 8 }) +
        authField('비밀번호 확인', 'password2', 'password', '', { autocomplete: 'new-password' }) +
        '<p class="auth-hint">비밀번호는 8자 이상이며 영문·숫자·기호를 모두 포함해야 합니다.</p>' +
        '<div class="auth-consent">' +
          '<label class="auth-check"><input type="checkbox" name="agreeTerms"> <span>[필수] <a href="terms.html" target="_blank" rel="noopener">이용약관</a>에 동의합니다.</span></label>' +
          '<label class="auth-check"><input type="checkbox" name="agreePrivacy"> <span>[필수] <a href="privacy.html" target="_blank" rel="noopener">개인정보 수집·이용 안내</a>에 동의합니다.</span></label>' +
        '</div>' +
        '<button type="submit" class="btn btn-primary btn-block" data-auth-submit="signup">회원가입</button>' +
      '</form>' +
      '<div class="auth-divider"><span>또는</span></div>' +
      '<button type="button" class="btn btn-google btn-block" data-auth-submit="google">' +
        '<svg viewBox="0 0 24 24"><path d="M12 11h3.02c.69-1.02 1.42-1.58 2.44-1.64v-2.87c-1.13-.12-2.61.38-3.8 1.66L12 6.6v4.4z" fill="#4285F4"/><path d="M11.4 14.5l-3.5 2.5c-1.17-.82-1.92-2.24-1.92-3.89 0-.7.18-1.38.5-1.97L2.56 7.6A8.5 8.5 0 0 0 1 12.1c0 4.1 2.9 7.53 6.8 8.35l4.6-5.95z" fill="#34A853"/><path d="M20.1 8.5c-.38-.7-.86-1.32-1.42-1.83L15.9 5.6 11.4 8.1l4.2 3.2c.9-.5 1.5-1.36 1.76-2.4l2.74-1.4z" fill="#FBBC05"/><path d="M11.4 14.5l4.2 3.2c1.6-.9 2.8-2.4 3.2-4.1.24-1 .18-2-.1-2.9h-3.1c-.14 1.5-.87 2.6-1.7 3.2l-2.5-.4z" fill="#EA4335"/></svg>' +
        'Google로 계속하기' +
      '</button>', true);
    var form = document.getElementById('signupForm');
    if (!form) return;
    var emailInput = form.elements.email;
    var checkEl = form.querySelector('[data-email-check]');
    var timer = null;
    emailInput.addEventListener('input', function () {
      clearTimeout(timer);
      var value = emailInput.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { checkEl.textContent = ''; return; }
      timer = setTimeout(function () {
        p.emailAvailable(value).then(function (available) {
          if (emailInput.value.trim() !== value) return;
          checkEl.textContent = available === null ? '' : (available ? '사용 가능한 이메일이에요.' : '이미 가입된 이메일이에요.');
        });
      }, 500);
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var submit = form.querySelector('[data-auth-submit="signup"]');
      var password = form.elements.password.value;
      if (password !== form.elements.password2.value) {
        showToast('비밀번호가 서로 일치하지 않습니다.');
        return;
      }
      var agreeTerms = form.elements.agreeTerms;
      var agreePrivacy = form.elements.agreePrivacy;
      if (!agreeTerms || !agreePrivacy || !agreeTerms.checked || !agreePrivacy.checked) {
        showToast('이용약관과 개인정보 수집·이용 동의가 필요합니다.');
        return;
      }
      submit.disabled = true;
      submit.textContent = '가입 처리 중…';
      p.signUp({
        email: form.elements.email.value.trim(),
        name: form.elements.name.value.trim(),
        phone: form.elements.phone.value.trim(),
        company: form.elements.company.value.trim(),
        password: password,
        terms: true,
        privacy: true,
        terms_version: 'draft-2026-10-28',
        privacy_version: 'draft-2026-10-28'
      }).then(function (member) {
        submit.disabled = false;
        submit.textContent = '회원가입';
        if (!member) { showToast('가입에 실패했습니다. 이메일이 이미 사용되었는지 확인하세요.'); return; }
        window.cgiSyncAuthHeader();
        navigate('#/auth/verify');
      });
    });
    rebindGoogle(app);
  }

  function renderAuthVerify(app) {
    var p = authApi();
    var params = new URLSearchParams((location.hash || '').split('?')[1] || '');
    var token = params.get('token');
    if (token) {
      app.innerHTML = authShell('이메일 인증 중…',
        '<div style="text-align:center;padding:24px 0">' +
          '<div style="width:48px;height:48px;border:4px solid #e8eaf6;border-top-color:#1a73e8;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px"></div>' +
          '<p class="auth-muted">링크로 넘어온 토큰을 확인하고 있어요.</p>' +
        '</div>', true);
      p.verifyEmail(token).then(function (ok) {
        if (ok) {
          app.innerHTML = authShell('인증 완료',
            '<div style="text-align:center;padding:24px 0">' +
              '<div style="width:56px;height:56px;border-radius:50%;background:#4caf50;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
              '</div>' +
              '<h2 style="color:#4caf50;margin:0 0 8px;font-size:20px">이메일 인증 완료</h2>' +
              '<p class="auth-muted">계정이 활성화되었어요. 이제 모든 기능을 사용할 수 있어요.</p>' +
              '<a class="btn btn-primary btn-block" href="#/">쇼핑몰로 돌아가기</a>' +
            '</div>', true);
          window.cgiSyncAuthHeader();
          showToast('이메일 인증이 완료됐어요.');
        } else {
          app.innerHTML = authShell('인증 오류',
            '<div style="text-align:center;padding:16px 0">' +
              '<div style="width:56px;height:56px;border-radius:50%;background:#f44336;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
              '</div>' +
              '<h2 style="color:#f44336;margin:0 0 8px;font-size:20px">인증 실패</h2>' +
              '<p class="auth-muted">인증 링크가 유효하지 않거나 이미 사용되었거나 만료되었어요.</p>' +
              '<p class="auth-muted">로그인한 상태라면 새 인증 메일을 재전송할 수 있어요.</p>' +
              '<a class="btn btn-primary btn-block" href="#/login">로그인</a>' +
              '<a class="btn btn-block" style="margin-top:8px;background:#fff;color:#333;border:1px solid #e0e0e0" href="#/auth/verify">재전송하기</a>' +
            '</div>', true);
        }
      });
      return;
    }
    // No token: show the resend / status screen
    var user = p.isLoggedIn() ? p.me() : null;
    var email = user ? user.email : '';
    var verified = p.isLoggedIn() && p.emailVerified();
    var html;
    if (verified) {
      html = authShell('이메일 인증 상태',
        '<div style="text-align:center;padding:16px 0">' +
          '<div style="width:56px;height:56px;border-radius:50%;background:#4caf50;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</div>' +
          '<h2 style="color:#4caf50;margin:0 0 8px;font-size:20px">이메일 인증 완료</h2>' +
          '<p class="auth-muted">' + esc(email) + ' 계정은 인증된 상태예요.</p>' +
          '<a class="btn btn-primary btn-block" href="#/">쇼핑몰로 돌아가기</a>' +
        '</div>', true);
    } else if (p.isLoggedIn() && !p.emailVerified()) {
      html = authShell('이메일 인증 필요해요',
        '<div style="text-align:center;padding:16px 0">' +
          '<div style="width:56px;height:56px;border-radius:50%;background:#ff9800;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>' +
          '</div>' +
          '<h2 style="margin:0 0 8px;font-size:20px">이메일 인증을 완료해주세요</h2>' +
          '<p class="auth-muted">' + esc(email) + ' 으로 인증 메일을 보냈어요.</p>' +
          '<p class="auth-muted">메일함과 스팸 폴더를 확인해 주세요.</p>' +
          '<button type="button" class="btn btn-primary btn-block" data-action="resend-verification" style="margin-top:16px">인증 메일 재전송</button>' +
          '<p class="auth-hint" data-resend-info style="margin-top:8px;min-height:1.2em"></p>' +
        '</div>', true);
    } else {
      html = authShell('이메일 인증 필요해요',
        '<div style="text-align:center;padding:16px 0">' +
          '<div style="width:56px;height:56px;border-radius:50%;background:#ff9800;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>' +
          '</div>' +
          '<h2 style="margin:0 0 8px;font-size:20px">이메일 인증을 완료해주세요</h2>' +
          '<p class="auth-muted">가입이 완료됐어요. 이메일을 확인하고 인증 링크를 눌러 주세요.</p>' +
          '<p class="auth-muted">메일함과 스팸 폴더를 확인해 주세요.</p>' +
          '<a class="btn btn-primary btn-block" href="#/login" style="margin-top:16px">로그인하고 재전송하기</a>' +
        '</div>', true);
    }
    app.innerHTML = html;
    var resend = app.querySelector('[data-action="resend-verification"]');
    if (resend) {
      var resendInfo = app.querySelector('[data-resend-info]');
      resend.addEventListener('click', function () {
        resend.disabled = true;
        resend.textContent = '전송 중…';
        p.resendVerification().then(function (res) {
          if (!res) {
            resend.disabled = false;
            resend.textContent = '인증 메일 재전송';
            showToast('재전송에 실패했어요. 나중에 다시 시도해 주세요.');
            return;
          }
          if (res.retry_after_seconds) {
            var wait = res.retry_after_seconds;
            resendInfo.textContent = wait + '초 후 재전송할 수 있어요.';
            var interval = setInterval(function () {
              wait--;
              if (wait <= 0) {
                clearInterval(interval);
                resend.disabled = false;
                resend.textContent = '인증 메일 재전송';
                resendInfo.textContent = '';
              } else {
                resendInfo.textContent = wait + '초 후 재전송할 수 있어요.';
              }
            }, 1000);
            return;
          }
          resend.disabled = false;
          resend.textContent = '인증 메일 재전송';
          if (res.mail && res.mail.echo_token) {
            showToast('토큰이 API 응답에 담겼어요 (개발 환경).');
          } else if (res.mail && res.mail.delivered) {
            showToast('인증 메일을 보냈어요. 메일함을 확인해 주세요.');
          } else {
            showToast('인증 메일을 전송했어요. 메일함을 확인해 주세요.');
          }
          if (res.resend_cooldown_seconds) {
            var cd = res.resend_cooldown_seconds;
            resendInfo.textContent = cd + '초 후 재전송할 수 있어요.';
            var cdInterval = setInterval(function () {
              cd--;
              if (cd <= 0) {
                clearInterval(cdInterval);
                resend.disabled = false;
                resend.textContent = '인증 메일 재전송';
                resendInfo.textContent = '';
              } else {
                resend.disabled = true;
                resendInfo.textContent = cd + '초 후 재전송할 수 있어요.';
              }
            }, 1000);
            resend.disabled = true;
          }
        });
      });
    }
  }

  /** Google 최초 로그인 동의 화면 — 동의 전에는 서버에 회원이 만들어지지 않는다. */
  function renderGoogleConsent(app) {
    var p = authApi();
    var token = state.route.token || '';
    if (!p) {
      app.innerHTML = authShell('Google 가입 동의',
        authAlert('로그인 서비스를 사용할 수 없습니다. API 주소를 확인하세요.', 'error'), true);
      return;
    }
    if (!token) {
      app.innerHTML = authShell('Google 가입 동의',
        authAlert('동의 링크가 올바르지 않습니다. Google 로그인을 다시 시도해 주세요.', 'error') +
        '<a class="btn btn-primary btn-block" href="#/login">로그인으로 돌아가기</a>', true);
      return;
    }
    app.innerHTML = authShell('Google 가입 동의',
      '<p class="auth-muted">Google 계정으로 처음 방문하셨어요. 가입을 마치려면 아래 두 항목에 동의해 주세요.</p>' +
      '<div class="auth-consent">' +
        '<label class="auth-check"><input type="checkbox" name="agreeTerms"> <span>[필수] <a href="terms.html" target="_blank" rel="noopener">이용약관</a>에 동의합니다.</span></label>' +
        '<label class="auth-check"><input type="checkbox" name="agreePrivacy"> <span>[필수] <a href="privacy.html" target="_blank" rel="noopener">개인정보 수집·이용 안내</a>에 동의합니다.</span></label>' +
      '</div>' +
      '<div id="googleConsentStatus"></div>' +
      '<button type="button" class="btn btn-primary btn-block" id="googleConsentSubmit" disabled>동의하고 가입 완료</button>' +
      '<div class="auth-alt"><a href="#/login">취소</a></div>', true);

    var terms = app.querySelector('input[name="agreeTerms"]');
    var privacy = app.querySelector('input[name="agreePrivacy"]');
    var submit = app.querySelector('#googleConsentSubmit');
    var status = app.querySelector('#googleConsentStatus');
    function sync() { submit.disabled = !(terms.checked && privacy.checked); }
    terms.addEventListener('change', sync);
    privacy.addEventListener('change', sync);
    submit.addEventListener('click', function () {
      if (!terms.checked || !privacy.checked) {
        status.innerHTML = authAlert('이용약관과 개인정보 수집·이용 동의가 필요합니다.', 'error');
        return;
      }
      submit.disabled = true;
      submit.textContent = '가입 처리 중…';
      status.innerHTML = '';
      p.googleConsent(token, {
        terms: true,
        privacy: true,
        terms_version: 'draft-2026-10-28',
        privacy_version: 'draft-2026-10-28'
      }).then(function (res) {
        if (!res.ok) {
          submit.disabled = false;
          submit.textContent = '동의하고 가입 완료';
          status.innerHTML = authAlert(
            res.data && res.data.error === 'token expired'
              ? '동의 시간이 만료되었습니다. Google 로그인을 다시 시도해 주세요.'
              : '가입을 완료하지 못했습니다. Google 로그인을 다시 시도해 주세요.', 'error'
          ) + '<a class="btn btn-secondary btn-block" href="#/login">로그인으로 돌아가기</a>';
          return;
        }
        window.cgiSyncAuthHeader && window.cgiSyncAuthHeader();
        showToast(res.created ? '가입이 완료되었습니다.' : '동의가 저장되었습니다.');
        if (res.redirect) window.location.href = res.redirect;
        else navigate('#/');
      });
    });
  }

  function renderAuthReset(app) {
    var p = authApi();
    var params = new URLSearchParams((location.hash || '').split('?')[1] || '');
    var token = params.get('token');
    if (!token) {
      app.innerHTML = authShell('비밀번호 재설정', authAlert('유효하지 않은 링크예요.', 'error'), true);
      return;
    }
    app.innerHTML = authShell('새 비밀번호 설정',
      '<form id="resetForm" class="auth-form" novalidate>' +
        authField('새 비밀번호', 'password', 'password', '', { autocomplete: 'new-password', min: 8 }) +
        authField('새 비밀번호 확인', 'password2', 'password', '', { autocomplete: 'new-password' }) +
        '<p class="auth-hint">8자 이상, 영문과 숫자와 기호가 모두 들어가야 해요.</p>' +
        '<button type="submit" class="btn btn-primary btn-block">확인</button>' +
      '</form>', true);
    var form = document.getElementById('resetForm');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var password = form.elements.password.value;
      if (password !== form.elements.password2.value) { showToast('비밀번호가 서로 일치하지 않습니다.'); return; }
      p.confirmPasswordReset(token, password).then(function (ok) {
        if (ok) {
          window.cgiSyncAuthHeader();
          showToast('비밀번호가 변경됐어요. 로그인 상태예요.');
          navigate('#/');
        } else {
          showToast('토큰이 유효하지 않거나 이미 사용됐어요. 재설정을 다시 요청하세요.');
        }
      });
    });
  }

  function renderForgotPassword(app) {
    var p = authApi();
    app.innerHTML = authShell('비밀번호 재설정 요청',
      '<p class="auth-muted">가입하신 이메일을 입력하면 재설정 링크를 보내 드려요. 이메일이 존재하지 않아도 같은 메시지를 보여요.</p>' +
      '<form id="forgotForm" class="auth-form" novalidate>' +
        authField('이메일', 'email', 'email', '', { autocomplete: 'email' }) +
        '<button type="submit" class="btn btn-primary btn-block">재설정 메일 받기</button>' +
      '</form>' +
      '<div class="auth-alt"><a href="#/login">로그인으로 돌아가기</a></div>', true);
    var form = document.getElementById('forgotForm');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = '전송 중…';
      p.requestPasswordReset(form.elements.email.value.trim()).then(function (ok) {
        submit.disabled = false;
        submit.textContent = '재설정 메일 받기';
        if (ok) {
          app.innerHTML = authShell('요청 완료',
            '<p class="auth-muted">가입하신 계정이 있다면 이메일로 재설정 링크를 보냈어요. 스팸 folder도 확인해 주세요.</p>' +
            '<div class="auth-alt"><a href="#/login">로그인으로 돌아가기</a></div>', true);
        } else {
          showToast('요청에 실패했어요. 나중에 다시 시도해 주세요.');
        }
      });
    });
  }

  function renderMyPage(app) {
    var p = authApi();
    if (p.isLoggedIn() && !p.emailVerified()) {
      // EMAIL_VERIFY_REQUIRED=YES makes every member API answer 403. Send the
      // member to the one screen that can fix it: the resend screen.
      navigate('#/auth/verify');
      return;
    }
    if (!p.isLoggedIn()) {
      app.innerHTML = authShell('로그인이 필요해요',
        '<p class="auth-muted">마이페이지는 로그인한 회원만 볼 수 있어요.</p>' +
        '<a class="btn btn-primary btn-block" href="#/login">로그인</a>' +
        '<div class="auth-alt"><a href="#/signup">회원가입</a></div>', true);
      return;
    }
    var tab = (state.route.tab || 'profile');
    var allowed = ['profile', 'addresses', 'orders', 'quotes'].indexOf(tab) === -1 ? 'profile' : tab;
    var user = p.me();
    var tabs = [
      ['profile', '회원 정보'],
      ['addresses', '배송지'],
      ['orders', '주문 내역'],
      ['quotes', '내 견적']
    ];
    var html = '<section class="mypage">' +
      '<header class="mypage-head">' +
        '<div><h2>마이페이지</h2><p class="auth-muted">' + esc(user.email) +
          (user.email_verified ? ' · 이메일 인증됨' : ' · <span class="auth-warn">이메일 미인증</span>') + '</p></div>' +
        '<nav class="mypage-tabs">' +
          tabs.map(function (t) {
            return '<a href="#/my-page/' + t[0] + '" class="mypage-tab' + (t[0] === allowed ? ' is-active' : '') + '">' + t[1] + '</a>';
          }).join('') +
        '</nav>' +
      '</header>' +
      '<div class="mypage-body" id="myPageBody"></div>' +
    '</section>';
    app.innerHTML = html;
    var body = document.getElementById('myPageBody');
    if (allowed === 'profile') renderMyProfile(body);
    else if (allowed === 'addresses') renderMyAddresses(body);
    else if (allowed === 'quotes') renderMyQuotes(body);
    else renderMyOrders(body);
  }

  function renderMyProfile(body) {
    var p = authApi();
    var u = p.me();
    body.innerHTML = '<form id="profileForm" class="auth-form mypage-form">' +
      authField('이메일', 'email', 'email', u.email, { autocomplete: 'email' }) +
      '<p class="auth-hint">이메일 주소는 변경할 수 없어요. 새 계정으로 가입해야 해요.</p>' +
      authField('성명', 'name', 'text', u.name || '', { maxLength: 40 }) +
      authField('연락처', 'phone', 'tel', u.phone || '', { required: false, placeholder: '010-0000-0000' }) +
      authField('회사명', 'company', 'text', u.company || '', { required: false, maxLength: 100 }) +
      '<button type="submit" class="btn btn-primary">저장</button>' +
    '</form>' +
    '<form id="passwordForm" class="auth-form mypage-form" novalidate>' +
      '<h3>비밀번호 변경</h3>' +
      authField('현재 비밀번호', 'current_password', 'password', '', { autocomplete: 'current-password' }) +
      authField('새 비밀번호', 'password', 'password', '', { autocomplete: 'new-password', min: 8 }) +
      authField('새 비밀번호 확인', 'password2', 'password', '', { autocomplete: 'new-password' }) +
      '<button type="submit" class="btn btn-secondary">변경</button>' +
    '</form>' +
    '<form class="mypage-form mypage-danger">' +
      '<h3>계정 삭제</h3>' +
      '<p class="auth-muted">진행 중인 주문이 있으면 삭제할 수 없어요.</p>' +
      '<button type="button" class="btn btn-danger" data-action="delete-account">계정 삭제</button>' +
    '</form>';
    var profileForm = document.getElementById('profileForm');
    profileForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var submit = profileForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = '저장 중…';
      p.updateProfile({
        name: profileForm.elements.name.value.trim(),
        phone: profileForm.elements.phone.value.trim(),
        company: profileForm.elements.company.value.trim()
      }).then(function (result) {
        submit.disabled = false;
        if (result && result.id) {
          window.cgiSyncAuthHeader();
          showToast('회원 정보를 저장했어요.');
          renderMyPage(document.getElementById('app'));
        } else {
          submit.textContent = '저장';
          showToast(result && result.data && result.data.error ? result.data.error : '저장에 실패했어요.');
        }
      });
    });
    var passwordForm = document.getElementById('passwordForm');
    passwordForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var submit = passwordForm.querySelector('button[type="submit"]');
      var password = passwordForm.elements.password.value;
      if (password !== passwordForm.elements.password2.value) { showToast('비밀번호가 서로 일치하지 않습니다.'); return; }
      submit.disabled = true;
      submit.textContent = '변경 중…';
      p.changePassword({ current_password: passwordForm.elements.current_password.value, password: password }).then(function (ok) {
        submit.disabled = false;
        submit.textContent = '변경';
        if (ok) { showToast('비밀번호가 변경됐어요.'); passwordForm.reset(); }
        else { showToast('변경에 실패했어요. 현재 비밀번호를 확인하세요.'); }
      });
    });
  }

  function renderMyAddresses(body) {
    var p = authApi();
    body.innerHTML = '<p class="auth-muted">배송지를 불러오는 중…</p>';
    p.addresses().then(function (items) {
      if (items === null) { body.innerHTML = authAlert('배송지를 불러오지 못했어요.', 'error'); return; }
      var list = items.map(function (a) {
        return '<article class="address-card">' +
          '<div class="address-head">' +
            '<strong>' + esc(a.label) + '</strong>' +
            (a.is_default ? '<span class="address-badge">기본</span>' : '') +
          '</div>' +
          '<p><strong>' + esc(a.recipient_name) + '</strong> · ' + esc(a.phone) + '</p>' +
          '<p>' + esc(a.addr) + (a.addr_detail ? ' ' + esc(a.addr_detail) : '') + '</p>' +
          (a.company ? '<p class="auth-muted">' + esc(a.company) + '</p>' : '') +
          '<button type="button" class="btn btn-small btn-danger" data-address-delete="' + esc(a.id) + '">삭제</button>' +
        '</article>';
      }).join('');
      body.innerHTML = '<form id="addressForm" class="auth-form mypage-form" novalidate>' +
        '<h3>배송지 추가</h3>' +
        authField('라벨', 'label', 'text', '', { placeholder: '집 / 사무실', maxLength: 40 }) +
        authField('수취인', 'recipient_name', 'text', '', { maxLength: 40 }) +
        authField('연락처', 'phone', 'tel', '', { placeholder: '010-0000-0000' }) +
        authField('주소', 'addr', 'text', '', { maxLength: 120 }) +
        authField('상세 주소', 'addr_detail', 'text', '', { required: false, maxLength: 100 }) +
        authField('회사명', 'company', 'text', '', { required: false, maxLength: 100 }) +
        '<label class="auth-field auth-field-row"><input type="checkbox" name="is_default"><span class="auth-label">기본 배송지로 저장</span></label>' +
        '<button type="submit" class="btn btn-primary">추가</button>' +
      '</form>' +
      '<div class="address-list">' + (list || '<p class="auth-muted">저장된 배송지가 없어요.</p>') + '</div>';
      bindAddressHandlers();
    });
  }

  function bindAddressHandlers() {
    var form = document.getElementById('addressForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        submit.textContent = '추가 중…';
        AUTH.addAddress({
          label: form.elements.label.value.trim(),
          recipient_name: form.elements.recipient_name.value.trim(),
          phone: form.elements.phone.value.trim(),
          addr: form.elements.addr.value.trim(),
          addr_detail: form.elements.addr_detail.value.trim(),
          company: form.elements.company.value.trim(),
          is_default: form.elements.is_default.checked
        }).then(function (result) {
          submit.disabled = false;
          submit.textContent = '추가';
          if (result && result.id) {
            showToast('배송지를 추가했어요.');
            renderMyAddresses(document.getElementById('myPageBody'));
          } else {
            showToast(result && result.data && result.data.error ? result.data.error : '추가에 실패했어요.');
          }
        });
      });
    }
    var deletes = document.querySelectorAll('[data-address-delete]');
    for (var i = 0; i < deletes.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (!window.confirm('이 배송지를 삭제할까요?')) return;
          AUTH.removeAddress(btn.getAttribute('data-address-delete')).then(function (ok) {
            showToast(ok ? '배송지를 삭제했어요.' : '삭제에 실패했어요.');
            renderMyAddresses(document.getElementById('myPageBody'));
          });
        });
      })(deletes[i]);
    }
  }

  /* -------------------------------------------------------------- my quotes */

  var QUOTE_STATUS_LABELS = { received: '접수', quoted: '견적 발송', completed: '완료', cancelled: '취소' };

  function quoteStatusLabel(status) {
    return QUOTE_STATUS_LABELS[status] || '접수';
  }

  function quoteDetailHtml(q) {
    var items = q.items || [];
    var rowsHtml = items.map(function (it) {
      return '<tr><td>' + esc(it.name || it.id || '상품') + '</td>' +
        '<td class="num">' + (it.qty != null ? it.qty : 1) + '</td>' +
        '<td class="num">' + esc(it.publicPrice || '가격 문의') + '</td></tr>';
    }).join('');
    var services = (q.services || []).map(function (id) { return serviceName(id); });
    var totalText = q.total != null ? money(q.total) : '담당자 확인 후 안내';
    return '<dl class="quote-detail-meta">' +
        '<dt>접수일시</dt><dd>' + esc(fmtDateTime(q.created_at)) + '</dd>' +
        '<dt>회사/기관</dt><dd>' + esc(q.company || '-') + '</dd>' +
        '<dt>담당자</dt><dd>' + esc(q.contact_name || '-') + ' · ' + esc(q.phone || '-') + '</dd>' +
        (q.location ? '<dt>설치 장소</dt><dd>' + esc(q.location) + '</dd>' : '') +
        (services.length ? '<dt>추가 서비스</dt><dd>' + esc(services.join(', ')) + '</dd>' : '') +
        (q.note ? '<dt>요청 사항</dt><dd>' + esc(q.note) + '</dd>' : '') +
      '</dl>' +
      (items.length ? '<table class="spec-table quote-items"><thead><tr><th>상품</th><th>수량</th><th>가격</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' : '') +
      '<p class="quote-detail-total"><span>합계</span><strong>' + esc(totalText) + '</strong></p>';
  }

  function toggleQuoteDetail(btn) {
    var id = btn.getAttribute('data-quote-toggle');
    var detail = document.getElementById('quote-detail-' + id);
    if (!detail) return;
    var open = detail.hasAttribute('hidden');
    if (open) detail.removeAttribute('hidden'); else detail.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '내용 닫기' : '내용 보기';
  }

  function renderMyQuotes(body) {
    var p = authApi();
    body.innerHTML = '<p class="auth-muted" data-quotes-loading>견적 내역을 불러오는 중…</p>';
    p.quotes().then(function (items) {
      if (items === null) {
        body.innerHTML = authAlert('견적 내역을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', 'error') +
          '<button type="button" class="btn btn-secondary" data-action="reload-quotes">다시 시도</button>';
        return;
      }
      if (!items.length) {
        body.innerHTML = '<div class="mypage-empty">' +
          '<h3>아직 요청한 견적이 없습니다</h3>' +
          '<p class="auth-muted">상품 상세에서 <strong>견적 요청하기</strong>를 누르면 접수 내역이 이곳에 표시됩니다.</p>' +
          '<a class="btn btn-primary" href="#/products">상품 둘러보기</a>' +
        '</div>';
        return;
      }
      body.innerHTML = '<p class="auth-muted myquotes-count">최근 견적 ' + items.length + '건</p>' +
        '<div class="quote-history">' + items.map(function (q) {
          var count = (q.items || []).length;
          var first = q.items && q.items[0] ? (q.items[0].name || '상품') : '상품';
          return '<article class="order-card quote-card">' +
            '<header class="order-card-head">' +
              '<span class="order-id quote-id">' + esc(q.id) + '</span>' +
              '<span class="quote-status ' + esc(q.status || 'received') + '">' + esc(quoteStatusLabel(q.status)) + '</span>' +
            '</header>' +
            '<p class="auth-muted quote-meta">' + esc(fmtDateTime(q.created_at)) + ' 접수' +
              (count ? ' · ' + esc(first) + (count > 1 ? ' 외 ' + (count - 1) + '건' : '') : '') + '</p>' +
            '<p class="order-total">' + (q.total != null ? money(q.total) : '금액 담당자 확인 후 안내') + '</p>' +
            '<button type="button" class="btn btn-secondary btn-small" data-action="toggle-quote" data-quote-toggle="' + esc(q.id) + '" aria-expanded="false">내용 보기</button>' +
            '<div class="quote-detail" id="quote-detail-' + esc(q.id) + '" hidden>' + quoteDetailHtml(q) + '</div>' +
          '</article>';
        }).join('') + '</div>';
    });
  }

  function renderMyOrders(body) {
    var p = authApi();
    body.innerHTML = '<p class="auth-muted">주문 내역을 불러오는 중…</p>';
    p.orders().then(function (items) {
      if (items === null) { body.innerHTML = authAlert('주문 내역을 불러오지 못했어요.', 'error'); return; }
      if (!items.length) {
        body.innerHTML = '<p class="auth-muted">로그인 상태로 한 주문만 여기에 보여요. 비회원 주문은 고객센터에 문의해 주세요.</p>' +
          '<a class="btn btn-primary" href="#/products">상품 보러 가기</a>';
        return;
      }
      body.innerHTML = '<div class="order-list">' + items.map(function (o) {
        var first = o.items && o.items[0] ? o.items[0].name : '상품';
        return '<article class="order-card">' +
          '<header class="order-card-head">' +
            '<a href="#/my-page/orders" class="order-id">' + esc(o.id) + '</a>' +
            '<span class="order-status">' + esc(o.status || '대기') + '</span>' +
          '</header>' +
          '<p class="auth-muted">' + esc(o.created_at || '') + ' · ' + esc(first) + (o.items && o.items.length > 1 ? ' 외 ' + (o.items.length - 1) + '건' : '') + '</p>' +
          '<p class="order-total">' + (o.totals && o.totals.total_amount != null ? Number(o.totals.total_amount).toLocaleString('ko-KR') + '원' : '금액 미확정') + '</p>' +
        '</article>';
      }).join('') + '</div>';
    });
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

  window.cgiCopyReceiptNumber = function () {
    var req = window.cgiLastQuoteCartRequest;
    copyText(req && req.id ? req.id : '', '접수번호를 복사했습니다.');
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

  // Any member API answering 403 email not verified lands here (cgi-auth.js
  // dispatches this event): show the verification screen with the resend button.
  window.addEventListener('cgi:email-verify-required', function () {
    showToast('인증 메일을 확인해 주세요.');
    if ((location.hash || '').indexOf('#/auth/verify') !== 0) navigate('#/auth/verify');
  });

  window.addEventListener('hashchange', render);

  /* ----------------------------------------------------------------- boot */
  if (window.CGI_AUTH) window.CGI_AUTH.rewriteMailLink();

  loadProducts().then(function () {
    loadQuoteCart();
    loadQuoteCartServices();
    updateHeaderCartCount();
    var session = window.CGI_AUTH ? window.CGI_AUTH.refresh() : Promise.resolve(null);
    if (loadingBox && loadingBox.parentNode) loadingBox.parentNode.removeChild(loadingBox);
    return session.then(function () {
      render();
      document.body.setAttribute('data-cgi-ready', '1');
    });
  }).catch(function (error) {
    if (loadingBox) loadingBox.textContent = '상품 데이터를 불러오지 못했습니다: ' + error.message;
    document.body.setAttribute('data-cgi-ready', 'error');
  });
})();
