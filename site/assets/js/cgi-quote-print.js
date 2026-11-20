/* ==========================================================================
   CGI 견적서 출력 (가견적) — 견적 목록 → 인쇄용 견적서 → 인쇄 / PDF 저장
   - 학교·기관 고객이 결재를 먼저 올릴 수 있게 로그인 없이 바로 출력한다.
   - 계산은 주문 화면과 같은 규칙(backend/lib/pricing.mjs splitTax):
       공급가액 = round(총액 / 1.1), 부가세 = 총액 − 공급가액 (1원 단위 반올림)
     합계 줄은 이 규칙을 총액에 한 번 적용한 값(주문·결제 화면과 같은 숫자)이고,
     품목별 칸은 품목마다 같은 규칙을 적용한 뒤 끝수 차이(몇 원)를 가장 큰 품목에서
     맞춰 열 합계가 합계 줄과 정확히 같게 한다.
   - 가격 문의 품목은 "별도 견적"으로 표시하고 합계에서 뺀다.
   - 공급자 정보는 website/assets/company.js(CGI_COMPANY) 단일 출처에서 읽는다.
   - 직인 이미지는 site/config.js 의 quotePrint.sealImageUrl 설정(비어 있으면 빈 칸).
   - 관리자 정식 견적서(quotes.html)도 같은 계산·화면을 쓴다. 그때만 쓰는 값:
       줄의 unit(직접 입력 단가, null 이면 별도 견적)·discount_type/discount_value(금액·%),
       renderHtml 의 official(정식 번호, 가견적 표시 없음)·validDays·customer 연락처·terms.
     서버(backend/lib/admin-quotes.mjs computeAdminQuote)가 같은 규칙으로 다시 계산해 저장한다.
   ========================================================================== */
