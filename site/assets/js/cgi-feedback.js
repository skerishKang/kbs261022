/* ==========================================================================
   CGI 운영센터 — 고객 쪽 '의견 보내기' · '내 의견' · '새 소식'
   - 모든 화면의 [data-feedback-link] 링크에 지금 보던 화면 주소를 실어 보낸다.
   - feedback.html: 의견 폼(비로그인 가능, 로그인 회원은 회원에 연결).
   - news.html: 공개 새 소식(버전 노트).
   - 마이페이지 '내 의견' 탭: window.CGI_FEEDBACK.renderMine(body)
   서버: POST /api/feedback, GET /api/me/feedback, GET /api/news
   ========================================================================== */
(function () {
  'use strict';

  var cfg = window.CGI_SITE_CONFIG || {};
  var API = cfg.orderApiUrl || cfg.quoteApiUrl || '';
  var BODY_MAX = 2000;
  var LINK_LIMIT = 3;

  var KINDS = [
    ['bug', '불편·오류'],
    ['idea', '기능 제안'],
    ['product', '상품·가격 문의'],
    ['other', '기타']
  ];
  var STATUS_LABELS = {
    received: '접수', checking: '확인 중', fixed: '고침', answered: '답변 완료', on_hold: '보류'
  };
  var SOURCE_LABELS = {
    ai_member: 'AI 명예회원이 알려 준 것',
    user_feedback: '사용자 의견으로 고친 것'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function kindLabel(k) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0] === k) return KINDS[i][1];
    return k || '';
  }
  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function charCount(s) { return Array.from ? Array.from(String(s || '')).length : String(s || '').length; }
  function countLinks(s) {
    var m = String(s || '').match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi);
    return m ? m.length : 0;
  }
  function auth() { return window.CGI_AUTH || null; }

  /* ------------------------------------------------ 링크: 보던 화면 주소 실어 보내기 */

  function feedbackHref(base) {
    var target = base || 'feedback.html';
    var here = window.location.href;
    if (/\/feedback\.html(?:[?#]|$)/.test(window.location.pathname + window.location.search)) return target;
    return target + (target.indexOf('?') >= 0 ? '&' : '?') + 'from=' + encodeURIComponent(here);
  }

  function wireLinks() {
    document.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[data-feedback-link]') : null;
      if (!link) return;
      var base = link.getAttribute('data-feedback-base') || link.getAttribute('href').split('?')[0];
      link.setAttribute('href', feedbackHref(base));
    }, true);
  }

  /* ------------------------------------------------ 서버 호출 */

  function postFeedback(payload) {
    if (!API) return Promise.resolve({ ok: false, status: 0, data: { error: 'api url not set' } });
    var a = auth();
    // 로그인 회원만 쿠키 + CSRF 를 싣는다(회원 연결). 비회원은 쿠키 없이 보낸다.
    if (a && a.isLoggedIn && a.isLoggedIn()) return a.api('POST', '/api/feedback', payload);
    return fetch(API + '/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data || {} }; })
        .catch(function () { return { ok: res.ok, status: res.status, data: {} }; });
    }).catch(function (err) {
      return { ok: false, status: 0, data: { error: 'network', detail: String((err && err.message) || err) } };
    });
  }

  function errorText(res) {
    var d = (res && res.data) || {};
    if (res && res.status === 429) return d.detail && typeof d.detail === 'string' ? d.detail : '잠시 후 다시 보내 주세요. 짧은 시간에 너무 많이 보냈어요.';
    if (res && res.status === 0) return '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.';
    if (d.detail && typeof d.detail === 'string') return d.detail;
    return '보내지 못했어요. 잠시 후 다시 시도해 주세요.';
  }

  /* ------------------------------------------------ feedback.html 폼 */

  function sourcePage() {
    var params = new URLSearchParams(window.location.search);
    var from = params.get('from');
    if (from && /^https?:\/\//i.test(from)) return from;
    var ref = document.referrer || '';
    return /^https?:\/\//i.test(ref) ? ref : '';
  }

  function initForm(form) {
    var counter = document.getElementById('fbCount');
    var bodyEl = form.elements.body;
    var pageEl = form.elements.page_url;
    var msgEl = document.getElementById('fbMsg');
    var who = document.getElementById('fbWho');
    pageEl.value = sourcePage();

    function updateCount() {
      var n = charCount(bodyEl.value);
      counter.textContent = n.toLocaleString('ko-KR') + ' / ' + BODY_MAX.toLocaleString('ko-KR') + '자';
      counter.classList.toggle('is-over', n > BODY_MAX);
    }
    bodyEl.addEventListener('input', updateCount);
    updateCount();

    var a = auth();
    if (a && a.refresh) {
      a.refresh().then(function (member) {
        if (member && member.id) {
          who.innerHTML = '<strong>' + esc(member.name || member.email) + '</strong> 회원님으로 보냅니다. 답글과 처리 상태는 ' +
            '<a href="index.html#/my-page/feedback">마이페이지 → 내 의견</a>에서 볼 수 있어요.';
        }
      }).catch(function () {});
    }

    function show(text, kind) {
      msgEl.innerHTML = text ? '<p class="fb-alert ' + (kind || 'error') + '" role="alert">' + esc(text) + '</p>' : '';
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      show('');
      var kindEl = form.querySelector('input[name="kind"]:checked');
      var body = String(bodyEl.value || '').trim();
      if (!kindEl) { show('의견 종류를 골라 주세요.'); return; }
      if (!body) { show('내용을 적어 주세요.'); bodyEl.focus(); return; }
      if (charCount(body) > BODY_MAX) { show('내용은 2,000자까지 적을 수 있어요.'); bodyEl.focus(); return; }
      if (countLinks(body) >= LINK_LIMIT) { show('링크는 2개까지만 넣을 수 있어요.'); bodyEl.focus(); return; }
      var email = String(form.elements.contact_email.value || '').trim();
      if (email && !form.elements.contact_email.checkValidity()) { show('이메일 주소 형식을 확인해 주세요.'); return; }
      var submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = '보내는 중…';
      postFeedback({ kind: kindEl.value, body: body, page_url: pageEl.value || null, contact_email: email || null })
        .then(function (res) {
          submit.disabled = false;
          submit.textContent = '보내기';
          if (!res.ok) { show(errorText(res)); return; }
          var memberNote = res.data.member_linked
            ? '<p>처리 상태와 답글은 <a href="index.html#/my-page/feedback">마이페이지 → 내 의견</a>에서 볼 수 있어요.</p>'
            : (email ? '<p>답이 필요하면 적어 주신 이메일로 연락드릴게요.</p>' : '<p>로그인하고 보내면 마이페이지에서 처리 상태와 답글을 볼 수 있어요.</p>');
          var done = document.getElementById('fbDone');
          done.innerHTML = '<h2>의견을 받았습니다</h2>' +
            '<p class="fb-receipt">접수번호 <strong data-receipt-id>' + esc(res.data.id) + '</strong></p>' +
            memberNote +
            '<div class="fb-actions"><a class="btn btn-secondary" href="feedback.html">의견 하나 더 보내기</a>' +
            (pageEl.value ? '<a class="btn btn-primary" href="' + esc(pageEl.value) + '">보던 화면으로 돌아가기</a>' : '<a class="btn btn-primary" href="index.html">쇼핑몰로 돌아가기</a>') +
            '</div>';
          done.hidden = false;
          form.hidden = true;
          done.focus();
        });
    });
  }

  /* ------------------------------------------------ 마이페이지 '내 의견' */

  function statusBadge(status) {
    return '<span class="fb-status fb-status-' + esc(status) + '">' + esc(STATUS_LABELS[status] || status) + '</span>';
  }

  function renderMine(body) {
    var a = auth();
    body.innerHTML = '<p class="auth-muted" data-feedback-loading>내 의견을 불러오는 중…</p>';
    if (!a) { body.innerHTML = '<p class="fb-alert error">로그인 정보를 확인하지 못했어요.</p>'; return; }
    a.api('GET', '/api/me/feedback').then(function (res) {
      if (!res.ok) {
        body.innerHTML = '<p class="fb-alert error">내 의견을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>' +
          '<button type="button" class="btn btn-secondary" data-action="reload-feedback">다시 시도</button>';
        var retry = body.querySelector('[data-action="reload-feedback"]');
        if (retry) retry.addEventListener('click', function () { renderMine(body); });
        return;
      }
      var items = res.data.items || [];
      var head = '<div class="fb-mine-head"><p class="auth-muted">보낸 의견 ' + items.length + '건</p>' +
        '<a class="btn btn-primary btn-small" href="feedback.html" data-feedback-link>의견 보내기</a></div>';
      if (!items.length) {
        body.innerHTML = head + '<div class="mypage-empty"><h3>아직 보낸 의견이 없습니다</h3>' +
          '<p class="auth-muted">불편한 점이나 바라는 기능을 알려 주시면 운영자가 확인하고 답글을 남겨요.</p></div>';
        return;
      }
      body.innerHTML = head + '<div class="fb-mine-list">' + items.map(function (f) {
        return '<article class="fb-card" data-feedback-id="' + esc(f.id) + '">' +
          '<header class="fb-card-head"><span class="fb-id">' + esc(f.id) + '</span>' + statusBadge(f.status) + '</header>' +
          '<p class="fb-meta">' + esc(fmtDate(f.created_at)) + ' · ' + esc(f.kind_label || kindLabel(f.kind)) + '</p>' +
          '<p class="fb-body">' + esc(f.body) + '</p>' +
          (f.admin_reply
            ? '<div class="fb-reply"><p class="fb-reply-label">운영자 답글</p><p>' + esc(f.admin_reply) + '</p></div>'
            : '<p class="fb-noreply auth-muted">아직 답글이 없어요.</p>') +
        '</article>';
      }).join('') + '</div>';
    });
  }

  /* ------------------------------------------------ news.html */

  function initNews(list) {
    if (!API) { list.innerHTML = '<p class="fb-alert error">소식을 불러올 주소가 설정되지 않았어요.</p>'; return; }
    list.innerHTML = '<p class="auth-muted">새 소식을 불러오는 중…</p>';
    fetch(API + '/api/news').then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data || {} }; });
    }).then(function (res) {
      if (!res.ok) throw new Error('http');
      var items = res.data.items || [];
      if (!items.length) {
        list.innerHTML = '<div class="mypage-empty"><h3>아직 올라온 소식이 없습니다</h3><p class="auth-muted">고친 점과 새로 생긴 기능을 이곳에 모아 알려 드려요.</p></div>';
        return;
      }
      list.innerHTML = items.map(function (n) {
        return '<article class="news-item">' +
          '<header><p class="news-meta"><time datetime="' + esc(n.published_at) + '">' + esc(fmtDate(n.published_at)) + '</time>' +
          '<span class="news-tag news-tag-' + esc(n.source_tag) + '">' + esc(n.source_label || SOURCE_LABELS[n.source_tag] || '') + '</span></p>' +
          '<h2>' + esc(n.title) + '</h2></header>' +
          '<p class="news-body">' + esc(n.body) + '</p>' +
        '</article>';
      }).join('');
    }).catch(function () {
      list.innerHTML = '<p class="fb-alert error">새 소식을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>';
    });
  }

  /* ------------------------------------------------ 부팅 */

  function boot() {
    wireLinks();
    var form = document.getElementById('feedbackForm');
    if (form) initForm(form);
    var news = document.getElementById('newsList');
    if (news) initNews(news);
  }

  window.CGI_FEEDBACK = {
    renderMine: renderMine,
    feedbackHref: feedbackHref,
    kinds: KINDS,
    statusLabels: STATUS_LABELS,
    sourceLabels: SOURCE_LABELS,
    countLinks: countLinks
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
