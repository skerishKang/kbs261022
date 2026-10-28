/* ==========================================================================
   CGI 고객 계정 프런트엔드 모듈 (issue #69)
   - 회원가입 / 이메일 인증 / 로그인 / 로그아웃 / 비밀번호 재설정
   - 마이페이지(프로필·비밀번호·배송지·주문내역) 호출 래퍼
   - 세션 쿠키 기반으로 동작: 모든 호출에 credentials: 'include'
   - 서버는 /api/auth/* 와 /api/me/* 에만 Origin + X-CSRF-Token을 요구한다
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.CGI_SITE_CONFIG || {};
  var API = cfg.orderApiUrl || cfg.quoteApiUrl || '';
  var ORIGIN = window.location.origin;
  var user = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 서버의 4xx 오류 메시지도 안전한 HTML로 보여줄 수 있게 평문 메시지만 뽑는다. */
  function message(res) {
    var d = res && res.data || {};
    if (!res.ok && d.error) {
      var detail = d.detail && typeof d.detail === 'object' ? null : d.detail;
      var primary = String(d.error);
      return detail && detail !== primary ? primary + ' - ' + detail : primary;
    }
    return '';
  }

  /**
   * credentialed fetch 래퍼.
   * X-CSRF-Token은 Origin 그 자체(서버의 기본 정책). 네트워크 실패도 JSON 형태로 돌려준다.
   */
  function api(method, path, body, extraHeaders) {
    if (!API) return Promise.resolve({ ok: false, status: 0, data: { error: 'api url not set', detail: 'CGI_SITE_CONFIG API 주소를 먼저 설정하세요' } });
    var headers = { 'X-CSRF-Token': ORIGIN };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (extraHeaders) {
      for (var k in extraHeaders) {
        if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) headers[k] = extraHeaders[k];
      }
    }
    return fetch(API + path, {
      method: method,
      headers: headers,
      credentials: 'include',
      body: body === undefined || body === null ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data || {}, headers: res.headers };
      }).catch(function () {
        return { ok: res.ok, status: res.status, data: {}, headers: res.headers };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, data: { error: 'network', detail: String((err && err.message) || err) } };
    });
  }

  /* --------------------------------------------------------- 계정 세션 */

  function refresh() {
    return api('GET', '/api/me').then(function (res) {
      user = res.ok && res.data.member ? res.data.member : null;
      return user;
    });
  }

  function me() { return user; }
  function isLoggedIn() { return !!(user && user.id); }
  function emailVerified() { return !!(user && user.email_verified); }

  function emailAvailable(email) {
    return api('POST', '/api/auth/email-available', { email: email }).then(function (res) {
      return res.ok ? !!res.data.available : null;
    });
  }

  function signUp(payload) {
    return api('POST', '/api/auth/signup', payload).then(function (res) {
      if (res.ok) { user = res.data.member; return user; }
      return null;
    });
  }

  /** 이메일 링크(토큰만)로 인증 확정한다. member_id를 알지 못해도 된다. */
  function verifyEmail(token, memberId) {
    var body = { token: token };
    if (memberId) body.member_id = Number(memberId);
    return api('POST', '/api/auth/verify-email', body).then(function (res) {
      if (res.ok) { user = user ? { email_verified: true } : user; return true; }
      return false;
    });
  }

  function resendVerification() {
    return api('POST', '/api/auth/resend-verification').then(function (res) {
      return res.ok ? res.data : null;
    });
  }

  function login(payload) {
    return api('POST', '/api/auth/login', payload).then(function (res) {
      user = res.ok ? res.data.member : null;
      return res.ok;
    });
  }

  function logout() {
    return api('POST', '/api/auth/logout').then(function () {
      user = null;
      return true;
    });
  }

  function requestPasswordReset(email) {
    return api('POST', '/api/auth/password-reset/request', { email: email }).then(function (res) {
      return res.ok;
    });
  }

  function confirmPasswordReset(token, password) {
    return api('POST', '/api/auth/password-reset/confirm', { token: token, password: password }).then(function (res) {
      user = res.ok ? res.data.member : null;
      return res.ok;
    });
  }

  /**
   * Google OAuth 시작: 서버가 Google 인증 URL로 리다이렉트한다.
   * returnTo 는 서버 허용 목록(site/staff/orders) 중 하나이며, 서버는 서명된
   * state 에서만 값을 읽는다. 미전달 시 사이트 로그인 화면으로 복귀한다.
   */
  function googleLogin(returnTo) {
    if (!API) return;
    var query = returnTo ? '?return=' + encodeURIComponent(returnTo) : '';
    window.location.href = API + '/api/auth/google/start' + query;
  }

  /* --------------------------------------------------------- 마이페이지 */

  function updateProfile(fields) {
    return api('PATCH', '/api/me', fields).then(function (res) {
      if (res.ok) {
        user = Object.assign({}, user, res.data.member);
        return res.data.member;
      }
      return res;
    });
  }

  function changePassword(payload) {
    return api('POST', '/api/me/password', payload).then(function (res) {
      return res.ok;
    });
  }

  function deleteAccount() {
    return api('DELETE', '/api/me', { confirm: 'delete-member' }).then(function (res) {
      user = null;
      return res.ok;
    });
  }

  function addresses() {
    return api('GET', '/api/me/addresses').then(function (res) {
      return res.ok ? (res.data.items || []) : null;
    });
  }

  function addAddress(payload) {
    return api('POST', '/api/me/addresses', payload).then(function (res) {
      return res.ok ? res.data.address : res;
    });
  }

  function updateAddress(id, payload) {
    return api('PATCH', '/api/me/addresses/' + encodeURIComponent(id), payload).then(function (res) {
      return res.ok ? res.data.address : res;
    });
  }

  function removeAddress(id) {
    return api('DELETE', '/api/me/addresses/' + encodeURIComponent(id)).then(function (res) {
      return res.ok;
    });
  }

  function orders() {
    return api('GET', '/api/me/orders').then(function (res) {
      return res.ok ? (res.data.items || []) : null;
    });
  }

  // 내 견적 내역 — 기존 GET /api/me/quotes 를 그대로 사용한다(신규 API 없음).
  function quotes() {
    return api('GET', '/api/me/quotes').then(function (res) {
      return res.ok ? (res.data.items || []) : null;
    });
  }

  function quoteDetail(id) {
    return api('GET', '/api/me/quotes/' + encodeURIComponent(id)).then(function (res) {
      return res.ok ? res.data.quote : null;
    });
  }

  function orderDetail(id) {
    return api('GET', '/api/me/orders/' + encodeURIComponent(id)).then(function (res) {
      return res.ok ? res.data.order : null;
    });
  }

  function cancelOrder(id) {
    return api('POST', '/api/me/orders/' + encodeURIComponent(id) + '/cancel').then(function (res) {
      return res.ok ? res.data : res;
    });
  }

  /** 주문 생성 시 로그인 상태면 회원 id를 붙여준다. 비회원은 그대로 빈 값. */
  function memberOrderId() {
    return isLoggedIn() ? user.id : null;
  }

  /* --------------------------------------------------------- 토큰 링크 리다이렉트 */

  /**
   * 이메일 속 링크는 `.../site/auth/verify?token=...` 형태로 온다.
   * 정적 호스팅에서 경로 라우팅이 없으므로 해시 라우트로 바꿔 놓는다.
   */
  function rewriteMailLink() {
    var path = window.location.pathname || '';
    var m = path.match(/\/(auth\/verify|auth\/reset)(?:[?#].*)?$/);
    if (!m) return false;
    var query = window.location.search || '';
    if (m[1] === 'auth/verify' && /\btoken=/.test(query)) {
      window.history.replaceState(null, '', '#/auth/verify' + query);
    } else if (m[1] === 'auth/reset' && /\btoken=/.test(query)) {
      window.history.replaceState(null, '', '#/auth/reset' + query);
    }
    return true;
  }

  window.CGI_AUTH = {
    api: api,
    esc: esc,
    message: message,
    refresh: refresh,
    me: me,
    isLoggedIn: isLoggedIn,
    emailVerified: emailVerified,
    emailAvailable: emailAvailable,
    signUp: signUp,
    verifyEmail: verifyEmail,
    resendVerification: resendVerification,
    login: login,
    logout: logout,
    requestPasswordReset: requestPasswordReset,
    confirmPasswordReset: confirmPasswordReset,
    googleLogin: googleLogin,
    updateProfile: updateProfile,
    changePassword: changePassword,
    deleteAccount: deleteAccount,
    addresses: addresses,
    addAddress: addAddress,
    updateAddress: updateAddress,
    removeAddress: removeAddress,
    orders: orders,
    quotes: quotes,
    quoteDetail: quoteDetail,
    orderDetail: orderDetail,
    cancelOrder: cancelOrder,
    memberOrderId: memberOrderId,
    rewriteMailLink: rewriteMailLink,
    clear: function () { user = null; }
  };
})();