(function (root) {
  'use strict';

  var VAT_RATE = 0.1;
  var VALID_DAYS = 14;

  function toNonNegInt(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  /** 주문 화면(백엔드 splitTax)과 같은 규칙. */
  function splitTax(total) {
    var t = toNonNegInt(total);
    var supplied = Math.round(t / (1 + VAT_RATE));
    return { supplied: supplied, vat: t - supplied, total: t };
  }

  /** 할인 금액: amount 는 줄 금액 이내, pct 는 0~100 을 1원 단위 반올림(서버 discountAmount 와 같다). */
  function discountAmount(gross, type, value) {
    var g = Math.max(0, Math.trunc(Number(gross) || 0));
    var v = Number(value) || 0;
    if (type === 'amount') return Math.min(g, Math.max(0, Math.trunc(v)));
    if (type === 'pct') return Math.min(g, Math.max(0, Math.round((g * Math.min(100, Math.max(0, v))) / 100)));
    return 0;
  }

  function isPriced(product) {
    return !!(product && product.price && product.price.state === 'public' &&
      product.price.value !== null && product.price.value !== undefined && Number.isFinite(Number(product.price.value)));
  }

  /**
   * 견적 계산. items: [{ qty, product, unit?, discount_type?, discount_value?, memo? }].
   *   unit 키가 있으면 그 값(직접 입력 단가, null=별도 견적), 없으면 상품 공개가.
   * 반환: 줄(번호·단가·할인·공급가액·부가세·합계 또는 별도 견적)과 합계.
   */
  function computeQuote(items) {
    var lines = (items || []).map(function (x, i) {
      var qty = Math.max(1, toNonNegInt(x.qty || (x.cart && x.cart.qty)) || 1);
      var product = x.product || {};
      var hasUnit = Object.prototype.hasOwnProperty.call(x, 'unit') && x.unit !== undefined;
      var memo = x.memo || '';
      if (hasUnit ? x.unit === null || x.unit === '' : !isPriced(product)) {
        return { no: i + 1, product: product, qty: qty, priced: false, unit: null, gross: null, discount: 0, supplied: null, vat: null, total: null, memo: memo };
      }
      var unit = hasUnit ? Math.max(0, Math.trunc(Number(x.unit) || 0)) : toNonNegInt(product.price.value);
      var gross = unit * qty;
      var discount = discountAmount(gross, x.discount_type, x.discount_value);
      var s = splitTax(gross - discount);
      return { no: i + 1, product: product, qty: qty, priced: true, unit: unit, gross: gross, discount: discount,
        discountType: discount ? x.discount_type : 'none', discountValue: discount ? Number(x.discount_value) : 0,
        supplied: s.supplied, vat: s.vat, total: s.total, memo: memo };
    });
    var priced = lines.filter(function (l) { return l.priced; });
    var grand = priced.reduce(function (sum, l) { return sum + l.total; }, 0);
    var totals = splitTax(grand);
    // 끝수 맞춤: 줄별 공급가액 합이 합계 줄과 다르면 가장 큰 품목에서 차이를 흡수한다.
    var lineSupplied = priced.reduce(function (sum, l) { return sum + l.supplied; }, 0);
    var diff = totals.supplied - lineSupplied;
    if (diff !== 0 && priced.length) {
      var biggest = priced.reduce(function (a, b) { return b.total > a.total ? b : a; }, priced[0]);
      biggest.supplied += diff;
      biggest.vat -= diff;
    }
    return {
      lines: lines,
      pricedCount: priced.length,
      inquiryCount: lines.length - priced.length,
      supplied: totals.supplied,
      vat: totals.vat,
      total: totals.total,
    };
  }

  /* ------------------------------------------------------------ 한글 금액 */
  var DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  var SMALL_UNITS = ['', '십', '백', '천'];
  var BIG_UNITS = ['', '만', '억', '조', '경'];

  /** 1280000 → "일백이십팔만". 0 → "영". 견적서 관행대로 십·백·천 앞의 1도 "일"로 쓴다. */
  function koreanNumber(value) {
    var n = toNonNegInt(value);
    if (n === 0) return '영';
    var groups = [];
    while (n > 0) { groups.push(n % 10000); n = Math.floor(n / 10000); }
    var out = '';
    for (var g = groups.length - 1; g >= 0; g--) {
      var part = groups[g];
      if (!part) continue;
      var text = '';
      var digits = String(part).padStart(4, '0');
      for (var i = 0; i < 4; i++) {
        var d = Number(digits[i]);
        if (d) text += DIGITS[d] + SMALL_UNITS[3 - i];
      }
      out += text + BIG_UNITS[g];
    }
    return out;
  }

  /** 1280000 → "금 일백이십팔만원정" */
  function koreanAmount(value) {
    return '금 ' + koreanNumber(value) + '원정';
  }

  /* ------------------------------------------------------------ 날짜·번호 */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymd(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()); }
  function koreanDate(date) { return date.getFullYear() + '년 ' + (date.getMonth() + 1) + '월 ' + date.getDate() + '일'; }
  function addDays(date, days) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + days);
    return d;
  }
  var NO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0·O·1·I 제외

  /** 브라우저에서 만든 임시 번호 Q-YYMMDD-xxxx (가견적, 서버 접수번호 아님) */
  function quoteNumber(date, randomFn) {
    var rnd = typeof randomFn === 'function' ? randomFn : Math.random;
    var tail = '';
    for (var i = 0; i < 4; i++) tail += NO_ALPHABET[Math.floor(rnd() * NO_ALPHABET.length) % NO_ALPHABET.length];
    return 'Q-' + String(date.getFullYear()).slice(2) + pad2(date.getMonth() + 1) + pad2(date.getDate()) + '-' + tail;
  }

  /** 공급자 정보: 회사 정보 단일 출처(CGI_COMPANY)에서. 새로 하드코딩하지 않는다. */
  function supplierFrom(company) {
    var c = company || {};
    var id = c.identity || {};
    var hq = c.hq || {};
    var contact = c.contact || {};
    var legal = c.legal || {};
    var officer = legal.privacyOfficer || {};
    var tels = (contact.tels || []).map(function (t) { return t.num; }).filter(Boolean);
    return {
      name: id.nameKo || '',
      ceo: id.ceo || '',
      bizRegNo: id.bizRegNo || '',
      address: (hq.zip ? '[' + hq.zip + '] ' : '') + (hq.addrFull || ''),
      tels: tels,
      fax: contact.fax || '',
      email: officer.email || '',
    };
  }

  function money(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 견적서 HTML. opts: { items, services:[{name}], customer:{company,name}, now:Date, number,
   *   company:CGI_COMPANY, sealImageUrl, brandOf(product), nameOf(product) }
   */
  function renderHtml(opts) {
    var now = opts.now || new Date();
    var q = computeQuote(opts.items);
    var sup = supplierFrom(opts.company);
    var brandOf = opts.brandOf || function (p) { return p.brand || ''; };
    var nameOf = opts.nameOf || function (p) { return p.name || ''; };
    var customer = opts.customer || {};
    var services = opts.services || [];
    var phone = sup.tels[0] || '';
    var official = !!opts.official;
    var validDays = official && Number(opts.validDays) > 0 ? Math.trunc(Number(opts.validDays)) : VALID_DAYS;
    var terms = opts.terms || {};
    var inquiryLabel = official ? '별도 협의' : '별도 견적';

    var rows = q.lines.map(function (l) {
      var p = l.product;
      var brand = brandOf(p);
      var model = p.model && p.model !== p.name ? p.model : '';
      var label = '<span class="qp-item-name">' + esc(nameOf(p)) + '</span>' +
        ((brand || model) ? '<span class="qp-item-sub">' + esc([brand, model].filter(Boolean).join(' / ')) + '</span>' : '') +
        (l.discount ? '<span class="qp-item-sub qp-item-discount">할인 ' +
          (l.discountType === 'pct' ? esc(String(l.discountValue)) + '% ' : '') + '−' + money(l.discount) + '원 (정가 ' + money(l.gross) + '원)</span>' : '') +
        (l.memo ? '<span class="qp-item-sub qp-item-memo">' + esc(l.memo) + '</span>' : '');
      if (!l.priced) {
        return '<tr class="qp-inquiry"><td class="qp-c">' + l.no + '</td><td>' + label + '</td><td class="qp-c">' + l.qty + '</td>' +
          '<td class="qp-c" colspan="4">' + inquiryLabel + '</td></tr>';
      }
      return '<tr><td class="qp-c">' + l.no + '</td><td>' + label + '</td><td class="qp-c">' + l.qty + '</td>' +
        '<td class="qp-n">' + money(l.unit) + '</td><td class="qp-n">' + money(l.supplied) + '</td>' +
        '<td class="qp-n">' + money(l.vat) + '</td><td class="qp-n">' + money(l.total) + '</td></tr>';
    }).join('');
    var serviceRows = services.map(function (s) {
      return '<tr class="qp-service"><td class="qp-c">—</td><td><span class="qp-item-name">추가 서비스: ' + esc(s.name) + '</span></td>' +
        '<td class="qp-c">—</td><td class="qp-c" colspan="4">별도 협의</td></tr>';
    }).join('');

    var seal = opts.sealImageUrl
      ? '<img class="qp-seal-img" src="' + esc(opts.sealImageUrl) + '" alt="회사 직인">'
      : '<span class="qp-seal-empty" aria-label="직인 자리">(인)</span>';

    return '' +
      '<article class="qp-sheet" aria-label="견적서">' +
        '<header class="qp-head">' +
          '<h1 class="qp-title">견 적 서</h1>' +
          (official ? '' : '<p class="qp-provisional">가견적 · 쇼핑몰 표시 가격 기준</p>') +
        '</header>' +
        '<div class="qp-meta-grid">' +
          '<section class="qp-box qp-to" aria-label="받는 분">' +
            '<table class="qp-kv"><tbody>' +
              '<tr><th>견적번호</th><td><strong data-quote-no>' + esc(opts.number) + '</strong>' + (official ? '' : ' <span class="qp-tag">가견적</span>') + '</td></tr>' +
              '<tr><th>견적일</th><td>' + esc(koreanDate(now)) + '</td></tr>' +
              '<tr><th>유효기간</th><td>' + esc(koreanDate(addDays(now, validDays))) + '까지 (견적일로부터 ' + validDays + '일)</td></tr>' +
              '<tr><th>받는 분</th><td class="qp-fill">' + (customer.company ? esc(customer.company) : '') + ' <span class="qp-honor">귀하</span></td></tr>' +
              '<tr><th>담당자</th><td class="qp-fill">' + (customer.name ? esc(customer.name) : '') + '</td></tr>' +
              (official && (customer.phone || customer.email)
                ? '<tr><th>연락처</th><td>' + esc([customer.phone, customer.email].filter(Boolean).join(' · ')) + '</td></tr>' : '') +
            '</tbody></table>' +
            '<p class="qp-greet">아래와 같이 견적합니다.</p>' +
          '</section>' +
          '<section class="qp-box qp-from" aria-label="공급자">' +
            '<table class="qp-kv"><tbody>' +
              '<tr><th rowspan="6" class="qp-vert">공<br>급<br>자</th><th>상호</th><td>' + esc(sup.name) + '</td></tr>' +
              '<tr><th>대표자</th><td class="qp-ceo">' + esc(sup.ceo) + ' <span class="qp-seal">' + seal + '</span></td></tr>' +
              '<tr><th>사업자번호</th><td>' + esc(sup.bizRegNo) + '</td></tr>' +
              '<tr><th>주소</th><td>' + esc(sup.address) + '</td></tr>' +
              '<tr><th>전화</th><td>' + esc(sup.tels.join(' · ')) + (sup.fax ? ' <span class="qp-sub-inline">팩스 ' + esc(sup.fax) + '</span>' : '') + '</td></tr>' +
              '<tr><th>이메일</th><td>' + esc(sup.email) + '</td></tr>' +
            '</tbody></table>' +
          '</section>' +
        '</div>' +
        '<div class="qp-sum-banner">' +
          '<span class="qp-sum-label">합계 금액<small>(부가세 포함)</small></span>' +
          '<strong class="qp-sum-ko" data-quote-korean>' + esc(koreanAmount(q.total)) + '</strong>' +
          '<span class="qp-sum-num">(₩' + money(q.total) + ')</span>' +
        '</div>' +
        '<p class="qp-mobile-hint">표는 옆으로 밀어서 볼 수 있습니다. 인쇄·PDF는 A4 한 장에 맞춰 나옵니다.</p>' +
        '<table class="qp-items">' +
          '<colgroup><col class="qp-col-no"><col><col class="qp-col-qty"><col class="qp-col-amt"><col class="qp-col-amt"><col class="qp-col-amt"><col class="qp-col-amt"></colgroup>' +
          '<thead><tr><th>번호</th><th>품명 (브랜드 / 모델)</th><th>수량</th><th>단가</th><th>공급가액</th><th>부가세</th><th>합계</th></tr></thead>' +
          '<tbody>' + rows + serviceRows + '</tbody>' +
          '<tfoot>' +
            '<tr><th colspan="4">합계</th><td class="qp-n" data-quote-supplied>' + money(q.supplied) + '</td><td class="qp-n" data-quote-vat>' + money(q.vat) + '</td><td class="qp-n qp-strong" data-quote-total>' + money(q.total) + '</td></tr>' +
          '</tfoot>' +
        '</table>' +
        (q.inquiryCount ? (official
          ? '<p class="qp-inquiry-note" data-quote-inquiry>별도 협의 품목 ' + q.inquiryCount + '건 — 위 합계에 포함되지 않았습니다.</p>'
          : '<p class="qp-inquiry-note" data-quote-inquiry>별도 견적 품목 ' + q.inquiryCount + '건 — 위 합계에 포함되지 않았으며, 담당자가 가격을 확인한 뒤 안내합니다.</p>') : '') +
        (services.length ? '<p class="qp-inquiry-note">추가 서비스는 현장 조건 확인 후 별도 협의합니다.</p>' : '') +
        (official && (terms.delivery || terms.payment)
          ? '<table class="qp-kv qp-terms"><tbody>' +
            (terms.delivery ? '<tr><th>납기</th><td>' + esc(terms.delivery) + '</td></tr>' : '') +
            (terms.payment ? '<tr><th>결제 조건</th><td>' + esc(terms.payment) + '</td></tr>' : '') +
            '</tbody></table>' : '') +
        '<footer class="qp-foot">' +
          (official
            ? '<p>위 금액은 부가세 포함이며, 유효기간 안에 주문하시면 이 견적 금액으로 공급합니다.</p>'
            : '<p>본 견적은 쇼핑몰 표시 가격 기준 가견적이며, 재고·납기·최종 금액은 담당자 확인 후 확정됩니다.</p>') +
          '<p>문의 ' + esc(phone) + (sup.email ? ' · ' + esc(sup.email) : '') + '</p>' +
        '</footer>' +
      '</article>';
  }

  var api = {
    VAT_RATE: VAT_RATE,
    VALID_DAYS: VALID_DAYS,
    splitTax: splitTax,
    computeQuote: computeQuote,
    discountAmount: discountAmount,
    koreanNumber: koreanNumber,
    koreanAmount: koreanAmount,
    quoteNumber: quoteNumber,
    addDays: addDays,
    ymd: ymd,
    koreanDate: koreanDate,
    supplierFrom: supplierFrom,
    renderHtml: renderHtml,
  };
  root.CGI_QUOTE_PRINT = api;
})(typeof window !== 'undefined' ? window : globalThis);
