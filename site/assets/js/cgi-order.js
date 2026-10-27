/* ==========================================================================
   CGI 주문·결제 프런트엔드 모듈 (issue #67)
   - 카탈로그 장바구니 -> 주문 생성 -> 결제 -> 완료 화면
   - 가격 미확정 상품이 있으면 견적 요청 흐름으로 자동 분기
   - 토스페이먼츠 키가 없으면 "테스트 결제" 시뮬레이션 모드로 동작
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.CGI_SITE_CONFIG || {};
  var PRODUCTS = window.CGI_PRODUCTS || [];
  var SERVICES = window.CGI_SERVICES || [];
  var API = cfg.orderApiUrl || cfg.quoteApiUrl || '';
  var TOSS_CLIENT_ID = cfg.tossClientId || '';
  var TOSS_JS_URL = cfg.tossJsUrl || 'https://js.tosspayments.com/v2/standard';
  var PG_PROVIDER = String(cfg.pgProvider || 'tosspayments').toLowerCase();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
  function fmtDate(value) {
    if (!value) return '미확인';
    var d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function findProduct(id) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === id) return PRODUCTS[i];
    return null;
  }
  function isPublicPrice(product) {
    return !!(product && product.price && product.price.state === 'public' && product.price.value !== null && product.price.value !== undefined);
  }
  function serviceName(id) {
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].id === id) return SERVICES[i].name;
    return id;
  }

  /* ----------------------------------------------------------- cart payload */
  function readCart() {
    try {
      var raw = localStorage.getItem('cgiQuoteCart') || '[]';
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(function (x) { return x && typeof x.id === 'string' && x.id; }) : [];
    } catch (e) { return []; }
  }
  function readServices() {
    try {
      var list = JSON.parse(localStorage.getItem('cgiQuoteCartServices') || '[]');
      return Array.isArray(list) ? list.filter(function (s) { return typeof s === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function cartItems() {
    return readCart().map(function (x) {
      return { cart: { id: x.id, qty: Math.max(1, parseInt(x.qty, 10) || 1) }, product: findProduct(x.id) };
    }).filter(function (x) { return x.product; });
  }
  function cartPayable() {
    var items = cartItems();
    return items.length > 0 && items.every(function (x) { return isPublicPrice(x.product); });
  }
  function orderPayload(customer) {
    var items = cartItems().map(function (x) {
      var p = x.product;
      return {
        product_id: p.id,
        qty: x.cart.qty,
        unit_price: isPublicPrice(p) ? Number(p.price.value) : null,
        name: p.name,
        brand: p.brand_norm || p.brand || p.manufacturer || null,
        category: (p.category && p.category.name) || (p.category_path && p.category_path[p.category_path.length - 1]) || null
      };
    });
    return Object.assign({ items: items, services: readServices() }, customer);
  }

  /* --------------------------------------------------------------- api */
  function api(method, path, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      }).catch(function (err) { return { ok: false, status: 0, data: { error: 'network', detail: String(err && err.message || err) } }; });
  }
  function requestKey() {
    if (window.crypto && window.crypto.randomUUID) return 'order-' + window.crypto.randomUUID();
    return 'order-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ------------------------------------------------------------- render */
  var STATUS_LABELS = {
    awaiting_payment: '결제 대기', paid: '결제 완료', processing: '처리 중', shipped: '배송 중',
    delivered: '배송 완료', refunding: '환불 처리 중', refunded: '환불 완료', cancelled: '취소됨',
    expired: '기한 만료', quoted: '견적 발송', received: '접수됨', pending: '대기', completed: '완료'
  };
  function statusLabel(s) { return STATUS_LABELS[s] || s || '미확인'; }

  function shell(inner) {
    return '<section class="order-page">' + inner + '</section>';
  }
  function flash(msg, cls) {
    return '<p class="order-flash ' + (cls || 'flash-warn') + '">' + esc(msg) + '</p>';
  }

  function renderCheckout(app) {
    var items = cartItems();
    if (!API) {
      app.innerHTML = shell(
        '<div class="page-head"><p class="page-eyebrow">CHECKOUT</p><h1>주문 접수</h1></div>' +
        flash('결제 서버 주소가 설정되어 있지 않아 주문을 보낼 수 없습니다. 견적 요청을 이용해 주세요.', 'flash-warn') +
        '<p><a class="btn" href="#/quote-cart">견적 목록으로</a></p>'
      );
      return;
    }
    if (!items.length) {
      app.innerHTML = shell(
        '<div class="page-head"><p class="page-eyebrow">CHECKOUT</p><h1>주문 접수</h1></div>' +
        flash('주문할 상품이 없습니다. 상품 목록에서 상품을 담아 주세요.', 'flash-warn') +
        '<p><a class="btn" href="#/products">전체 상품</a></p>'
      );
      return;
    }
    if (!cartPayable()) {
      app.innerHTML = shell(
        '<div class="page-head"><p class="page-eyebrow">CHECKOUT</p><h1>주문 접수</h1></div>' +
        '<div class="quote-branch">' +
          '<h2>이 장바구니는 결제 대신 견적 요청으로 접수됩니다</h2>' +
          '<p>아래 상품은 판매가가 미확정 상태라서 온라인 결제를 할 수 없습니다. 견적 요청을 보내면 담당자가 가격을 확인 후 안내해 드립니다.</p>' +
          '<table class="order-items"><thead><tr><th>상품</th><th>수량</th><th>공개가</th></tr></thead><tbody>' +
          items.map(function (x) {
            return '<tr><td>' + esc(x.product.name) + '</td><td>' + x.cart.qty + '</td><td>' +
              (isPublicPrice(x.product) ? money(x.product.price.value) : '<span class="badge inquiry">가격 문의</span>') + '</td></tr>';
          }).join('') +
          '</tbody></table>' +
        '</div>' +
        '<p><a class="btn" href="#/quote-cart">견적 요청으로 접수하기</a> <a class="btn btn-secondary" href="#/products">상품 더 담기</a></p>'
      );
      return;
    }
    app.innerHTML = shell(
      '<div class="page-head"><p class="page-eyebrow">CHECKOUT</p><h1>주문 접수</h1></div>' +
      '<form id="orderForm" class="order-form" novalidate>' +
        '<div class="order-columns">' +
          '<fieldset class="order-fieldset">' +
            '<legend>결제자 · 배송 정보</legend>' +
            '<label>회사/기관명<input name="company" required maxlength="200" placeholder="(주)예시 회사"></label>' +
            '<label>담당자명<input name="name" required maxlength="100" placeholder="홍길동"></label>' +
            '<label>연락처<input name="phone" required maxlength="40" inputmode="tel" placeholder="010-0000-0000"></label>' +
            '<label>이메일<input name="email" type="email" maxlength="200" placeholder="you@company.com"></label>' +
            '<label>배송/설치 주소<input name="addr" maxlength="200" placeholder="도로명 주소"></label>' +
            '<label>상세 주소<input name="addr_detail" maxlength="200"></label>' +
            '<label>주문 메모<textarea name="note" maxlength="2000" rows="3" placeholder="설치 일정, 요청 사항 등"></textarea></label>' +
          '</fieldset>' +
          '<aside class="order-summary">' +
            '<h2>주문 내역</h2>' +
            '<table class="order-items"><thead><tr><th>상품</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>' +
            items.map(function (x) {
              var p = x.product, unit = Number(p.price.value);
              return '<tr><td>' + esc(p.name) + '<small>' + esc(p.brand_norm || p.brand || '') + '</small></td><td>' + x.cart.qty + '</td><td>' + money(unit) + '</td><td>' + money(unit * x.cart.qty) + '</td></tr>';
            }).join('') +
            '</tbody></table>' +
            '<p class="order-summary-note">금액은 서버에서 카탈로그 가격 기준으로 재계산됩니다. 고객님이 입력한 금액은 무시됩니다.</p>' +
            '<div id="orderTotal" class="order-total"></div>' +
          '</aside>' +
        '</div>' +
        '<div id="orderStatus"></div>' +
        '<div class="order-actions">' +
          '<button type="submit" class="btn">주문 생성 후 결제</button>' +
          '<a class="btn btn-secondary" href="#/quote-cart">취소</a>' +
        '</div>' +
      '</form>'
    );

    var form = app.querySelector('#orderForm');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var status = app.querySelector('#orderStatus');
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = '주문 생성 중…';
      status.innerHTML = '';

      var customer = {};
      ['company', 'name', 'phone', 'email', 'addr', 'addr_detail', 'note'].forEach(function (k) {
        var el = form.querySelector('[name="' + k + '"]');
        customer[k] = el && el.value ? el.value.trim() : '';
      });
      if (!customer.company || !customer.name || !customer.phone) {
        status.innerHTML = flash('회사명, 담당자명, 연락처는 필수입니다.', 'flash-error');
        btn.disabled = false;
        btn.textContent = '주문 생성 후 결제';
        return;
      }

      var payload = orderPayload(customer);
      payload.idempotency_key = requestKey();
      var member = window.CGI_AUTH && window.CGI_AUTH.isLoggedIn();
      var send = member
        ? function (path, body) { return window.CGI_AUTH.api('POST', path, body); }
        : function (path, body) { return api('POST', path, body); };
      send(member ? '/api/me/orders' : '/api/orders', payload).then(function (res) {
        if (!res.ok) {
          status.innerHTML = flash('주문 생성 실패: ' + (res.data.error || ('HTTP ' + res.status)), 'flash-error');
          btn.disabled = false;
          btn.textContent = '다시 시도';
          return;
        }
        renderPayment(app, res.data);
      });
    });
  }

  function renderPayment(app, order) {
    if (PG_PROVIDER === 'nicepay') return renderNicepayPayment(app, order);
    var testMode = !TOSS_CLIENT_ID;
    var sandboxMode = !!TOSS_CLIENT_ID && String(TOSS_CLIENT_ID).indexOf('test_') === 0;
    app.innerHTML = shell(
      '<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제</h1></div>' +
      '<div class="payment-card">' +
        (sandboxMode ? '<p class="test-payment-badge">TEST 결제 — 토스페이먼츠 테스트 환경 (실제 청구 없음)</p>' : '') +
        '<div class="payment-order">' +
          '<p><strong>' + esc(order.id) + '</strong></p>' +
          '<p class="order-total">주문 금액 <strong>' + money(order.totals.total_amount) + '</strong></p>' +
          '<p class="muted">공급가 ' + money(order.totals.supplied_amount) + ' + 부가세 ' + money(order.totals.vat_amount) + '</p>' +
        '</div>' +
        '<div class="payment-methods">' +
          '<label><input type="radio" name="method" value="카드" checked> 카드</label>' +
          '<label><input type="radio" name="method" value="간편결제"> 간편결제</label>' +
          '<label><input type="radio" name="method" value="휴대폰"> 휴대폰</label>' +
        '</div>' +
        (testMode
          ? '<div class="test-payment"><p class="test-payment-badge">테스트 결제</p>' +
            '<p>토스페이먼츠 키가 서버에 등록되어 있지 않아 실제 결제 대신 <strong>모의 승인</strong>이 수행됩니다. 실제 결제가 진행되지 않습니다.</p></div>'
          : '<div id="tossPayment"></div><div id="tossAgreement"></div>') +
        '<div id="paymentStatus"></div>' +
        '<div class="order-actions">' +
          '<button type="button" class="btn" id="payBtn">결제 승인</button>' +
          '<a class="btn btn-secondary" href="#/quote-cart">나중에 하기</a>' +
        '</div>' +
      '</div>'
    );

    var statusBox = app.querySelector('#paymentStatus');
    var payBtn = app.querySelector('#payBtn');
    function run(key) {
      payBtn.disabled = true;
      payBtn.textContent = '결제 처리 중…';
      statusBox.innerHTML = '';
      var method = (app.querySelector('input[name="method"]:checked') || {}).value || '카드';
      api('POST', '/api/payments/confirm', { orderId: order.id, paymentKey: key, amount: order.totals.total_amount, paymentMethod: method })
        .then(function (res) {
          if (!res.ok) {
            statusBox.innerHTML = flash('결제가 실패했습니다. (' + (res.data.error || 'HTTP ' + res.status) + ') 결제 정보를 다시 받아서 시도해 주세요.', 'flash-error');
            payBtn.disabled = false;
            payBtn.textContent = '결제 다시 시도';
            return;
          }
          renderComplete(app, res.data.order, res.data);
        });
    }

    if (testMode) {
      payBtn.addEventListener('click', function () { run('test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); });
      return;
    }

    var script = document.createElement('script');
    script.src = TOSS_JS_URL;
    script.onload = function () {
      if (!window.TossPayments) {
        statusBox.innerHTML = flash('결제 모듈을 불러오지 못했습니다. 서버에서 테스트 결제 모드로 전환해 주세요.', 'flash-error');
        return;
      }
      var tossPayments = window.TossPayments(TOSS_CLIENT_ID);
      var widgets = tossPayments.widgets({ customerKey: 'ANONYMOUS' });
      (async function () {
        try {
          await widgets.setAmount({ currency: 'KRW', value: order.totals.total_amount });
          await Promise.all([
            widgets.renderPaymentMethods({ selector: '#tossPayment', variantKey: 'DEFAULT' }),
            widgets.renderAgreement({ selector: '#tossAgreement', variantKey: 'AGREEMENT' })
          ]);
        } catch (e) {
          statusBox.innerHTML = flash('결제 모듈 렌더링 실패. (' + esc((e && e.message) || 'fail') + ')', 'flash-error');
        }
      })();
      payBtn.addEventListener('click', async function () {
        statusBox.innerHTML = '';
        payBtn.disabled = true;
        payBtn.textContent = '결제창 이동 중…';
        try {
          await widgets.requestPayment({
            orderId: order.id,
            orderName: 'CGI 상품 주문',
            successUrl: window.location.origin + window.location.pathname + '?toss=success#/order/' + encodeURIComponent(order.id),
            failUrl: window.location.origin + window.location.pathname + '?toss=fail#/order/' + encodeURIComponent(order.id)
          });
        } catch (err) {
          statusBox.innerHTML = flash('결제 프로세스를 끝까지 마치지 못했습니다. (' + esc((err && err.message) || 'fail') + ')', 'flash-error');
          payBtn.disabled = false;
          payBtn.textContent = '결제 다시 시도';
        }
      });
    };
    script.onerror = function () {
      statusBox.innerHTML = flash('결제 모듈 로드 실패. 결제 서버에서 테스트 결제 모드로 전환해 주세요.', 'flash-error');
    };
    document.head.appendChild(script);
  }

  function renderComplete(app, order, paymentInfo) {
    var testPayment = paymentInfo && paymentInfo.payment && paymentInfo.payment.provider_mode === 'mock';
    app.innerHTML = shell(
      '<div class="page-head"><p class="page-eyebrow">ORDER COMPLETE</p><h1>주문이 접수되었습니다</h1></div>' +
      '<div class="complete-card">' +
        '<p class="complete-id">' + esc(order.id) + '</p>' +
        '<p class="complete-status">상태: <strong>' + esc(order.status_label || statusLabel(order.status)) + '</strong></p>' +
        '<p class="order-total">결제 금액 <strong>' + money(order.totals.total_amount) + '</strong></p>' +
        (order.payment && order.payment.paid_at ? '<p class="muted">결제 완료 ' + esc(fmtDate(order.payment.paid_at)) + ' · ' + esc(order.payment.method || '카드') + '</p>' : '<p class="muted">결제 대기 중입니다.</p>') +
        (testPayment ? '<p class="test-payment-badge">테스트 결제 — 실제 카드 결제는 발생하지 않았습니다.</p>' : '') +
        '<table class="order-items"><thead><tr><th>상품</th><th>수량</th><th>단가</th><th>금액</th></tr></thead><tbody>' +
        (order.items || []).map(function (i) {
          return '<tr><td>' + esc(i.product_name) + '</td><td>' + i.qty + '</td><td>' + money(i.unit_price) + '</td><td>' + money(i.line_total) + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
        (order.status === 'awaiting_payment'
          ? '<div class="order-actions">' +
              '<button type="button" class="btn" id="repayBtn">결제 다시 진행</button>' +
              '<span class="muted">아직 결제되지 않은 주문입니다. 같은 주문번호로 결제를 이어갑니다(새 주문을 만들지 않습니다).</span>' +
            '</div><div id="repayHost"></div>'
          : '') +
        '<p class="muted">주문 내역은 담당자가 확인 후 배송 일정을 연락드립니다.</p>' +
        '<p><a class="btn" href="#/order/' + encodeURIComponent(order.id) + '">주문 상세 보기</a> <a class="btn btn-secondary" href="#/products">다시 쇼핑하기</a></p>' +
      '</div>'
    );

    var repayBtn = app.querySelector('#repayBtn');
    if (repayBtn) repayBtn.addEventListener('click', function () { startRepay(app, order.id, repayBtn); });
  }

  /**
   * 기존 주문 재결제. payability 와 금액은 서버가 판정한다
   * (POST /api/me/orders/:id/repay — 소유자·kind·status·payment_status·amount).
   */
  function startRepay(app, orderId, btn) {
    var host = app.querySelector('#repayHost');
    if (!host) return;
    if (!(window.CGI_AUTH && window.CGI_AUTH.isLoggedIn())) {
      host.innerHTML = flash('재결제는 로그인한 회원의 주문에서만 가능합니다. 회원 로그인 후 다시 시도해 주세요.', 'flash-error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '주문 확인 중…';
    host.innerHTML = '';
    window.CGI_AUTH.api('POST', '/api/me/orders/' + encodeURIComponent(orderId) + '/repay', {}).then(function (res) {
      btn.disabled = false;
      btn.textContent = '결제 다시 진행';
      if (!res.ok) {
        var d = res.data || {};
        host.innerHTML = flash('다시 결제할 수 없습니다: ' + esc(d.error || ('HTTP ' + res.status)) +
          (d.detail && d.detail.status ? ' (현재 상태 ' + esc(statusLabel(d.detail.status)) + ')' : ''), 'flash-error');
        return;
      }
      renderRepayPayment(host, res.data.payment || {});
    });
  }

  function renderRepayPayment(host, pay) {
    if (!TOSS_CLIENT_ID) {
      host.innerHTML = flash('결제 키가 설정되어 있지 않아 재결제를 진행할 수 없습니다. 관리자에게 문의해 주세요.', 'flash-error');
      return;
    }
    var sandboxBadge = String(TOSS_CLIENT_ID).indexOf('test_') === 0 ? ' (테스트 환경 — 실제 청구 없음)' : '';
    host.innerHTML =
      '<div class="payment-card">' +
        '<p class="test-payment-badge">재결제 — ' + esc(pay.order_id) + esc(sandboxBadge) + '</p>' +
        '<p class="order-total">결제 금액 <strong>' + money(pay.amount) + '</strong></p>' +
        '<div id="repayMethods"></div><div id="repayAgreement"></div>' +
        '<div id="repayStatus"></div>' +
        '<div class="order-actions"><button type="button" class="btn" id="repayPayBtn">결제 창 열기</button></div>' +
      '</div>';

    var statusBox = host.querySelector('#repayStatus');
    var payBtn = host.querySelector('#repayPayBtn');

    function mount() {
      if (!window.TossPayments) {
        statusBox.innerHTML = flash('결제 모듈을 불러오지 못했습니다.', 'flash-error');
        payBtn.disabled = false;
        payBtn.textContent = '결제 창 열기';
        return;
      }
      var widgets = window.TossPayments(TOSS_CLIENT_ID).widgets({ customerKey: 'ANONYMOUS' });
      widgets.setAmount({ currency: 'KRW', value: pay.amount })
        .then(function () {
          return Promise.all([
            widgets.renderPaymentMethods({ selector: '#repayMethods', variantKey: 'DEFAULT' }),
            widgets.renderAgreement({ selector: '#repayAgreement', variantKey: 'AGREEMENT' })
          ]);
        })
        .catch(function (e) {
          statusBox.innerHTML = flash('결제 수단을 불러오지 못했습니다. (' + esc((e && e.message) || 'fail') + ')', 'flash-error');
          payBtn.disabled = false;
          payBtn.textContent = '결제 창 열기';
        });
      payBtn.addEventListener('click', function () {
        statusBox.innerHTML = '';
        payBtn.disabled = true;
        payBtn.textContent = '결제창 이동 중…';
        widgets.requestPayment({
          orderId: pay.order_id,
          orderName: pay.order_name || 'CGI 상품 주문',
          successUrl: window.location.origin + window.location.pathname + '?toss=success#/order/' + encodeURIComponent(pay.order_id),
          failUrl: window.location.origin + window.location.pathname + '?toss=fail#/order/' + encodeURIComponent(pay.order_id)
        }).catch(function (err) {
          statusBox.innerHTML = flash('결제창을 열지 못했습니다. (' + esc((err && err.message) || 'fail') + ')', 'flash-error');
          payBtn.disabled = false;
          payBtn.textContent = '결제 창 열기';
        });
      });
    }

    if (window.TossPayments) { mount(); return; }
    var script = document.createElement('script');
    script.src = TOSS_JS_URL;
    script.onload = mount;
    script.onerror = function () {
      statusBox.innerHTML = flash('결제 모듈 로드 실패', 'flash-error');
      payBtn.disabled = false;
      payBtn.textContent = '결제 창 열기';
    };
    document.head.appendChild(script);
  }

  function renderOrderDetail(app, id) {
    app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">ORDER</p><h1>주문 상세</h1></div><p class="muted">주문을 불러오는 중입니다…</p>');
    api('GET', '/api/orders/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) {
        app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">ORDER</p><h1>주문 상세</h1></div>' + flash('주문을 찾을 수 없습니다. (' + esc(id) + ')', 'flash-error') + '<p><a class="btn" href="#/products">상품 목록</a></p>');
        return;
      }
      renderComplete(app, res.data, null);
    });
  }

  /* 재시도는 항상 기존 주문으로 되돌린다. #/checkout 으로 보내면 같은 장바구니로
     새 주문이 중복 생성된다. */
  function retryLink(orderId) {
    return orderId
      ? '<p><a class="btn" href="#/order/' + encodeURIComponent(orderId) + '">주문 상세에서 다시 결제</a></p>'
      : '<p><a class="btn" href="#/checkout">다시 시도</a></p>';
  }

  function handleTossRedirect(app) {
    var params = new URLSearchParams(window.location.search || '');
    var toss = params.get('toss');
    if (!toss) return false;
    var paymentKey = params.get('paymentKey');
    var orderId = params.get('orderId');
    var amount = params.get('amount');
    // clean query string so a reload does not re-trigger
    try {
      var cleanUrl = window.location.pathname + (location.hash || '');
      window.history.replaceState({}, document.title, cleanUrl);
    } catch (e) {}
    if (toss === 'fail') {
      var code = params.get('code') || '';
      var message = params.get('message') || '결제가 취소되었거나 실패했습니다.';
      app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 실패</h1></div>' + flash(message + (code ? ' (' + esc(code) + ')' : ''), 'flash-error') + retryLink(orderId));
      return true;
    }
    if (!paymentKey || !orderId || !amount) return false;
    app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 승인 중</h1></div><p class="muted">토스페이먼츠 승인 결과를 확인하고 있습니다…</p>');
    api('POST', '/api/payments/confirm', { orderId: orderId, paymentKey: paymentKey, amount: Number(amount) }).then(function (res) {
      if (!res.ok) {
        app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 승인 실패</h1></div>' + flash('결제 승인에 실패했습니다. (' + esc(res.data && res.data.error || ('HTTP ' + res.status)) + ')', 'flash-error') + retryLink(orderId));
        return;
      }
      api('GET', '/api/orders/' + encodeURIComponent(orderId)).then(function (r) {
        if (!r.ok) { app.innerHTML = shell(flash('주문 조회 실패', 'flash-error')); return; }
        renderComplete(app, r.data, res.data);
      });
    });
    return true;
  }


  /* --------------------------------------------------- NICEPAY 결제창 (issue #106)
     창은 NICEPAY 도메인에서 뜨고, 승인 결과는 브라우저가 returnUrl(워커)로 POST 된다.
     사이트는 금액을 보내지 않는다 — /api/payments/nicepay/window 가 서버의 주문 합계를
     그대로 되돌려 창 금액으로 쓴다. */
  function nicepayBadge(cfg) {
    var testish = cfg && (cfg.mode === 'sandbox' || cfg.mode === 'mock');
    return testish
      ? '<p class="test-payment-badge">TEST 결제 — NICEPAY ' + (cfg.mode === 'mock' ? '모의' : '샌드박스') + ' 환경 (실 결제 없음)</p>'
      : '';
  }

  function renderNicepayPayment(app, order) {
    app.innerHTML = shell(
      '<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제</h1></div>' +
      '<div class="payment-card">' +
        '<div class="payment-order">' +
          '<p><strong>' + esc(order.id) + '</strong></p>' +
          '<p class="order-total">주문 금액 <strong>' + money(order.totals.total_amount) + '</strong></p>' +
          '<p class="muted">공급가 ' + money(order.totals.supplied_amount) + ' + 부가세 ' + money(order.totals.vat_amount) + '</p>' +
        '</div>' +
        '<div class="payment-methods">' +
          '<label><input type="radio" name="method" value="card" checked> 카드</label>' +
          '<label><input type="radio" name="method" value="bank"> 계좌이체</label>' +
          '<label><input type="radio" name="method" value="cellphone"> 휴대폰</label>' +
        '</div>' +
        '<div id="nicepayNotice"></div>' +
        '<div id="paymentStatus"></div>' +
        '<div class="order-actions">' +
          '<button type="button" class="btn" id="payBtn">NICEPAY 결제창 열기</button>' +
          '<a class="btn btn-secondary" href="#/quote-cart">나중에 하기</a>' +
        '</div>' +
      '</div>'
    );

    var payBtn = app.querySelector('#payBtn');
    var statusBox = app.querySelector('#paymentStatus');
    var notice = app.querySelector('#nicepayNotice');

    api('GET', '/api/payments/config').then(function (res) {
      if (!res.ok || !res.data || res.data.provider !== 'nicepay') {
        payBtn.disabled = true;
        payBtn.textContent = '결제를 시작할 수 없습니다';
        notice.innerHTML = flash('서버가 NICEPAY 게이트웨이로 연결되어 있지 않습니다. (pgProvider 설정과 워커 PG_PROVIDER 를 확인하세요)', 'flash-error');
        return;
      }
      notice.innerHTML = nicepayBadge(res.data);
      payBtn.addEventListener('click', function () {
        payBtn.disabled = true;
        payBtn.textContent = '결제창 준비 중…';
        var method = (app.querySelector('input[name="method"]:checked') || {}).value || 'card';
        api('POST', '/api/payments/nicepay/window', { orderId: order.id, method: method }).then(function (w) {
          if (!w.ok) {
            statusBox.innerHTML = flash('결제창을 열 수 없습니다. (' + esc(w.data && w.data.error || ('HTTP ' + w.status)) + ')', 'flash-error');
            payBtn.disabled = false;
            payBtn.textContent = 'NICEPAY 결제창 열기';
            return;
          }
          launchNicepayWindow(w.data, function () {
            payBtn.disabled = false;
            payBtn.textContent = 'NICEPAY 결제창 열기';
            statusBox.innerHTML = flash('결제창을 불러오지 못했습니다. 네트워크나 팝업 차단 설정을 확인해 주세요.', 'flash-error');
          });
        });
      });
    });
  }

  function launchNicepayWindow(cfg, onFail) {
    function go() {
      if (!window.AUTHNICE || typeof window.AUTHNICE.requestPay !== 'function') { onFail(); return; }
      // 창이 브라우저에서 NICEPAY 도메인으로 이동하므로 버튼 상태를 되돌려 둔다.
      window.AUTHNICE.requestPay(Object.assign({}, cfg.request, {
        fnError: function (result) {
          onFail();
          try {
            alert('고객용: ' + ((result && result.msg) || '결제가 완료되지 않았습니다.') +
                  '\n개발자 확인: ' + ((result && result.errorMsg) || ''));
          } catch (e) {}
        }
      }));
    }
    if (window.AUTHNICE) { go(); return; }
    var script = document.createElement('script');
    script.src = cfg.sdkUrl;
    script.onload = go;
    script.onerror = onFail;
    document.head.appendChild(script);
  }

  function handleNicepayRedirect(app) {
    var params = new URLSearchParams(window.location.search || '');
    var flag = params.get('nicepay');
    if (!flag) return false;
    var hash = window.location.hash || '';
    var match = hash.match(/^#\/order\/([^/?]+)/);
    var orderId = match ? decodeURIComponent(match[1]) : '';
    try {
      window.history.replaceState({}, document.title, window.location.pathname + hash);
    } catch (e) {}
    if (flag !== 'success') {
      app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 실패</h1></div>' +
        flash('결제가 완료되지 않았습니다. 카드 인증을 다시 시도하거나 주문 상세에서 계속하세요.', 'flash-error') + retryLink(orderId));
      return true;
    }
    app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 승인 중</h1></div><p class="muted">NICEPAY 승인 결과를 확인하고 있습니다…</p>');
    api('GET', '/api/orders/' + encodeURIComponent(orderId)).then(function (r) {
      if (!r.ok) { app.innerHTML = shell(flash('주문 조회 실패', 'flash-error')); return; }
      if (r.data.payment_status !== 'paid') {
        app.innerHTML = shell('<div class="page-head"><p class="page-eyebrow">PAYMENT</p><h1>결제 확인 필요</h1></div>' +
          flash('서버가 아직 이 주문을 결제 완료로 표시하지 않습니다. 잠시 후 주문 상세에서 확인해 주세요.', 'flash-error') + retryLink(orderId));
        return;
      }
      renderComplete(app, r.data, null);
    });
    return true;
  }

  /* ----------------------------------------------------- public interface */
  window.CGI_ORDER = {
    api: api,
    cartItems: cartItems,
    cartPayable: cartPayable,
    readCart: readCart,
    clearCart: function () { try { localStorage.removeItem('cgiQuoteCart'); } catch (e) {} },
    renderCheckout: renderCheckout,
    renderOrderDetail: renderOrderDetail,
    handleTossRedirect: handleTossRedirect,
    handleNicepayRedirect: handleNicepayRedirect,
    statusLabel: statusLabel,
    config: { api: API, tossClientId: !!TOSS_CLIENT_ID, pgProvider: PG_PROVIDER }
  };
})();
