/* ==========================================================================
   관리자 견적서 화면의 순수 조각 — DOM·가져오기 없이 node 시험(vm)에서 바로 쓴다.
   window.CGI_ADMIN_QUOTES_VIEW 로 내보낸다.
   - 계산은 견적서 출력 모듈(CGI_QUOTE_PRINT.computeQuote)을 그대로 쓴다(서버와 같은 규칙).
   - 카탈로그 품목: 공개가가 있으면 그 값(고칠 수 없음, 할인으로 조정), 가격 문의는 단가 직접 입력.
   - 직접 입력 줄: 설치비·출장비·공사비처럼 카탈로그에 없는 품목.
   ========================================================================== */
(function (root) {
  'use strict';

  var STATUSES = ['draft', 'sent', 'won', 'canceled'];
  var STATUS_LABEL = { draft: '작성 중', sent: '발송', won: '수주', canceled: '취소' };
  var STATUS_TABS = [{ key: '', label: '전체' }].concat(STATUSES.map(function (k) { return { key: k, label: STATUS_LABEL[k] }; }));
  var DEFAULT_VALID_DAYS = 14;
  var CUSTOM_PRESETS = ['설치비', '출장비', '공사비', '배선·자재비', '운반비'];

  function qp() { return root.CGI_QUOTE_PRINT; }
  function search() { return root.CGI_SEARCH; }

  function won(n) { return n == null ? '—' : Number(n).toLocaleString('ko-KR') + '원'; }
  function num(n) { return n == null ? '' : Number(n).toLocaleString('ko-KR'); }

  function parseMoney(value) {
    if (value === null || value === undefined) return null;
    var s = String(value).replace(/[,\s원]/g, '');
    if (s === '') return null;
    var n = Number(s);
    return Number.isFinite(n) && n >= 0 && Math.trunc(n) === n ? n : NaN;
  }

  var seq = 0;
  function key() { seq += 1; return 'l' + seq; }

  function emptyDraft() {
    return {
      id: null, quote_no: '', status: 'draft', quote_date: '', valid_days: DEFAULT_VALID_DAYS,
      recipient: { company: '', name: '', phone: '', email: '', memo: '' },
      delivery_terms: '', payment_terms: '', items: [], dirty: false
    };
  }

  /** 카탈로그 상품 → 줄. 공개가가 있으면 단가 고정(catalog), 없으면 직접 입력(manual, 비우면 별도 협의). */
  function lineFromProduct(p) {
    var S = search();
    var priced = S ? S.isPublicPrice(p) : !!(p.price && p.price.state === 'public');
    return {
      key: key(),
      kind: 'product',
      product_id: p.id,
      name: p.name || '',
      brand: S ? S.displayBrand(p) : (p.brand || ''),
      spec: p.model && p.model !== p.name ? p.model : '',
      qty: 1,
      unit_price: priced ? Math.trunc(Number(p.price.value)) : null,
      unit_source: priced ? 'catalog' : 'manual',
      discount_type: 'none',
      discount_value: 0,
      memo: ''
    };
  }

  function customLine(name) {
    return {
      key: key(), kind: 'custom', product_id: null, name: name || '', brand: '', spec: '',
      qty: 1, unit_price: null, unit_source: 'manual', discount_type: 'none', discount_value: 0, memo: ''
    };
  }

  /** 서버 견적 → 편집 상태. */
  function fromApi(quote) {
    var d = emptyDraft();
    if (!quote) return d;
    d.id = quote.id;
    d.quote_no = quote.quote_no;
    d.status = quote.status;
    d.quote_date = quote.quote_date;
    d.valid_days = quote.valid_days;
    d.valid_until = quote.valid_until;
    d.recipient = {
      company: quote.recipient.company || '', name: quote.recipient.name || '', phone: quote.recipient.phone || '',
      email: quote.recipient.email || '', memo: quote.recipient.memo || ''
    };
    d.delivery_terms = quote.delivery_terms || '';
    d.payment_terms = quote.payment_terms || '';
    d.server_total = quote.total_amount;
    d.items = (quote.items || []).map(function (it) {
      return {
        key: key(), kind: it.kind, product_id: it.product_id, name: it.name, brand: it.brand || '', spec: it.spec || '',
        qty: it.qty, unit_price: it.unit_price, unit_source: it.unit_source === 'catalog' ? 'catalog' : 'manual',
        discount_type: it.discount_type || 'none', discount_value: it.discount_value || 0, memo: it.memo || ''
      };
    });
    return d;
  }

  /** 출력·계산 모듈에 넘길 줄 모양. */
  function toPrintItems(draft) {
    return (draft.items || []).map(function (it) {
      return {
        qty: it.qty,
        unit: it.unit_price === '' || it.unit_price === undefined ? null : it.unit_price,
        discount_type: it.discount_type,
        discount_value: it.discount_value,
        memo: it.memo,
        product: { id: it.product_id || '', name: it.name, brand: it.brand || '', model: it.spec || '' }
      };
    });
  }

  function totals(draft) {
    var q = qp().computeQuote(toPrintItems(draft));
    q.korean = qp().koreanAmount(q.total);
    return q;
  }

  /** 저장 전에 화면에서 먼저 알려 줄 문제(서버도 같은 검사를 한다). */
  function validate(draft) {
    var errors = [];
    if (!String(draft.recipient.company || '').trim()) errors.push({ field: 'company', text: '받는 곳(회사·기관명)을 입력해 주세요.' });
    var email = String(draft.recipient.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ field: 'email', text: '이메일 형식을 확인해 주세요.' });
    var days = Number(draft.valid_days);
    if (!(Math.trunc(days) === days && days >= 1 && days <= 365)) errors.push({ field: 'valid_days', text: '유효기간은 1~365일입니다.' });
    (draft.items || []).forEach(function (it, i) {
      var where = (i + 1) + '번째 줄: ';
      if (!String(it.name || '').trim()) errors.push({ field: 'item', line: it.key, text: where + '품명을 입력해 주세요.' });
      if (!(Math.trunc(Number(it.qty)) === Number(it.qty) && it.qty >= 1)) errors.push({ field: 'item', line: it.key, text: where + '수량은 1 이상 정수입니다.' });
      if (Number.isNaN(it.unit_price)) errors.push({ field: 'item', line: it.key, text: where + '단가는 숫자(원)로 입력해 주세요.' });
      if (it.discount_type === 'pct' && !(it.discount_value >= 0 && it.discount_value <= 100)) errors.push({ field: 'item', line: it.key, text: where + '할인율은 0~100%입니다.' });
      if (it.discount_type === 'amount' && it.unit_price != null && it.discount_value > it.unit_price * it.qty) {
        errors.push({ field: 'item', line: it.key, text: where + '할인 금액이 줄 금액보다 큽니다.' });
      }
    });
    if (!(draft.items || []).length) errors.push({ field: 'items', text: '품목을 한 줄 이상 넣어 주세요.' });
    return errors;
  }

  /** 서버에 보낼 본문. 카탈로그 공개가 줄은 단가를 보내지 않는다(서버가 공개가로 확정). */
  function toApiBody(draft) {
    return {
      status: draft.status,
      valid_days: Number(draft.valid_days),
      recipient: {
        company: String(draft.recipient.company || '').trim(), name: String(draft.recipient.name || '').trim(),
        phone: String(draft.recipient.phone || '').trim(), email: String(draft.recipient.email || '').trim(),
        memo: String(draft.recipient.memo || '').trim()
      },
      delivery_terms: String(draft.delivery_terms || '').trim(),
      payment_terms: String(draft.payment_terms || '').trim(),
      items: (draft.items || []).map(function (it) {
        return {
          kind: it.kind,
          product_id: it.kind === 'product' ? it.product_id : null,
          name: String(it.name || '').trim(),
          brand: it.brand || '',
          spec: String(it.spec || '').trim(),
          qty: Number(it.qty),
          unit_price: it.unit_source === 'catalog' ? null : (it.unit_price == null ? null : it.unit_price),
          discount_type: it.discount_type,
          discount_value: it.discount_type === 'none' ? 0 : Number(it.discount_value) || 0,
          memo: String(it.memo || '').trim()
        };
      })
    };
  }

  /** '#/', '#/new', '#/q/12', '#/q/12/print' */
  function parseHash(hash) {
    var h = String(hash || '').replace(/^#\/?/, '');
    var m = h.match(/^q\/(\d+)(\/print)?$/);
    if (m) return { view: m[2] ? 'print' : 'edit', id: Number(m[1]) };
    if (h === 'new') return { view: 'new' };
    return { view: 'list' };
  }

  function addDaysText(ymd, days) {
    if (!ymd) return '';
    var p = String(ymd).split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
  }

  function todayYmd(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** 출력 모듈에 넘길 옵션(정식 견적서). quote 는 서버 견적. */
  function printOptions(quote, extra) {
    var e = extra || {};
    var p = String(quote.quote_date || '').split('-').map(Number);
    return {
      official: true,
      number: quote.quote_no,
      now: new Date(p[0], (p[1] || 1) - 1, p[2] || 1),
      validDays: quote.valid_days,
      customer: { company: quote.recipient.company, name: quote.recipient.name, phone: quote.recipient.phone, email: quote.recipient.email },
      terms: { delivery: quote.delivery_terms, payment: quote.payment_terms },
      items: toPrintItems(fromApi(quote)),
      company: e.company,
      sealImageUrl: e.sealImageUrl || ''
    };
  }

  function recipientLabel(r) {
    return [r.company, r.name, r.phone].filter(Boolean).join(' · ');
  }

  root.CGI_ADMIN_QUOTES_VIEW = {
    STATUSES: STATUSES,
    STATUS_LABEL: STATUS_LABEL,
    STATUS_TABS: STATUS_TABS,
    DEFAULT_VALID_DAYS: DEFAULT_VALID_DAYS,
    CUSTOM_PRESETS: CUSTOM_PRESETS,
    won: won,
    num: num,
    parseMoney: parseMoney,
    emptyDraft: emptyDraft,
    lineFromProduct: lineFromProduct,
    customLine: customLine,
    fromApi: fromApi,
    toPrintItems: toPrintItems,
    totals: totals,
    validate: validate,
    toApiBody: toApiBody,
    parseHash: parseHash,
    addDaysText: addDaysText,
    todayYmd: todayYmd,
    printOptions: printOptions,
    recipientLabel: recipientLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
