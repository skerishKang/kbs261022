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
  var JOURNAL_MAX = 8000;
  var LINK_LIMIT = 3;

  var KINDS = [
    ['bug', '오류'],
    ['inconvenient', '불편'],
    ['feature', '요청'],
    ['product', '상품·가격 문의'],
    ['other', '기타']
  ];
  var STATUS_LABELS = {
    received: '접수', reviewing: '확인 중', fixed: '고침', later: '다음에', closed: '닫음'
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
          who.innerHTML = '<strong>' + esc(member.name || member.email) + '</strong> 회원님' +
            (member.is_ai_member || member.role === 'ai_member' ? ' <span class="ai-member-badge">AI 명예회원</span>' : '') + '으로 보냅니다. 답글과 처리 상태는 ' +
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

  function followupHtml(f, x) {
    return '<li class="fb-followup" data-followup-id="' + esc(x.id) + '">' +
      '<p class="fb-followup-meta">내가 덧붙임 · ' + esc(fmtDate(x.created_at)) + (x.edited ? ' · 고침' : '') + '</p>' +
      '<p class="fb-body">' + esc(x.body) + '</p>' +
      (x.canEdit ? '<div class="fb-followup-actions">' +
        '<button type="button" class="btn btn-small btn-secondary" data-followup-edit="' + esc(x.id) + '" data-feedback="' + esc(f.id) + '">고치기</button>' +
        '<button type="button" class="btn btn-small btn-secondary" data-followup-delete="' + esc(x.id) + '" data-feedback="' + esc(f.id) + '">지우기</button></div>' : '') +
    '</li>';
  }

  function mineCardHtml(f) {
    var reopen = f.status === 'fixed' || f.status === 'closed';
    return '<article class="fb-card" data-feedback-id="' + esc(f.id) + '">' +
      '<header class="fb-card-head"><span class="fb-id">' + esc(f.id) + '</span>' + statusBadge(f.status) + '</header>' +
      '<p class="fb-meta">' + esc(fmtDate(f.created_at)) + ' · ' + esc(f.kind_label || kindLabel(f.kind)) + '</p>' +
      '<p class="fb-body">' + esc(f.body) + '</p>' +
      (f.admin_reply
        ? '<div class="fb-reply"><p class="fb-reply-label">운영자 답글</p><p>' + esc(f.admin_reply) + '</p></div>'
        : '<p class="fb-noreply auth-muted">아직 답글이 없어요.</p>') +
      ((f.followups || []).length ? '<ul class="fb-followups">' + f.followups.map(function (x) { return followupHtml(f, x); }).join('') + '</ul>' : '') +
      '<form class="fb-followup-form" data-followup-form="' + esc(f.id) + '">' +
        '<label class="sr-only" for="fu-' + esc(f.id) + '">덧붙일 말</label>' +
        '<textarea id="fu-' + esc(f.id) + '" name="body" rows="2" maxlength="' + BODY_MAX + '" placeholder="빠뜨린 내용이나 그 뒤 소식을 덧붙여 주세요"></textarea>' +
        '<p class="fb-hint">' + (reopen ? '덧붙이면 다시 \'확인 중\'으로 열려요. ' : '') + '이메일·전화번호는 자동으로 가려져요.</p>' +
        '<div data-followup-msg></div>' +
        '<button type="submit" class="btn btn-secondary btn-small">덧붙이기</button>' +
      '</form>' +
    '</article>';
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
      body.innerHTML = head + '<div class="fb-mine-list">' + items.map(mineCardHtml).join('') + '</div>';
      wireMine(body);
    });
  }

  /** 덧붙이기·고치기·지우기(러브트리 append·updateFollowup·deleteFollowup). 지우기는 표시만 숨긴다. */
  function wireMine(body) {
    if (body.getAttribute('data-wired') === '1') return;
    body.setAttribute('data-wired', '1');
    var a = auth();
    function path(fid, xid) { return '/api/me/feedback/' + encodeURIComponent(fid) + '/followup' + (xid ? '/' + encodeURIComponent(xid) : ''); }
    body.addEventListener('submit', function (event) {
      var form = event.target.closest('[data-followup-form]');
      if (!form) return;
      event.preventDefault();
      var msg = form.querySelector('[data-followup-msg]');
      var text = String(form.elements.body.value || '').trim();
      if (!text) { msg.innerHTML = '<p class="fb-alert error">덧붙일 말을 입력해 주세요.</p>'; return; }
      if (countLinks(text) >= LINK_LIMIT) { msg.innerHTML = '<p class="fb-alert error">링크는 2개까지만 넣을 수 있어요.</p>'; return; }
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      a.api('POST', path(form.getAttribute('data-followup-form')), { body: text }).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { msg.innerHTML = '<p class="fb-alert error">' + esc(errorText(res)) + '</p>'; return; }
        renderMine(body);
      });
    });
    body.addEventListener('click', function (event) {
      var del = event.target.closest('[data-followup-delete]');
      if (del) {
        a.api('DELETE', path(del.getAttribute('data-feedback'), del.getAttribute('data-followup-delete'))).then(function () { renderMine(body); });
        return;
      }
      var edit = event.target.closest('[data-followup-edit]');
      if (!edit) return;
      var li = edit.closest('[data-followup-id]');
      var current = li.querySelector('.fb-body').textContent;
      li.innerHTML = '<form class="fb-followup-edit" data-edit-feedback="' + esc(edit.getAttribute('data-feedback')) + '" data-edit-followup="' + esc(edit.getAttribute('data-followup-edit')) + '">' +
        '<label class="sr-only">덧붙인 말 고치기</label><textarea name="body" rows="2" maxlength="' + BODY_MAX + '">' + esc(current) + '</textarea>' +
        '<div data-followup-msg></div><button type="submit" class="btn btn-secondary btn-small">고친 내용 저장</button></form>';
      var editForm = li.querySelector('form');
      editForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = String(editForm.elements.body.value || '').trim();
        a.api('PATCH', path(editForm.getAttribute('data-edit-feedback'), editForm.getAttribute('data-edit-followup')), { body: text }).then(function (res) {
          if (!res.ok) { editForm.querySelector('[data-followup-msg]').innerHTML = '<p class="fb-alert error">' + esc(errorText(res)) + '</p>'; return; }
          renderMine(body);
        });
      });
    });
  }

  /* ------------------------------------------------ 마이페이지 '사용 일지'(AI 명예회원) */

  function scoreRadios() {
    return '<fieldset class="fb-kinds fb-score"><legend>다시 올 점수 <span class="fb-opt">선택</span></legend>' +
      [1, 2, 3, 4, 5].map(function (n) {
        return '<label class="fb-kind"><input type="radio" name="score" value="' + n + '"> <span>' + n + '</span></label>';
      }).join('') + '</fieldset>';
  }

  function renderJournal(body) {
    var a = auth();
    body.innerHTML = '<p class="auth-muted" data-journal-loading>사용 일지를 불러오는 중…</p>';
    if (!a) { body.innerHTML = '<p class="fb-alert error">로그인 정보를 확인하지 못했어요.</p>'; return; }
    a.api('GET', '/api/me/journal').then(function (res) {
      if (res.status === 403) { body.innerHTML = '<p class="fb-alert info">사용 일지는 AI 명예회원만 쓸 수 있어요.</p>'; return; }
      if (!res.ok) { body.innerHTML = '<p class="fb-alert error">사용 일지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>'; return; }
      var today = res.data.journal;
      var items = res.data.items || [];
      var html = '<section class="fb-journal">' +
        '<p class="fb-who">하루에 한 건씩 남겨요(한국 시각 날짜). 같은 날 다시 쓰면 오늘 일지 아래에 덧붙여요. 이메일·전화번호는 자동으로 가려져요. 일지는 운영자만 읽어요.</p>' +
        (today ? '<article class="fb-card fb-journal-today"><header class="fb-card-head"><span class="fb-id">' + esc(today.journal_date) + ' · 오늘 일지</span>' +
          '<span class="fb-status fb-status-reviewing">다시 올 점수 ' + (today.score == null ? '—' : esc(today.score)) + '</span></header>' +
          '<h3 class="fb-journal-title">' + esc(today.title) + '</h3><p class="fb-body">' + esc(today.body) + '</p></article>' : '') +
        '<form class="fb-form fb-journal-form" id="journalForm" novalidate>' +
          (today ? '' : '<div class="fb-field"><label for="jTitle">제목 <span class="fb-opt">선택</span></label><input id="jTitle" name="title" maxlength="120" placeholder="비우면 첫 줄이 제목이 돼요"></div>') +
          '<div class="fb-field"><label for="jBody">' + (today ? '오늘 일지에 덧붙일 내용' : '오늘 사용한 내용') + ' <span class="fb-req">필수</span></label>' +
          '<textarea id="jBody" name="body" rows="8" maxlength="' + JOURNAL_MAX + '" required placeholder="오늘 무엇을 찾았고, 어디가 편했고, 어디서 막혔는지 적어 주세요."></textarea>' +
          '<p class="fb-hint"><span id="jCount" class="fb-count">0 / 8,000자</span>' + (today ? ' · 합쳐서 8,000자까지' : '') + '</p></div>' +
          scoreRadios() +
          '<div id="jMsg" aria-live="polite"></div>' +
          '<button type="submit" class="btn btn-primary btn-block">' + (today ? '오늘 일지에 덧붙이기' : '오늘 일지 쓰기') + '</button>' +
        '</form>';
      var past = items.filter(function (j) { return !today || j.id !== today.id; });
      if (past.length) {
        html += '<h3 class="fb-journal-past">지난 일지</h3><div class="fb-mine-list">' + past.map(function (j) {
          return '<details class="fb-card"><summary><span class="fb-id">' + esc(j.journal_date) + '</span> · ' + esc(j.title) +
            ' · 점수 ' + (j.score == null ? '—' : esc(j.score)) + '</summary><p class="fb-body">' + esc(j.body) + '</p></details>';
        }).join('') + '</div>';
      }
      body.innerHTML = html + '</section>';
      var form = body.querySelector('#journalForm');
      var bodyEl = form.elements.body;
      var counter = body.querySelector('#jCount');
      bodyEl.addEventListener('input', function () {
        var n = charCount(bodyEl.value);
        counter.textContent = n.toLocaleString('ko-KR') + ' / 8,000자';
        counter.classList.toggle('is-over', n > JOURNAL_MAX);
      });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var msg = body.querySelector('#jMsg');
        var text = String(bodyEl.value || '').trim();
        if (!text) { msg.innerHTML = '<p class="fb-alert error">오늘 사용한 내용을 적어 주세요.</p>'; return; }
        if (charCount(text) > JOURNAL_MAX) { msg.innerHTML = '<p class="fb-alert error">일지는 8,000자까지 적을 수 있어요.</p>'; return; }
        var scoreEl = form.querySelector('input[name="score"]:checked');
        var payload = { body: text, score: scoreEl ? Number(scoreEl.value) : null };
        if (form.elements.title) payload.title = form.elements.title.value.trim();
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        a.api('POST', '/api/me/journal', payload).then(function (r) {
          btn.disabled = false;
          if (!r.ok) { msg.innerHTML = '<p class="fb-alert error">' + esc(errorText(r)) + '</p>'; return; }
          renderJournal(body);
        });
      });
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
    renderJournal: renderJournal,
    feedbackHref: feedbackHref,
    kinds: KINDS,
    statusLabels: STATUS_LABELS,
    sourceLabels: SOURCE_LABELS,
    countLinks: countLinks
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
