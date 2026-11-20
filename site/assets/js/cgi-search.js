/* ==========================================================================
   CGI 상품 검색 규칙 (공용) — 카탈로그 화면(cgi-catalog.js)과 같은 규칙.
   - norm: 소문자·공백 제거·괄호/쉼표/점/가운뎃점 제거 (cgi-catalog.js norm 과 같다)
   - searchKey: search_text, 없으면 이름·모델·브랜드·제조사·분류·사양을 이어 붙인 값 (cgi-catalog.js prepare 의 _search)
   - relevance: 모델 일치 > 이름 앞부분 > 이름 포함 > 브랜드 > 낱말 (cgi-catalog.js filteredProducts 관련도)
   관리자 견적서(quotes.html)처럼 카탈로그 화면 전체를 띄우지 않는 곳에서 이 모듈을 쓴다.
   두 구현이 같은 결과를 내는지는 site/test/admin-quotes-ui-261120.test.mjs 가 확인한다.
   ========================================================================== */
(function (root) {
  'use strict';

  function norm(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[()[\]/,.·]/g, '');
  }

  function categoryLabel(product) {
    if (product.category && product.category.name) return product.category.name;
    if (product.category_path && product.category_path.length) return product.category_path[product.category_path.length - 1];
    return '미분류';
  }

  function displayBrand(product) {
    return product.brand_norm || product.brand || product.manufacturer ||
      (product.source && product.source.site_label) || '브랜드 미확인';
  }

  function searchKey(p) {
    return norm(p.search_text || [p.name, p.model, p.brand, p.brand_raw, p.manufacturer, categoryLabel(p),
      (p.category_path || []).join(' '),
      (p.specs || []).map(function (s) { return s.label + ' ' + s.value; }).join(' ')].join(' '));
  }

  function relevance(p, q, key) {
    var s = 0;
    var name = norm(p.name), model = norm(p.model), brand = norm(displayBrand(p));
    var k = key || p._search || searchKey(p);
    if (model && model === q) s += 100;
    if (name.indexOf(q) === 0) s += 60;
    else if (name.indexOf(q) !== -1) s += 40;
    if (brand && (q.indexOf(brand) !== -1 || brand.indexOf(q) !== -1)) s += 30;
    q.split(' ').forEach(function (t) { if (t.length >= 2 && k.indexOf(t) !== -1) s += 5; });
    return s;
  }

  function isPublicPrice(p) {
    return !!(p && p.price && p.price.state === 'public' && p.price.value !== null && p.price.value !== undefined &&
      Number.isFinite(Number(p.price.value)));
  }

  /** products 에서 q 가 들어 있는 상품을 관련도순으로. 같은 점수는 원래 순서. */
  function search(products, query, opts) {
    var o = opts || {};
    var q = norm(query);
    if (!q) return [];
    var hits = [];
    (products || []).forEach(function (p, index) {
      var key = p._search || (p._search = searchKey(p));
      if (key.indexOf(q) === -1) return;
      hits.push({ p: p, score: relevance(p, q, key), index: index });
    });
    hits.sort(function (a, b) { return (b.score - a.score) || (a.index - b.index); });
    var list = hits.map(function (h) { return h.p; });
    return o.limit ? list.slice(0, o.limit) : list;
  }

  root.CGI_SEARCH = {
    norm: norm,
    categoryLabel: categoryLabel,
    displayBrand: displayBrand,
    searchKey: searchKey,
    relevance: relevance,
    isPublicPrice: isPublicPrice,
    search: search
  };
})(typeof window !== 'undefined' ? window : globalThis);
