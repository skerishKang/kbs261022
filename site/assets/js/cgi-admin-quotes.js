/* ==========================================================================
   관리자 견적서 화면 (quotes.html) — 목록 · 작성/고치기 · 정식 견적서 출력
   - 관리자/총관리자 회원 세션(쿠키 + X-CSRF-Token)만. 서버 API: /api/admin/quotes*
   - 계산·모양은 cgi-admin-quotes-view.js(순수) + cgi-quote-print.js(견적서 출력, #230)
   - 카탈로그 검색은 cgi-search.js(카탈로그 화면과 같은 규칙)
   - 이카운트 전송은 다음 단계 — 버튼 자리만 둔다(비활성, 준비 중)
   ========================================================================== */
(function () {
  'use strict';

  var V = window.CGI_ADMIN_QUOTES_VIEW;
  var QP = window.CGI_QUOTE_PRINT;
  var S = window.CGI_SEARCH;
  var state = { list: null, filter: { q: '', status: '' }, draft: null, quote: null, recipients: null, catalog: null, catalogLoading: null, results: [], query: '', msg: null };

  function $(id) { return document.getElementById(id); }
  function view() { return $('aqView'); }
  function api(method, path, body) { return window.CGI_AUTH.api(method, path, body); }
  function isStaff(m) { return !!(m && (m.role === 'admin' || m.role === 'superadmin' || m.is_admin)); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function alertHtml(text, kind) {
    return text ? '<p class="fb-alert ' + (kind || 'error') + '" role="status">' + esc(text) + '</p>' : '';
  }
  function setPrintMode(on) {
    if (on) document.body.setAttribute('data-view', 'quote-print');
    else document.body.removeAttribute('data-view');
  }
  function errorText(res, fallback) {
    if (res && res.status === 401) { showAuth('로그인이 끝났어요. 다시 로그인해 주세요.'); return ''; }
    return (res && res.data && (res.data.detail || res.data.error)) || (fallback + ' (HTTP ' + (res ? res.status : 0) + ')');
  }

  /* ------------------------------------------------------------ 진입 */

  function showAuth(text) {
    $('aqApp').hidden = true;
    $('aqAuth').hidden = false;
    $('aqAuthMsg').innerHTML = alertHtml(text, 'error');
    setPrintMode(false);
  }

  function enter() {
    $('aqAuth').hidden = true;
    $('aqApp').hidden = false;
    route();
  }

  function boot() {
    if (!window.CGI_AUTH || !V || !QP || !S) { showAuth('견적서 모듈을 불러오지 못했어요.'); return; }
    window.CGI_AUTH.refresh().then(function (m) {
      if (isStaff(m)) enter();
      else showAuth(m ? '이 계정에는 견적서 권한이 없어요.' : '');
    }).catch(function () { showAuth('로그인 상태를 확인하지 못했어요.'); });

    $('aqLoginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var f = event.target;
      window.CGI_AUTH.login({ email: f.elements.email.value.trim(), password: f.elements.password.value })
        .then(function (ok) { if (!ok) { showAuth('이메일 또는 비밀번호를 확인해 주세요.'); return null; } return window.CGI_AUTH.refresh(); })
        .then(function (m) { if (m == null) return; if (isStaff(m)) enter(); else showAuth('이 계정에는 견적서 권한이 없어요.'); });
    });

    view().addEventListener('click', onClick);
    view().addEventListener('input', onInput);
    view().addEventListener('change', onChange);
    view().addEventListener('submit', function (event) {
      event.preventDefault();
      if (event.target.getAttribute('data-aq-form') === 'list-search') {
        state.filter.q = (event.target.elements.q.value || '').trim();
        openList();
      }
    });
    window.addEventListener('hashchange', function () { if (!$('aqApp').hidden) route(); });
    window.addEventListener('beforeunload', function (event) {
      if (state.draft && state.draft.dirty) { event.preventDefault(); event.returnValue = ''; }
    });
  }

  function route() {
    var r = V.parseHash(location.hash);
    setPrintMode(r.view === 'print');
    if (r.view === 'new') return openNew();
    if (r.view === 'edit') return openEdit(r.id);
    if (r.view === 'print') return openPrint(r.id);
    return openList();
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function confirmLeave() {
    if (state.draft && state.draft.dirty) return window.confirm('저장하지 않은 내용이 있어요. 나갈까요?');
    return true;
  }

  /* ------------------------------------------------------------ 목록 */

  function openList() {
    state.draft = null;
    view().innerHTML = '<p class="ops-empty">불러오는 중…</p>';
    var qs = '?limit=300' + (state.filter.q ? '&q=' + encodeURIComponent(state.filter.q) : '') + (state.filter.status ? '&status=' + state.filter.status : '');
    api('GET', '/api/admin/quotes' + qs).then(function (res) {
      if (!res.ok) { view().innerHTML = alertHtml(errorText(res, '목록을 불러오지 못했습니다')); return; }
      state.list = res.data.quotes || [];
      renderList();
    });
  }

  function renderList() {
    var rows = state.list || [];
    var chips = '<div class="ops-chips" role="group" aria-label="상태">' + V.STATUS_TABS.map(function (t) {
      var on = t.key === state.filter.status;
      return '<button type="button" class="ops-chip' + (on ? ' is-active' : '') + '" data-aq-status-filter="' + t.key + '" aria-pressed="' + on + '">' + esc(t.label) + '</button>';
    }).join('') + '</div>';
    var html = '' +
      (state.msg ? alertHtml(state.msg.text, state.msg.kind) : '') +
      '<div class="aq-list-head">' +
        '<form class="aq-search" data-aq-form="list-search" role="search">' +
          '<label class="sr-only" for="aqListQ">견적서 찾기</label>' +
          '<input id="aqListQ" type="search" name="q" value="' + esc(state.filter.q) + '" placeholder="견적번호·받는 곳·담당자" enterkeyhint="search">' +
          '<button type="button" class="btn btn-secondary" data-action="aq-list-search">찾기</button>' +
        '</form>' +
        '<a class="btn btn-primary" href="#/new" data-action="aq-new">새 견적서</a>' +
      '</div>' +
      chips +
      '<p class="ops-count">' + rows.length + '건</p>';
    if (!rows.length) {
      html += '<p class="ops-empty">' + (state.filter.q || state.filter.status ? '조건에 맞는 견적서가 없어요.' : '아직 만든 견적서가 없어요. ‘새 견적서’로 시작하세요.') + '</p>';
    } else {
      html += '<table class="aq-table"><thead><tr><th>견적번호</th><th>받는 곳</th><th class="aq-n">금액</th><th>상태</th><th>견적일</th><th><span class="sr-only">동작</span></th></tr></thead><tbody>' +
        rows.map(function (q) {
          return '<tr data-aq-row="' + q.id + '">' +
            '<td data-label="견적번호"><a href="#/q/' + q.id + '" class="aq-no">' + esc(q.quote_no) + '</a></td>' +
            '<td data-label="받는 곳"><span class="aq-who"><strong>' + esc(q.recipient.company) + '</strong>' + (q.recipient.name ? ' <span class="aq-muted">' + esc(q.recipient.name) + '</span>' : '') + '</span></td>' +
            '<td data-label="금액" class="aq-n">' + esc(V.won(q.total_amount)) + (q.inquiry_count ? ' <span class="aq-muted">(별도 ' + q.inquiry_count + ')</span>' : '') + '</td>' +
            '<td data-label="상태"><span class="aq-status aq-status-' + esc(q.status) + '">' + esc(V.STATUS_LABEL[q.status] || q.status) + '</span></td>' +
            '<td data-label="견적일">' + esc(q.quote_date) + '</td>' +
            '<td class="aq-row-actions">' +
              '<a class="btn btn-secondary btn-sm" href="#/q/' + q.id + '">열기</a>' +
              '<a class="btn btn-secondary btn-sm" href="#/q/' + q.id + '/print">출력</a>' +
              '<button type="button" class="btn btn-secondary btn-sm" data-action="aq-duplicate" data-id="' + q.id + '">복제</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    view().innerHTML = html;
    state.msg = null;
  }

  /* ------------------------------------------------------------ 작성·고치기 */

  function loadCatalog() {
    if (state.catalog) return Promise.resolve(state.catalog);
    if (state.catalogLoading) return state.catalogLoading;
    state.catalogLoading = fetch(new URL('data/catalog.json', location.href).toString(), { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('catalog ' + res.status); return res.json(); })
      .then(function (data) { state.catalog = (data && data.products) || []; return state.catalog; })
      .catch(function () { state.catalogLoading = null; state.catalog = null; return null; });
    return state.catalogLoading;
  }

  function loadRecipients() {
    return api('GET', '/api/admin/quotes/recipients?limit=20').then(function (res) {
      state.recipients = res.ok ? (res.data.recipients || []) : [];
    });
  }

  function openNew(base) {
    if (!state.draft || state.draft.id || !base) state.draft = base || V.emptyDraft();
    state.results = [];
    state.query = '';
    renderEditor();
    loadRecipients().then(function () { if (state.draft && !state.draft.id) renderRecipientsSelect(); });
    loadCatalog();
  }

  function openEdit(id) {
    view().innerHTML = '<p class="ops-empty">불러오는 중…</p>';
    api('GET', '/api/admin/quotes/' + id).then(function (res) {
      if (!res.ok) { view().innerHTML = alertHtml(errorText(res, '견적서를 불러오지 못했습니다')); return; }
      state.quote = res.data.quote;
      state.draft = V.fromApi(res.data.quote);
      state.results = [];
      state.query = '';
      renderEditor();
      loadRecipients().then(renderRecipientsSelect);
      loadCatalog();
    });
  }

  function field(label, name, value, opts) {
    var o = opts || {};
    var input = o.textarea
      ? '<textarea name="' + name + '" rows="' + (o.rows || 2) + '" maxlength="' + (o.max || 300) + '" data-aq-field="' + name + '"' + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>' + esc(value) + '</textarea>'
      : '<input type="' + (o.type || 'text') + '" name="' + name + '" value="' + esc(value) + '" maxlength="' + (o.max || 100) + '" data-aq-field="' + name + '"' +
        (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + (o.autocomplete ? ' autocomplete="' + o.autocomplete + '"' : ' autocomplete="off"') +
        (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') + (o.required ? ' required' : '') + '>';
    return '<label class="aq-field' + (o.wide ? ' aq-wide' : '') + '"><span>' + esc(label) + (o.required ? ' <em>*</em>' : '') + '</span>' + input + '</label>';
  }

  function renderEditor() {
    var d = state.draft;
    var head = d.id
      ? '<h2 class="aq-h">견적서 <strong class="aq-no-big">' + esc(d.quote_no) + '</strong> <span class="aq-status aq-status-' + esc(d.status) + '">' + esc(V.STATUS_LABEL[d.status]) + '</span></h2>' +
        '<p class="aq-sub">견적일 ' + esc(d.quote_date) + ' · 저장하면 같은 번호로 고쳐집니다.</p>'
      : '<h2 class="aq-h">새 견적서</h2><p class="aq-sub">저장하면 견적번호(Q-날짜-순번)가 발급됩니다.</p>';
    var statusSelect = '<label class="aq-field"><span>상태</span><select data-aq-field="status">' + V.STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === d.status ? ' selected' : '') + '>' + esc(V.STATUS_LABEL[s]) + '</option>';
    }).join('') + '</select></label>';

    view().innerHTML = '' +
      '<div class="aq-editor">' +
        '<div class="aq-editor-head">' +
          '<div>' + head + '</div>' +
          '<a class="btn btn-secondary btn-sm" href="#/" data-action="aq-back">← 목록</a>' +
        '</div>' +
        '<div id="aqMsg"></div>' +
        '<section class="aq-card" aria-labelledby="aqRecipientH">' +
          '<div class="aq-card-head"><h3 id="aqRecipientH">받는 곳</h3><div id="aqRecipientPick"></div></div>' +
          '<div class="aq-grid">' +
            field('회사·기관명', 'company', d.recipient.company, { required: true, max: 100, placeholder: '예: ○○초등학교 행정실' }) +
            field('담당자', 'name', d.recipient.name, { max: 50 }) +
            field('연락처', 'phone', d.recipient.phone, { type: 'tel', max: 40, inputmode: 'tel', placeholder: '010-0000-0000' }) +
            field('이메일', 'email', d.recipient.email, { type: 'email', max: 120, inputmode: 'email' }) +
            field('메모', 'memo', d.recipient.memo, { textarea: true, wide: true, max: 1000, placeholder: '현장 위치, 요청 사항 등(견적서에는 나오지 않음)' }) +
          '</div>' +
        '</section>' +
        '<section class="aq-card" aria-labelledby="aqItemsH">' +
          '<div class="aq-card-head"><h3 id="aqItemsH">품목</h3></div>' +
          '<div class="aq-add">' +
            '<label class="aq-field aq-wide"><span>카탈로그에서 찾기</span>' +
              '<input type="search" id="aqItemQ" value="' + esc(state.query) + '" placeholder="상품명·모델·브랜드 (예: 무선마이크, SM58)" autocomplete="off" enterkeyhint="search" data-aq-search></label>' +
            '<div class="aq-custom-add">' +
              '<span class="aq-custom-label">직접 입력 줄</span>' +
              V.CUSTOM_PRESETS.map(function (name) { return '<button type="button" class="ops-chip" data-action="aq-add-custom" data-name="' + esc(name) + '">+ ' + esc(name) + '</button>'; }).join('') +
              '<button type="button" class="ops-chip" data-action="aq-add-custom" data-name="">+ 빈 줄</button>' +
            '</div>' +
          '</div>' +
          '<div id="aqResults" class="aq-results" aria-live="polite"></div>' +
          '<div id="aqLines"></div>' +
        '</section>' +
        '<div class="aq-bottom">' +
          '<section class="aq-card" aria-labelledby="aqTermsH">' +
            '<div class="aq-card-head"><h3 id="aqTermsH">조건</h3></div>' +
            '<div class="aq-grid">' +
              '<label class="aq-field"><span>유효기간(일)</span><input type="number" min="1" max="365" step="1" inputmode="numeric" value="' + esc(d.valid_days) + '" data-aq-field="valid_days"></label>' +
              '<p class="aq-field aq-valid-until" id="aqValidUntil"></p>' +
              field('납기', 'delivery_terms', d.delivery_terms, { textarea: true, wide: true, max: 300, placeholder: '예: 발주 후 2주 이내 설치' }) +
              field('결제 조건', 'payment_terms', d.payment_terms, { textarea: true, wide: true, max: 300, placeholder: '예: 설치 완료 후 30일 이내 계좌 이체' }) +
              statusSelect +
            '</div>' +
          '</section>' +
          '<section class="aq-card aq-sum" aria-labelledby="aqSumH">' +
            '<div class="aq-card-head"><h3 id="aqSumH">합계</h3></div>' +
            '<div id="aqTotals"></div>' +
          '</section>' +
        '</div>' +
        '<div class="aq-actions">' +
          '<button type="button" class="btn btn-primary" data-action="aq-save">저장</button>' +
          '<button type="button" class="btn btn-secondary" data-action="aq-print"' + (d.id ? '' : ' disabled title="저장한 뒤 출력할 수 있어요"') + '>견적서 출력</button>' +
          '<button type="button" class="btn btn-secondary" data-action="aq-duplicate"' + (d.id ? ' data-id="' + d.id + '"' : ' disabled') + '>복제해서 새 견적</button>' +
          '<button type="button" class="btn btn-secondary aq-ecount" disabled aria-disabled="true" title="이카운트 전송은 다음 단계에서 엽니다">이카운트로 보내기 <small>준비 중</small></button>' +
        '</div>' +
      '</div>';
    renderRecipientsSelect();
    renderResults();
    renderLines();
    renderTotals();
    if (state.flash) { showMsg(state.flash.text, state.flash.kind); state.flash = null; }
  }

  function renderRecipientsSelect() {
    var box = $('aqRecipientPick');
    if (!box) return;
    var list = state.recipients || [];
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<label class="aq-pick"><span class="sr-only">최근 받는 곳</span><select data-aq-recipient-pick>' +
      '<option value="">최근 받는 곳에서 고르기…</option>' +
      list.map(function (r, i) { return '<option value="' + i + '">' + esc(V.recipientLabel(r)) + '</option>'; }).join('') +
      '</select></label>';
  }

  function priceText(p) {
    return S.isPublicPrice(p) ? V.won(p.price.value) : '가격 문의';
  }

  function renderResults() {
    var box = $('aqResults');
    if (!box) return;
    var q = state.query.trim();
    if (!q) { box.innerHTML = ''; return; }
    if (!state.catalog) {
      box.innerHTML = '<p class="aq-muted">상품 목록을 불러오는 중…</p>';
      loadCatalog().then(function (rows) {
        if (!rows) { box.innerHTML = alertHtml('상품 목록을 불러오지 못했어요. 직접 입력 줄을 쓰세요.'); return; }
        doSearch();
      });
      return;
    }
    if (!state.results.length) { box.innerHTML = '<p class="aq-muted">“' + esc(q) + '” 검색 결과가 없어요. 띄어쓰기를 바꾸거나 직접 입력 줄을 쓰세요.</p>'; return; }
    box.innerHTML = '<ul class="aq-result-list">' + state.results.map(function (p, i) {
      return '<li><button type="button" class="aq-result" data-action="aq-add-product" data-index="' + i + '">' +
        '<span class="aq-result-name">' + esc(p.name) + '</span>' +
        '<span class="aq-result-sub">' + esc(S.displayBrand(p)) + (p.model ? ' · ' + esc(p.model) : '') + '</span>' +
        '<span class="aq-result-price' + (S.isPublicPrice(p) ? '' : ' is-inquiry') + '">' + esc(priceText(p)) + '</span>' +
        '<span class="aq-result-add" aria-hidden="true">추가</span>' +
      '</button></li>';
    }).join('') + '</ul>';
  }

  var searchTimer = null;
  function doSearch() {
    state.results = state.catalog ? S.search(state.catalog, state.query, { limit: 12 }) : [];
    renderResults();
  }

  function totalCell(totalHtml, l) {
    return '<span>금액</span><span class="aq-total-val"><strong>' + totalHtml + '</strong>' +
      (l.discount ? '<small>할인 −' + esc(V.num(l.discount)) + '</small>' : '') + '</span>';
  }

  function lineRow(it, index, calc) {
    var l = calc.lines[index] || {};
    var unitCell = it.unit_source === 'catalog'
      ? '<span class="aq-unit-fixed">' + esc(V.num(it.unit_price)) + '<small>공개가</small></span>'
      : '<input type="text" inputmode="numeric" class="aq-num" value="' + esc(it.unit_price == null || Number.isNaN(it.unit_price) ? '' : V.num(it.unit_price)) + '" data-aq-line="unit_price" placeholder="' + (it.kind === 'custom' ? '단가 입력' : '가격 문의 — 단가 입력') + '" aria-label="단가">';
    var nameCell = it.kind === 'custom'
      ? '<input type="text" value="' + esc(it.name) + '" data-aq-line="name" maxlength="200" placeholder="품명(예: 설치비)" aria-label="품명">' +
        '<input type="text" value="' + esc(it.spec) + '" data-aq-line="spec" maxlength="200" placeholder="규격·내용(선택)" aria-label="규격" class="aq-spec">'
      : '<span class="aq-line-name">' + esc(it.name) + '</span><span class="aq-line-sub">' + esc([it.brand, it.spec].filter(Boolean).join(' · ')) + '</span>';
    var total = l.priced ? V.won(l.total) : '<span class="aq-muted">별도 협의</span>';
    return '<div class="aq-line" data-aq-key="' + esc(it.key) + '">' +
      '<div class="aq-line-no">' + (index + 1) + '<span class="aq-kind">' + (it.kind === 'custom' ? '직접' : '상품') + '</span></div>' +
      '<div class="aq-line-main">' + nameCell +
        '<input type="text" value="' + esc(it.memo) + '" data-aq-line="memo" maxlength="300" placeholder="줄 메모(견적서에 표시)" aria-label="줄 메모" class="aq-memo">' +
      '</div>' +
      '<label class="aq-cell"><span>수량</span><input type="number" min="1" max="99999" step="1" inputmode="numeric" class="aq-num" value="' + esc(it.qty) + '" data-aq-line="qty"></label>' +
      '<div class="aq-cell"><span>단가</span>' + unitCell + '</div>' +
      '<div class="aq-cell aq-discount"><span>할인</span><div class="aq-discount-row">' +
        '<select data-aq-line="discount_type" aria-label="할인 방식">' +
          '<option value="none"' + (it.discount_type === 'none' ? ' selected' : '') + '>없음</option>' +
          '<option value="amount"' + (it.discount_type === 'amount' ? ' selected' : '') + '>원</option>' +
          '<option value="pct"' + (it.discount_type === 'pct' ? ' selected' : '') + '>%</option>' +
        '</select>' +
        '<input type="text" inputmode="decimal" class="aq-num" value="' + esc(it.discount_type === 'none' ? '' : (it.discount_type === 'amount' ? V.num(it.discount_value) : it.discount_value)) + '" data-aq-line="discount_value"' + (it.discount_type === 'none' ? ' disabled' : '') + ' aria-label="할인 값">' +
      '</div></div>' +
      '<div class="aq-cell aq-line-total">' + totalCell(total, l) + '</div>' +
      '<div class="aq-line-tools">' +
        '<button type="button" class="aq-icon" data-action="aq-move" data-dir="-1" aria-label="위로"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="aq-icon" data-action="aq-move" data-dir="1" aria-label="아래로"' + (index === state.draft.items.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="aq-icon aq-del" data-action="aq-remove" aria-label="줄 지우기">✕</button>' +
      '</div>' +
    '</div>';
  }

  function renderLines() {
    var box = $('aqLines');
    if (!box) return;
    var d = state.draft;
    if (!d.items.length) { box.innerHTML = '<p class="ops-empty aq-lines-empty">위에서 상품을 찾아 추가하거나 직접 입력 줄을 넣으세요.</p>'; return; }
    var calc = V.totals(d);
    box.innerHTML = '<div class="aq-lines">' + d.items.map(function (it, i) { return lineRow(it, i, calc); }).join('') + '</div>';
  }

  function renderTotals() {
    var box = $('aqTotals');
    if (!box) return;
    var d = state.draft;
    var q = V.totals(d);
    box.innerHTML = '<dl class="aq-totals">' +
      '<div><dt>공급가액</dt><dd data-aq-supplied>' + esc(V.won(q.supplied)) + '</dd></div>' +
      '<div><dt>부가세</dt><dd data-aq-vat>' + esc(V.won(q.vat)) + '</dd></div>' +
      '<div class="aq-grand"><dt>총액</dt><dd data-aq-total>' + esc(V.won(q.total)) + '</dd></div>' +
      '</dl>' +
      '<p class="aq-korean" data-aq-korean>' + esc(q.korean) + ' <span class="aq-muted">(부가세 포함)</span></p>' +
      (q.inquiryCount ? '<p class="aq-muted">단가 없는 줄 ' + q.inquiryCount + '건은 ‘별도 협의’로 나오고 합계에서 빠집니다.</p>' : '');
    var vu = $('aqValidUntil');
    if (vu) {
      var base = d.quote_date || V.todayYmd();
      var days = Number(d.valid_days);
      vu.innerHTML = days >= 1 && days <= 365 ? '<span>유효기간</span><strong>' + esc(V.addDaysText(base, days)) + '까지</strong>' : '<span>유효기간</span><strong>—</strong>';
    }
  }

  function refreshCalc() {
    // 입력 중인 칸의 포커스를 잃지 않게: 줄 금액·합계만 다시 그린다.
    var d = state.draft;
    var calc = V.totals(d);
    d.items.forEach(function (it, i) {
      var row = view().querySelector('[data-aq-key="' + it.key + '"] .aq-line-total');
      if (!row) return;
      var l = calc.lines[i];
      row.innerHTML = totalCell(l.priced ? esc(V.won(l.total)) : '<span class="aq-muted">별도 협의</span>', l);
    });
    renderTotals();
  }

  function showMsg(text, kind) {
    var box = $('aqMsg');
    if (box) { box.innerHTML = alertHtml(text, kind); if (text) box.scrollIntoView({ block: 'nearest' }); }
  }

  function lineByEl(el) {
    var row = el.closest('[data-aq-key]');
    if (!row) return null;
    var k = row.getAttribute('data-aq-key');
    var items = state.draft.items;
    for (var i = 0; i < items.length; i++) if (items[i].key === k) return { item: items[i], index: i };
    return null;
  }

  function save() {
    var d = state.draft;
    var errors = V.validate(d);
    if (errors.length) { showMsg(errors[0].text + (errors.length > 1 ? ' 외 ' + (errors.length - 1) + '건' : ''), 'error'); return Promise.resolve(null); }
    var body = V.toApiBody(d);
    var req = d.id ? api('PATCH', '/api/admin/quotes/' + d.id, body) : api('POST', '/api/admin/quotes', body);
    var btn = view().querySelector('[data-action="aq-save"]');
    if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
    return req.then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = '저장'; }
      if (!res.ok) { showMsg(errorText(res, '저장하지 못했습니다'), 'error'); return null; }
      var quote = res.data.quote;
      var wasNew = !d.id;
      state.quote = quote;
      state.draft = V.fromApi(quote);
      if (wasNew) {
        try { history.replaceState(null, document.title, location.pathname + location.search + '#/q/' + quote.id); } catch (e) {}
      }
      renderEditor();
      showMsg((wasNew ? '견적번호 ' + quote.quote_no + '로 저장했어요.' : '저장했어요.') + ' 합계 ' + V.won(quote.total_amount), 'ok');
      return quote;
    });
  }

  function duplicate(id) {
    if (!confirmLeave()) return;
    api('POST', '/api/admin/quotes/' + id + '/duplicate').then(function (res) {
      if (!res.ok) {
        var text = errorText(res, '복제하지 못했습니다');
        if ($('aqMsg')) showMsg(text, 'error');
        else if (text) { state.msg = { text: text, kind: 'error' }; renderList(); }
        return;
      }
      var quote = res.data.quote;
      state.draft = null;
      state.flash = { text: '복제해서 새 견적 ' + quote.quote_no + '를 만들었어요(작성 중). 카탈로그 단가는 지금 공개가로 다시 맞췄습니다.', kind: 'ok' };
      go('#/q/' + quote.id);
    });
  }

  /* ------------------------------------------------------------ 출력 */

  function openPrint(id) {
    view().innerHTML = '<p class="ops-empty no-print">불러오는 중…</p>';
    api('GET', '/api/admin/quotes/' + id).then(function (res) {
      if (!res.ok) { setPrintMode(false); view().innerHTML = alertHtml(errorText(res, '견적서를 불러오지 못했습니다')); return; }
      var quote = res.data.quote;
      state.quote = quote;
      var cfg = window.CGI_SITE_CONFIG || {};
      var opts = V.printOptions(quote, {
        company: window.CGI_COMPANY,
        sealImageUrl: cfg.quotePrint && cfg.quotePrint.sealImageUrl ? String(cfg.quotePrint.sealImageUrl) : ''
      });
      var calc = QP.computeQuote(opts.items);
      var mismatch = calc.total !== quote.total_amount;
      view().innerHTML = '' +
        '<div class="qp-toolbar no-print">' +
          '<div class="qp-actions">' +
            '<button type="button" class="btn btn-primary" data-action="aq-print-now">인쇄 / PDF 저장</button>' +
            '<a class="btn btn-secondary" href="#/q/' + quote.id + '">고치기</a>' +
            '<a class="btn btn-secondary" href="#/">목록</a>' +
            '<button type="button" class="btn btn-secondary aq-ecount" disabled aria-disabled="true" title="이카운트 전송은 다음 단계에서 엽니다">이카운트로 보내기 <small>준비 중</small></button>' +
          '</div>' +
          '<p class="form-note">정식 견적서 ' + esc(quote.quote_no) + ' · ' + esc(V.STATUS_LABEL[quote.status]) + '. 인쇄 창에서 ‘PDF로 저장’을 고르면 파일로 받을 수 있어요.</p>' +
          (mismatch ? alertHtml('저장된 합계(' + V.won(quote.total_amount) + ')와 화면 계산이 달라요. 고치기에서 다시 저장해 주세요.') : '') +
        '</div>' +
        QP.renderHtml(opts);
      document.title = quote.quote_no + ' 견적서 | CGI';
    });
  }

  /* ------------------------------------------------------------ 이벤트 */

  function onClick(event) {
    var el = event.target.closest('[data-action], [data-aq-status-filter]');
    if (!el) return;
    if (el.hasAttribute('data-aq-status-filter')) {
      state.filter.status = el.getAttribute('data-aq-status-filter');
      openList();
      return;
    }
    var action = el.getAttribute('data-action');
    if (action === 'aq-list-search') {
      var input = $('aqListQ');
      state.filter.q = input ? input.value.trim() : '';
      openList();
    } else if (action === 'aq-back' || action === 'aq-new') {
      if (!confirmLeave()) { event.preventDefault(); return; }
      if (action === 'aq-new') { event.preventDefault(); state.draft = V.emptyDraft(); go('#/new'); }
    } else if (action === 'aq-add-product') {
      var p = state.results[Number(el.getAttribute('data-index'))];
      if (!p) return;
      state.draft.items.push(V.lineFromProduct(p));
      state.draft.dirty = true;
      renderLines();
      renderTotals();
      var last = view().querySelector('.aq-line:last-child input[data-aq-line="qty"]');
      if (last) last.focus({ preventScroll: false });
    } else if (action === 'aq-add-custom') {
      state.draft.items.push(V.customLine(el.getAttribute('data-name')));
      state.draft.dirty = true;
      renderLines();
      renderTotals();
      var lastCustom = view().querySelector('.aq-line:last-child input[data-aq-line="' + (el.getAttribute('data-name') ? 'unit_price' : 'name') + '"]');
      if (lastCustom) lastCustom.focus();
    } else if (action === 'aq-remove' || action === 'aq-move') {
      var hit = lineByEl(el);
      if (!hit) return;
      var items = state.draft.items;
      if (action === 'aq-remove') items.splice(hit.index, 1);
      else {
        var to = hit.index + Number(el.getAttribute('data-dir'));
        if (to < 0 || to >= items.length) return;
        items.splice(to, 0, items.splice(hit.index, 1)[0]);
      }
      state.draft.dirty = true;
      renderLines();
      renderTotals();
    } else if (action === 'aq-save') {
      save();
    } else if (action === 'aq-print') {
      var d = state.draft;
      if (!d.id) return;
      (d.dirty ? save() : Promise.resolve(state.quote)).then(function (q) { if (q) go('#/q/' + q.id + '/print'); });
    } else if (action === 'aq-duplicate') {
      duplicate(el.getAttribute('data-id'));
    } else if (action === 'aq-print-now') {
      window.print();
    }
  }

  function onInput(event) {
    var el = event.target;
    if (el.hasAttribute('data-aq-search')) {
      state.query = el.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 180);
      return;
    }
    if (!state.draft) return;
    var f = el.getAttribute('data-aq-field');
    if (f) {
      if (['company', 'name', 'phone', 'email', 'memo'].indexOf(f) !== -1) state.draft.recipient[f] = el.value;
      else if (f === 'valid_days') { state.draft.valid_days = el.value === '' ? '' : Number(el.value); renderTotals(); }
      else if (f !== 'status') state.draft[f] = el.value;
      state.draft.dirty = true;
      return;
    }
    var lf = el.getAttribute('data-aq-line');
    if (lf) {
      var hit = lineByEl(el);
      if (!hit) return;
      var it = hit.item;
      if (lf === 'qty') it.qty = el.value === '' ? 0 : Number(el.value);
      else if (lf === 'unit_price') it.unit_price = V.parseMoney(el.value);
      else if (lf === 'discount_value') {
        var raw = String(el.value).replace(/[,\s원%]/g, '');
        it.discount_value = raw === '' ? 0 : Number(raw);
      } else it[lf] = el.value;
      state.draft.dirty = true;
      refreshCalc();
    }
  }

  function onChange(event) {
    var el = event.target;
    if (el.hasAttribute('data-aq-recipient-pick')) {
      var r = (state.recipients || [])[Number(el.value)];
      if (!r) return;
      state.draft.recipient.company = r.company || '';
      state.draft.recipient.name = r.name || '';
      state.draft.recipient.phone = r.phone || '';
      state.draft.recipient.email = r.email || '';
      state.draft.dirty = true;
      ['company', 'name', 'phone', 'email'].forEach(function (k) {
        var input = view().querySelector('[data-aq-field="' + k + '"]');
        if (input) input.value = state.draft.recipient[k];
      });
      el.value = '';
      return;
    }
    if (el.getAttribute('data-aq-field') === 'status') { state.draft.status = el.value; state.draft.dirty = true; return; }
    if (el.getAttribute('data-aq-line') === 'discount_type') {
      var hit = lineByEl(el);
      if (!hit) return;
      hit.item.discount_type = el.value;
      hit.item.discount_value = 0;
      state.draft.dirty = true;
      renderLines();
      renderTotals();
      var input = view().querySelector('[data-aq-key="' + hit.item.key + '"] [data-aq-line="discount_value"]');
      if (input && !input.disabled) input.focus();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
