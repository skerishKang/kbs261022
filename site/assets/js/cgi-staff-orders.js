/* ==========================================================================
   CGI 주문 관리 (staff) — issue #67
   - 서버 모드만 지원 (관리자 토큰 + Worker API)
   - 목록/검색, 상세, 상태 변경, 배송, 환불, 견적 가격 확정, ERP 동기화 시도
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.CGI_SITE_CONFIG || {};
  var API = cfg.orderApiUrl || cfg.quoteApiUrl || '';
  var LS_KEY = 'cgiAdminToken';

  var STATUS_LABELS = {
    awaiting_payment: '결제 대기', paid: '결제 완료', processing: '처리 중', shipped: '배송 중',
    delivered: '배송 완료', refunding: '환불 처리 중', refunded: '환불 완료', cancelled: '취소',
    expired: '기한 만료', pending: '접수 대기', quoted: '견적 고지', completed: '완료'
  };
  var PAYMENT_LABELS = {
    none: '미결제', pending: '결제 대기', paid: '결제 완료', failed: '결제 실패',
    expired: '결제 만료', partial_refunded: '부분 환불', refunded: '환불 완료'
  };
  var DELIVERY_LABELS = {
    pending: '배송 대기', processing: '준비 중', shipped: '배송 중', delivered: '배송 완료', returned: '반품'
  };
  var ERP_LABELS = {
    not_sent: '미전송', pending: '전송 대기', sent: '전송 완료', confirmed: '등록 확인',
    failed: '실패', skipped: '건너뜀(테스트)'
  };

  var state = { token: null, orders: [], drawer: null, events: [] };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function kindLabel(k) { return k === 'quote' ? '견적' : '결제'; }
  function msg(el, text, kind) {
    el.innerHTML = text ? '<p class="staff-msg ' + (kind || 'info') + '">' + esc(text) + '</p>' : '';
  }
  function parseJson(s) {
    if (s == null) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function request(method, path, body) {
    if (!state.token) return Promise.reject(new Error('token'));
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token };
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      });
  }

  /* ------------------------------------------------------------ bootstrap */
  function boot() {
    if (!API) {
      $('authBox').hidden = false;
      $('authBox').insertAdjacentHTML('beforeend', '<p class="staff-msg error">API 주소가 설정되지 않았습니다.</p>');
      return;
    }
    state.token = localStorage.getItem(LS_KEY);
    if (!state.token) { $('authBox').hidden = false; return; }
    $('authBox').hidden = true;
    $('ordersApp').hidden = false;
    fillFilters();
    load();
  }

  function fillFilters() {
    var statusSel = $('filterStatus');
    Object.keys(STATUS_LABELS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = STATUS_LABELS[k];
      statusSel.appendChild(o);
    });
    var paySel = $('filterPayment');
    Object.keys(PAYMENT_LABELS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = PAYMENT_LABELS[k];
      paySel.appendChild(o);
    });
  }

  /* ------------------------------------------------------------ list */
  function load() {
    var p = [];
    if ($('filterKind').value) p.push('kind=' + encodeURIComponent($('filterKind').value));
    if ($('filterStatus').value) p.push('status=' + encodeURIComponent($('filterStatus').value));
    if ($('filterPayment').value) p.push('payment_status=' + encodeURIComponent($('filterPayment').value));
    if ($('filterQ').value.trim()) p.push('q=' + encodeURIComponent($('filterQ').value.trim()));
    var query = p.length ? '?' + p.join('&') : '';

    $('orderList').innerHTML = '<p class="staff-msg info">불러오는 중…</p>';
    request('GET', '/api/orders' + query).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) { state.token = null; localStorage.removeItem(LS_KEY); $('ordersApp').hidden = true; $('authBox').hidden = false; return; }
        msg($('orderList'), '주문 목록을 불러오지 못했습니다 (HTTP ' + res.status + ').');
        return;
      }
      state.orders = res.data.items || [];
      renderList();
    }).catch(function (err) {
      msg($('orderList'), '네트워크 오류: ' + (err && err.message || err));
    });
  }

  function renderList() {
    var box = $('orderList');
    if (!state.orders.length) {
      box.innerHTML = '<p class="staff-msg info">조건에 맞는 주문이 없습니다.</p>';
      return;
    }
    var html = '<div class="order-table-wrap"><table class="order-table"><thead><tr>' +
      '<th>주문번호</th><th>유형</th><th>회사</th><th>연락처</th><th>금액</th><th>주문 상태</th><th>결제</th><th>ERP</th><th>주문일</th><th></th>' +
      '</tr></thead><tbody>';
    state.orders.forEach(function (o) {
      html += '<tr>' +
        '<td class="mono">' + esc(o.id) + '</td>' +
        '<td>' + esc(kindLabel(o.kind)) + '</td>' +
        '<td>' + esc(o.customer_company || '—') + '</td>' +
        '<td>' + esc(o.customer_phone || '—') + '</td>' +
        '<td>' + (o.total_amount ? money(o.total_amount) : '—') + '</td>' +
        '<td><span class="pill">' + esc(STATUS_LABELS[o.status] || o.status) + '</span></td>' +
        '<td><span class="pill">' + esc(PAYMENT_LABELS[o.payment_status] || o.payment_status) + '</span></td>' +
        '<td><span class="pill">' + esc(ERP_LABELS[o.erp_status] || o.erp_status) + '</span></td>' +
        '<td>' + esc(fmtDate(o.created_at)) + '</td>' +
        '<td><button type="button" class="btn btn-secondary btn-sm" data-open="' + esc(o.id) + '">상세</button></td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (btn) {
      btn.addEventListener('click', function () { openDrawer(btn.getAttribute('data-open')); });
    });
  }

  /* ----------------------------------------------------------- drawer */
  function openDrawer(id) {
    $('drawer').hidden = false;
    $('drawerBody').innerHTML = '<p class="staff-msg info">불러오는 중…</p>';
    var body = '';
    request('GET', '/api/orders/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { msg($('drawerBody'), '주문을 불러오지 못했습니다 (HTTP ' + res.status + ').'); return; }
      state.drawer = res.data;
      renderDrawer();
      return request('GET', '/api/orders/' + encodeURIComponent(id) + '/events');
    }).then(function (res) {
      state.events = (res && res.ok) ? (res.data.items || []) : [];
      var box = $('drawerEvents');
      if (box) renderEvents();
    }).catch(function (err) {
      msg($('drawerBody'), '오류: ' + (err && err.message || err));
    });
  }

  function renderDrawer() {
    var o = state.drawer;
    if (!o) return;
    var html = '';
    html += '<div class="drawer-head">' +
      '<p class="drawer-id mono">' + esc(o.id) + '</p>' +
      '<p>' + esc(kindLabel(o.kind)) + ' · <span class="pill">' + esc(STATUS_LABELS[o.status] || o.status) + '</span>' +
      ' <span class="pill">' + esc(PAYMENT_LABELS[o.payment_status] || o.payment_status) + '</span>' +
      ' <span class="pill">배송: ' + esc(DELIVERY_LABELS[o.delivery_status] || o.delivery_status) + '</span>' +
      ' <span class="pill">ERP: ' + esc(ERP_LABELS[o.erp_status] || o.erp_status) + '</span></p>' +
      '<p class="muted">' + esc(fmtDate(o.created_at)) + (o.paid_at ? ' · 결제 ' + esc(fmtDate(o.paid_at)) : '') + '</p>' +
    '</div>';

    var adminPrices = parseJson(o.admin_prices) || {};
    html += '<section class="drawer-section"><h3>상품 (' + (o.items || []).length + '개)</h3>' +
      '<table class="order-table"><thead><tr><th>상품</th><th>단가</th><th>수량</th><th>금액</th><th>상태</th></tr></thead><tbody>';
    (o.items || []).forEach(function (it) {
      var admin = adminPrices[it.product_id];
      html += '<tr><td>' + esc(it.product_name) + (it.brand ? '<br><small class="muted">' + esc(it.brand) + '</small>' : '') + '</td>' +
        '<td data-label="단가">' + (it.unit_price ? money(it.unit_price) + (admin && admin !== it.unit_price ? '<br><small class="muted">최종 ' + money(admin) + '</small>' : '') : '<span class="muted">미확정</span>') + '</td>' +
        '<td data-label="수량">' + it.qty + '</td>' +
        '<td data-label="금액">' + (it.line_total ? money(it.line_total) : '—') + '</td>' +
        '<td data-label="상태">' + (it.price_state === 'public' ? '공개가' : '가격 문의') + '</td></tr>';
    });
    html += '</tbody></table></section>';

    html += '<section class="drawer-section"><h3>주문자</h3><dl class="kv">' +
      '<dt>회사</dt><dd>' + esc(o.customer_company || '—') + '</dd>' +
      '<dt>담당자</dt><dd>' + esc(o.customer_name || '—') + '</dd>' +
      '<dt>연락처</dt><dd>' + esc(o.customer_phone || '—') + '</dd>' +
      '<dt>이메일</dt><dd>' + esc(o.customer_email || '—') + '</dd>' +
      '<dt>주소</dt><dd>' + esc([o.customer_addr, o.customer_addr_detail].filter(Boolean).join(' / ') || '—') + '</dd>' +
      '<dt>메모</dt><dd>' + esc(o.customer_note || '—') + '</dd>' +
      (o.source_quote_id ? '<dt>견적 번호</dt><dd class="mono">' + esc(o.source_quote_id) + '</dd>' : '') +
      '</dl></section>';

    var t = o.totals || {};
    html += '<section class="drawer-section"><h3>금액</h3><dl class="kv">' +
      '<dt>상품 합계</dt><dd>' + money(t.item_total) + '</dd>' +
      '<dt>배송비</dt><dd>' + money(t.shipping_fee) + '</dd>' +
      '<dt>공급가</dt><dd>' + money(t.supplied_amount) + '</dd>' +
      '<dt>부가세</dt><dd>' + money(t.vat_amount) + '</dd>' +
      '<dt>총액</dt><dd class="strong">' + money(t.total_amount) + '</dd>' +
      (t.refunded_amount ? '<dt>환불액</dt><dd class="warn">' + money(t.refunded_amount) + '</dd>' : '') +
      (o.payment_method ? '<dt>결제 수단</dt><dd>' + esc(o.payment_method) + '</dd>' : '') +
      (o.payment_key ? '<dt>결제 키</dt><dd class="mono">' + esc(o.payment_key) + '</dd>' : '') +
      '</dl></section>';

    html += '<section class="drawer-section"><h3>상태 변경</h3>' +
      '<form id="statusForm" class="inline-form">' +
        '<label>주문 상태<select name="status"></select></label>' +
        '<button type="submit" class="btn">적용</button>' +
      '</form>' +
      '<form id="deliveryForm" class="inline-form">' +
        '<label>배송 상태<select name="delivery_status"></select></label>' +
        '<label>배송 추적<input name="delivery_tracking" value="' + esc(o.delivery_tracking || '') + '" maxlength="100"></label>' +
        '<button type="submit" class="btn">적용</button>' +
      '</form>' +
      '<form id="noteForm" class="inline-form">' +
        '<label>관리자 메모<textarea name="admin_note" rows="2" maxlength="2000">' + esc(o.admin_note || '') + '</textarea></label>' +
        '<button type="submit" class="btn">저장</button>' +
      '</form>' +
      '<p id="actionMsg"></p>' +
    '</section>';

    var refundable = Math.max(0, (t.total_amount || 0) - (t.refunded_amount || 0));
    var canRefund = o.payment_key && refundable > 0;
    html += '<section class="drawer-section"><h3>환불</h3>' +
      (canRefund
        ? '<p>환불 가능 잔액: <strong>' + money(refundable) + '</strong></p>' +
          '<form id="refundForm" class="inline-form">' +
            '<label>환불 금액<input name="cancelAmount" type="number" min="1000" step="100" value="' + refundable + '"></label>' +
            '<label>사유<input name="cancelReason" maxlength="200" placeholder="고객 요청 취소/환불"></label>' +
            '<button type="submit" class="btn btn-secondary">환불 처리</button>' +
          '</form>'
        : '<p class="muted">환불할 결제가 없거나 잔액이 소진되었습니다.</p>') +
      '<p>ERP 동기화 상태: <span class="pill">' + esc(ERP_LABELS[o.erp_status] || o.erp_status) + '</span>' +
        (o.erp_sent_at ? ' · ' + esc(fmtDate(o.erp_sent_at)) : '') + '</p>' +
      '<div class="inline-form">' +
        '<button type="button" class="btn btn-secondary" id="erpBtn">ERP 페이로드 동기화 시도</button>' +
        '<button type="button" class="btn btn-secondary" id="erpRetryBtn">강제 재시도</button>' +
      '</div>' +
    '</section>';

    if (o.kind === 'quote') {
      html += '<section class="drawer-section"><h3>가격 확정</h3>' +
        '<p class="muted">가격 미확정 항목에 공급가를 입력해 확정합니다. 확정하면 견적 고지 상태로 바뀝니다.</p>' +
        '<form id="priceForm"><table class="order-table"><thead><tr><th>상품</th><th>공급가(원)</th></tr></thead><tbody>';
      (o.items || []).forEach(function (it) {
        html += '<tr><td>' + esc(it.product_name) + '</td><td><input type="number" min="1" step="1" name="price-' + esc(it.product_id) + '" value="' + esc(adminPrices[it.product_id] || '') + '"></td></tr>';
      });
      html += '</tbody></table>' +
        '<div class="inline-form">' +
          '<button type="submit" class="btn">가격 확정 (견적 유지)</button>' +
          '<button type="button" class="btn btn-secondary" id="priceConvertBtn">확정 후 결제 주문으로 전환</button>' +
        '</div>' +
      '</form></section>';
    }

    html += '<section class="drawer-section"><h3>이력</h3><div id="drawerEvents"></div></section>';

    $('drawerBody').innerHTML = html;
    bindDrawer(o, refundable);
  }

  function renderEvents() {
    var box = $('drawerEvents');
    if (!box) return;
    if (!state.events.length) { box.innerHTML = '<p class="muted">이력이 없습니다.</p>'; return; }
    var html = '<ol class="event-list">';
    state.events.slice().reverse().forEach(function (e) {
      var meta = '';
      try { meta = JSON.stringify(JSON.parse(e.meta || '{}')); } catch (err) { meta = String(e.meta || ''); }
      html += '<li><strong>' + esc(e.type) + '</strong>' +
        (e.from_status || e.to_status ? ' <span class="muted">' + esc(e.from_status || '') + ' → ' + esc(e.to_status || '') + '</span>' : '') +
        '<br><small class="muted">' + esc(fmtDate(e.created_at)) + ' · ' + esc(e.actor || '') + (meta ? ' · ' + esc(meta) : '') + (e.error ? ' · <span class="warn">' + esc(e.error) + '</span>' : '') + '</small></li>';
    });
    box.innerHTML = html + '</ol>';
  }

  function bindDrawer(o, refundable) {
    function patch(body, cb) {
      msg($('actionMsg'), '처리 중…');
      request('PATCH', '/api/orders/' + encodeURIComponent(o.id), body).then(function (res) {
        if (!res.ok) { msg($('actionMsg'), '실패: ' + (res.data.error || ('HTTP ' + res.status)), 'error'); return; }
        msg($('actionMsg'), res.data.changed === false ? '변경할 항목이 없습니다.' : '변경했습니다.', 'ok');
        if (cb) cb(); else openDrawer(o.id);
      });
    }

    var st = $('statusForm');
    if (st) {
      var sel = st.querySelector('[name="status"]');
      var cur = document.createElement('option');
      cur.value = o.status; cur.textContent = STATUS_LABELS[o.status] || o.status;
      sel.appendChild(cur);
      var allow = ({
        purchase: { awaiting_payment: ['paid', 'cancelled', 'expired'], paid: ['processing', 'shipped', 'refunding', 'cancelled'], processing: ['shipped', 'delivered', 'refunding', 'cancelled'], shipped: ['delivered', 'refunding', 'cancelled'], delivered: ['refunding'], refunding: ['refunded', 'processing'], refunded: [], cancelled: [], expired: [] },
        quote: { pending: ['quoted', 'paid', 'cancelled'], quoted: ['paid', 'cancelled'], paid: ['processing', 'shipped', 'refunding', 'cancelled'], processing: ['shipped', 'delivered', 'refunding', 'cancelled'], shipped: ['delivered', 'refunding', 'cancelled'], delivered: ['refunding'], refunding: ['refunded', 'processing'], refunded: [], cancelled: [], completed: [] }
      })[o.kind] || {};
      (allow[o.status] || []).forEach(function (s) {
        if (s === o.status) return;
        var op = document.createElement('option');
        op.value = s; op.textContent = STATUS_LABELS[s] || s;
        sel.appendChild(op);
      });
      st.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var v = sel.value;
        if (v === o.status) { msg($('actionMsg'), '현재와 같은 상태입니다.', 'info'); return; }
        patch({ status: v });
      });
    }

    var df = $('deliveryForm');
    if (df) {
      var dsel = df.querySelector('[name="delivery_status"]');
      Object.keys(DELIVERY_LABELS).forEach(function (k) {
        var op = document.createElement('option');
        op.value = k; op.textContent = DELIVERY_LABELS[k];
        if (k === o.delivery_status) op.selected = true;
        dsel.appendChild(op);
      });
      df.addEventListener('submit', function (ev) {
        ev.preventDefault();
        patch({
          delivery_status: df.querySelector('[name="delivery_status"]').value,
          delivery_tracking: df.querySelector('[name="delivery_tracking"]').value.trim() || null
        });
      });
    }

    var nf = $('noteForm');
    if (nf) nf.addEventListener('submit', function (ev) {
      ev.preventDefault();
      patch({ admin_note: nf.querySelector('[name="admin_note"]').value.trim() || null });
    });

    var rf = $('refundForm');
    if (rf) rf.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var amount = parseInt(rf.querySelector('[name="cancelAmount"]').value, 10);
      var reason = rf.querySelector('[name="cancelReason"]').value.trim() || '고객 요청 취소/환불';
      if (!amount || amount < 1000) { msg($('actionMsg'), '환불 금액은 1,000원 이상이어야 합니다.', 'error'); return; }
      if (amount > refundable) { msg($('actionMsg'), '환불 금액이 잔액(' + money(refundable) + ')을 초과합니다.', 'error'); return; }
      msg($('actionMsg'), '환불 처리 중…');
      request('POST', '/api/orders/' + encodeURIComponent(o.id) + '/payments/' + encodeURIComponent(o.payment_key) + '/cancel', { cancelAmount: amount, cancelReason: reason })
        .then(function (res) {
          if (!res.ok) { msg($('actionMsg'), '환불 실패: ' + (res.data.error || ('HTTP ' + res.status)), 'error'); return; }
          msg($('actionMsg'), '환불 처리했습니다. 환불액 ' + money(res.data.cancel_amount), 'ok');
          load();
          openDrawer(o.id);
        });
    });

    function erp(retry) {
      msg($('actionMsg'), 'ERP 동기화 시도 중…');
      request('POST', '/api/orders/' + encodeURIComponent(o.id) + '/erp' + (retry ? '/retry' : ''), {})
        .then(function (res) {
          if (!res.ok) { msg($('actionMsg'), 'ERP 동기화 실패 (HTTP ' + res.status + '), ' + ' ' + (res.data.error || ''), 'error'); return; }
          var d = res.data;
          msg($('actionMsg'), 'ERP: ' + esc(String(d.status)) + (d.mode ? ' · 모드 ' + esc(String(d.mode)) : '') + (d.sent ? ' · 전송됨' : ' · 미전송(테스트 모드)') + (d.note ? ' · ' + esc(String(d.note)) : ''), d.sent ? 'ok' : 'info');
          load();
          openDrawer(o.id);
        });
    }
    var eb = $('erpBtn'); if (eb) eb.addEventListener('click', function () { erp(false); });
    var er = $('erpRetryBtn'); if (er) er.addEventListener('click', function () { erp(true); });

    var pf = $('priceForm');
    if (pf) {
      function submit(convert) {
        var prices = {};
        var bad = false;
        (o.items || []).forEach(function (it) {
          var el = pf.querySelector('[name="price-' + it.product_id + '"]');
          var v = el ? parseInt(el.value, 10) : NaN;
          if (!v || v <= 0) { bad = true; return; }
          prices[it.product_id] = v;
        });
        if (bad) { msg($('actionMsg'), '모든 항목에 유효한 공급가를 입력해 주세요.', 'error'); return; }
        msg($('actionMsg'), '가격 확정 중…');
        request('POST', '/api/orders/' + encodeURIComponent(o.id) + '/quote/prices', { admin_prices: prices, convert: !!convert })
          .then(function (res) {
            if (!res.ok) { msg($('actionMsg'), '확정 실패: ' + (res.data.error || ('HTTP ' + res.status)), 'error'); return; }
            msg($('actionMsg'), convert ? '가격 확정 및 결제 주문 전환했습니다.' : '가격을 확정했습니다.', 'ok');
            load();
            openDrawer(o.id);
          });
      }
      pf.addEventListener('submit', function (ev) { ev.preventDefault(); submit(false); });
      var pb = $('priceConvertBtn'); if (pb) pb.addEventListener('click', function () { submit(true); });
    }
  }

  /* ---------------------------------------------------------- wiring */
  document.addEventListener('DOMContentLoaded', function () {
    $('drawerClose').addEventListener('click', function () { $('drawer').hidden = true; state.drawer = null; });
    $('authBtn').addEventListener('click', function () {
      var v = $('tokenInput').value.trim();
      if (!v) return;
      state.token = v;
      localStorage.setItem(LS_KEY, v);
      $('authBox').hidden = true;
      $('ordersApp').hidden = false;
      fillFilters();
      load();
    });
    $('tokenInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('authBtn').click(); });
    $('logoutBtn').addEventListener('click', function () {
      state.token = null;
      localStorage.removeItem(LS_KEY);
      $('ordersApp').hidden = true;
      $('authBox').hidden = false;
      $('orderList').innerHTML = '';
    });
    $('refreshBtn').addEventListener('click', load);
    ['filterKind', 'filterStatus', 'filterPayment'].forEach(function (id) {
      $(id).addEventListener('change', load);
    });
    var timer = null;
    $('filterQ').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(load, 350);
    });
    boot();
  });
})();
