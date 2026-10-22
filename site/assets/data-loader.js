/*
 * data-loader.js — CGI 카탈로그 데이터 로더
 *
 * 설계 목적
 *  1) 시연 초기 데이터(공개 샘플)와 향후 전체 카탈로그(상품 마스터)를 같은 계약으로 교체 가능하게 한다.
 *  2) 로더는 "수집된 전체 상품"과 "CGI 판매 승인 상품"을 구분해 돌려준다.
 *  3) 미확정 값(공급가/재고/판매가)은 null 로 유지하고 추정하지 않는다.
 *
 * 데이터 소스 우선순위
 *   1) window.CGI_CATALOG          — 인라인 배포본(file:// 로 열어도 동작)
 *   2) data/catalog.demo.json      — 로컬 HTTP 서버로 열 때
 *   3) data/catalog.full.json      — 향후 전체 수집 결과로 교체 지점
 *
 * 교체 방법 (Issue #11 §3/§4)
 *   site/tools/build_demo_catalog.py 로 JSON 을 다시 만들거나,
 *   전체 수집 결과 CSV/JSON 을 같은 스키마로 변환해 data/catalog.full.json 로 두면
 *   index.html 의 data-catalog-src 속성만 바꾸면 된다.
 */
(function (global) {
  'use strict';

  var PRICE_STATE = {
    public: { label: '원본 공개가', tone: 'price-known' },
    inquiry_price: { label: '가격 문의', tone: 'price-inquiry' },
    missing: { label: '가격 정보 없음', tone: 'price-unknown' },
    sold_out_sale_completed: { label: '판매 완료/품절', tone: 'price-soldout' }
  };

  function normalizeProduct(p) {
    var state = PRICE_STATE[p.published_price_state] ? p.published_price_state : 'missing';
    return {
      id: p.id,
      sourceSite: p.source_site,
      sourceSiteLabel: p.source_site_label || p.source_site,
      sourceProductId: p.source_product_id,
      sourceCategoryId: p.source_category_id || '',
      sourceCategoryPath: p.source_category_path || '',
      brand: p.brand || '',
      model: p.model || '',
      name: p.product_name || '',
      summary: p.summary || '',
      manufacturer: p.manufacturer || '',
      countryOfOrigin: p.country_of_origin || '',
      canonicalUrl: p.canonical_url || '',
      sourceListUrl: p.source_list_url || '',
      specs: p.specs || {},
      options: p.options || [],
      bundledItems: p.bundled_items || [],
      imageUrls: p.image_urls || [],
      image: p.image || (p.image_urls && p.image_urls[0]) || '',
      price: (p.published_price === null || p.published_price === undefined) ? null : Number(p.published_price),
      priceText: p.published_price_text || '',
      priceState: state,
      priceLabel: PRICE_STATE[state].label,
      priceTone: PRICE_STATE[state].tone,
      availability: p.availability || '',
      reviewCount: p.review_count || '',
      extractionMethod: p.extraction_method || '',
      verificationStatus: p.verification_status || '',
      sourceEvidence: p.source_evidence || '',
      updatedAt: p.updated_at || '',
      cgiSaleStatus: p.cgi_sale_status || 'unapproved',
      cgiSaleNote: p.cgi_sale_note || '',
      cgiDealerPrice: p.cgi_dealer_price === undefined ? null : p.cgi_dealer_price,
      cgiDealerPriceState: p.cgi_dealer_price_state || 'unconfirmed',
      cgiStock: p.cgi_stock === undefined ? null : p.cgi_stock,
      cgiStockState: p.cgi_stock_state || 'unconfirmed',
      smartstore: p.naver_smartstore_mapping || null
    };
  }

  function normalize(catalog) {
    var products = (catalog.products || []).map(normalizeProduct);
    return {
      meta: catalog.meta || {},
      categories: catalog.categories || [],
      brands: catalog.brands || [],
      products: products,
      // 파생 집합: 수집된 전체 상품 vs CGI 판매 승인 상품
      totalCollected: products.length,
      approvedCount: products.filter(function (p) { return p.cgiSaleStatus === 'approved'; }).length
    };
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status + ' ' + url); }
      return r.json();
    });
  }

  /**
   * load(options) → Promise<normalizedCatalog>
   * options.inlineVar   : window 전역 변수 이름 (기본 'CGI_CATALOG')
   * options.jsonUrls    : 순서대로 시도할 JSON URL 배열
   */
  function load(options) {
    options = options || {};
    var inlineVar = options.inlineVar || 'CGI_CATALOG';
    var jsonUrls = options.jsonUrls || ['data/catalog.full.json', 'data/catalog.demo.json'];

    if (global[inlineVar] && global[inlineVar].products) {
      return Promise.resolve(normalize(global[inlineVar]));
    }
    var chain = Promise.reject(new Error('no inline data'));
    jsonUrls.forEach(function (url) {
      chain = chain.catch(function () { return fetchJson(url); });
    });
    return chain.then(normalize);
  }

  global.CGICatalog = {
    load: load,
    normalize: normalize,
    normalizeProduct: normalizeProduct,
    PRICE_STATE: PRICE_STATE
  };
})(window);
