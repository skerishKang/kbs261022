/* ==========================================================================
   CGI 운영센터(관리자) — 의견 받은함 · 상세 · 상태/답글/내부 메모 · 새 소식
   - 관리자/총관리자 회원 세션(쿠키 + X-CSRF-Token)만 쓴다.
   - 모든 변경은 Worker API(PATCH /api/admin/feedback/:id, /api/admin/news)로만.
   ========================================================================== */
(function () {
  'use strict';

  var KIND_LABELS = { bug: '불편·오류', idea: '기능 제안', product: '상품·가격 문의', other: '기타' };
  var STATUS_LABELS = { received: '접수', checking: '확인 중', fixed: '고침', answered: '답변 완료', on_hold: '보류' };
  var SOURCE_LABELS = { user_feedback: '사용자 의견으로 고친 것', ai_member: 'AI 명예회원이 알려 준 것' };

  var state = { items: [], selected: null, detail: null, news: [] };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function badge(status) {
    return '<span class="fb-status fb-status-' + esc(status) + '">' + esc(STATUS_LABELS[status] || status) + '</span>';
  }
  function alertHtml(text, kind) {
    return text ? '<p class="fb-alert ' + (kind || 'error') + '" role="status">' + esc(text) + '</p>' : '';
  }
  function api(method, path, body) {
    return window.CGI_AUTH.api(method, path, body);
  }
  function isStaff(member) {
    return !!(member && (member.role === 'admin' || member.role === 'superadmin' || member.is_admin));
  }
  function safeHref(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  }

  /* ------------------------------------------------------------ 진입 */

  function showAuth(text) {
    $('opsApp').hidden = true;
    $('opsAuth').hidden = false;
    $('opsAuthMsg').innerHTML = alertHtml(text, 'error');
  }

  function enter() {
    $('opsAuth').hidden = true;
    $('opsApp').hidden = false;
    loadInbox();
  }

  function boot() {
    if (!window.CGI_AUTH) { showAuth('로그인 모듈을 불러오지 못했어요.'); return; }
    window.CGI_AUTH.refresh().then(function (member) {
      if (isStaff(member)) enter();
      else showAuth(member ? '이 계정에는 운영센터 권한이 없어요.' : '');
    }).catch(function () { showAuth('로그인 상태를 확인하지 못했어요.'); });

    $('opsLoginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var f = event.target;
      window.CGI_AUTH.login({ email: f.elements.email.value.trim(), password: f.elements.password.value })
        .then(function (ok) {
          if (!ok) { showAuth('이메일 또는 비밀번호를 확인해 주세요.'); return null; }
          return window.CGI_AUTH.refresh();
        })
        .then(function (member) {
          if (member === null || member === undefined) return;
          if (isStaff(member)) enter();
          else showAuth('이 계정에는 운영센터 권한이 없어요.');
        });
    });

    $('opsLogout').addEventListener('click', function () {
      window.CGI_AUTH.logout().then(function () { showAuth(''); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-ops-tab]'), function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-ops-tab')); });
    });

    $('opsFilters').addEventListener('submit', function (event) { event.preventDefault(); loadInbox(); });
    Array.prototype.forEach.call($('opsFilters').querySelectorAll('select'), function (sel) {
      sel.addEventListener('change', loadInbox);
    });

    $('opsList').addEventListener('click', function (event) {
      var row = event.target.closest('[data-feedback-id]');
      if (row) openDetail(row.getAttribute('data-feedback-id'));
    });

    $('opsNewsForm').addEventListener('submit', submitNews);
    $('opsNewsList').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-news-publish]');
      if (!btn) return;
      togglePublish(btn.getAttribute('data-news-id'), btn.getAttribute('data-news-publish') === 'true');
    });
  }

  function switchTab(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ops-tab]'), function (btn) {
      var on = btn.getAttribute('data-ops-tab') === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ops-panel]'), function (panel) {
      panel.hidden = panel.getAttribute('data-ops-panel') !== tab;
    });
    if (tab === 'news') loadNews();
    else loadInbox();
  }

  /* ------------------------------------------------------------ 받은함 */

  function query() {
    var f = $('opsFilters');
    var p = [];
    ['q', 'kind', 'status', 'ai'].forEach(function (name) {
      var v = String(f.elements[name].value || '').trim();
      if (v) p.push(name + '=' + encodeURIComponent(v));
    });
    return p.length ? '?' + p.join('&') : '';
  }

  function loadInbox() {
    $('opsList').innerHTML = '<p class="ops-empty">불러오는 중…</p>';
    api('GET', '/api/admin/feedback' + query()).then(function (res) {
      if (res.status === 401) { showAuth('로그인이 끝났어요. 다시 로그인해 주세요.'); return; }
      if (!res.ok) { $('opsList').innerHTML = alertHtml('받은함을 불러오지 못했습니다 (HTTP ' + res.status + ').'); return; }
      state.items = res.data.items || [];
      $('opsCount').textContent = '최신순 · ' + (res.data.total || 0) + '건' + (res.data.total > state.items.length ? ' 중 ' + state.items.length + '건 표시' : '');
      renderList();
      if (state.selected && state.items.some(function (x) { return x.id === state.selected; })) markSelected();
    });
  }

  function renderList() {
    if (!state.items.length) {
      $('opsList').innerHTML = '<p class="ops-empty">조건에 맞는 의견이 없습니다.</p>';
      return;
    }
    $('opsList').innerHTML = state.items.map(function (f) {
      return '<button type="button" class="ops-row" data-feedback-id="' + esc(f.id) + '">' +
        '<span class="ops-row-top"><span class="fb-id">' + esc(f.id) + '</span>' + badge(f.status) +
          '<span>' + esc(f.kind_label || KIND_LABELS[f.kind] || f.kind) + '</span>' +
          (f.ai_member_label ? '<span class="ops-ai">' + esc(f.ai_member_label) + '</span>' : '') +
          (f.member_id ? '<span class="ops-flag">회원</span>' : '<span class="ops-flag">비회원</span>') +
          (f.has_reply ? '<span class="ops-flag">답글</span>' : '') +
          (f.issue_ref ? '<span class="ops-flag">' + esc(f.issue_ref) + '</span>' : '') +
          '<span class="ops-flag">' + esc(fmtDate(f.created_at)) + '</span></span>' +
        '<span class="ops-row-body">' + esc(f.body_preview) + '</span>' +
        (f.contact_email_masked ? '<span class="ops-flag">연락처 ' + esc(f.contact_email_masked) + '</span>' : '') +
      '</button>';
    }).join('');
    markSelected();
  }

  function markSelected() {
    Array.prototype.forEach.call(document.querySelectorAll('.ops-row'), function (row) {
      row.classList.toggle('is-selected', row.getAttribute('data-feedback-id') === state.selected);
    });
  }

  /* ------------------------------------------------------------ 상세 */

  function openDetail(id, notice) {
    state.selected = id;
    markSelected();
    $('opsDetail').innerHTML = '<p class="ops-empty">불러오는 중…</p>';
    api('GET', '/api/admin/feedback/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { $('opsDetail').innerHTML = alertHtml('상세를 불러오지 못했습니다 (HTTP ' + res.status + ').'); return; }
      state.detail = res.data.feedback;
      renderDetail(notice);
    });
  }

  function renderDetail(notice) {
    var f = state.detail;
    var page = safeHref(f.page_url);
    var statusOptions = Object.keys(STATUS_LABELS).map(function (k) {
      return '<option value="' + k + '"' + (k === f.status ? ' selected' : '') + '>' + STATUS_LABELS[k] + '</option>';
    }).join('');
    $('opsDetail').innerHTML =
      '<h2>' + esc(f.id) + ' ' + badge(f.status) + '</h2>' +
      (f.ai_member_label ? '<p><span class="ops-ai">' + esc(f.ai_member_label) + '</span></p>' : '') +
      '<dl>' +
        '<dt>접수</dt><dd>' + esc(fmtDate(f.created_at)) + '</dd>' +
        '<dt>최근 변경</dt><dd>' + esc(fmtDate(f.updated_at)) + '</dd>' +
        '<dt>종류</dt><dd>' + esc(f.kind_label) + '</dd>' +
        '<dt>보던 화면</dt><dd>' + (page ? '<a href="' + esc(page) + '" target="_blank" rel="noopener noreferrer">' + esc(page) + '</a>' : '—') + '</dd>' +
        '<dt>연락 이메일</dt><dd>' + (f.contact_email ? esc(f.contact_email) : '—') + '</dd>' +
        '<dt>회원</dt><dd>' + (f.member_id ? '회원 #' + esc(f.member_id) : '비회원') + '</dd>' +
      '</dl>' +
      '<p class="fb-body">' + esc(f.body) + '</p>' +
      '<form class="ops-form" id="opsDetailForm">' +
        '<div class="ops-form-row">' +
          '<label>상태<select name="status">' + statusOptions + '</select></label>' +
          '<label>GitHub 이슈<input name="issue_ref" value="' + esc(f.issue_ref || '') + '" placeholder="#123" maxlength="120"></label>' +
          '<label>AI 명예회원 이름<input name="ai_member" value="' + esc(f.ai_member || '') + '" placeholder="비우면 일반 의견" maxlength="40"></label>' +
        '</div>' +
        '<label>고객에게 보이는 답글<textarea name="admin_reply" maxlength="2000" placeholder="마이페이지 → 내 의견에 그대로 보입니다">' + esc(f.admin_reply || '') + '</textarea></label>' +
        '<label class="ops-note-label">내부 메모 (고객에게 안 보임)<textarea name="admin_note" maxlength="4000">' + esc(f.admin_note || '') + '</textarea></label>' +
        '<div id="opsDetailMsg">' + (notice ? alertHtml(notice, 'ok') : '') + '</div>' +
        '<button type="submit" class="btn btn-primary">저장</button>' +
      '</form>';
    $('opsDetailForm').addEventListener('submit', saveDetail);
  }

  function saveDetail(event) {
    event.preventDefault();
    var form = event.target;
    var f = state.detail;
    var patch = {};
    var status = form.elements.status.value;
    if (status !== f.status) patch.status = status;
    [['admin_reply', 'admin_reply'], ['admin_note', 'admin_note'], ['issue_ref', 'issue_ref'], ['ai_member', 'ai_member']].forEach(function (pair) {
      var v = String(form.elements[pair[0]].value || '').trim();
      if (v !== String(f[pair[1]] || '')) patch[pair[1]] = v || null;
    });
    if (!Object.keys(patch).length) { $('opsDetailMsg').innerHTML = alertHtml('바뀐 내용이 없어요.', 'info'); return; }
    var submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    api('PATCH', '/api/admin/feedback/' + encodeURIComponent(f.id), patch).then(function (res) {
      submit.disabled = false;
      if (!res.ok) {
        $('opsDetailMsg').innerHTML = alertHtml('저장하지 못했어요: ' + ((res.data && (res.data.detail || res.data.error)) || ('HTTP ' + res.status)));
        return;
      }
      state.detail = res.data.feedback;
      renderDetail('저장했어요.');
      loadInbox();
    });
  }

  /* ------------------------------------------------------------ 새 소식 */

  function loadNews() {
    $('opsNewsList').innerHTML = '<p class="ops-empty">불러오는 중…</p>';
    api('GET', '/api/admin/news').then(function (res) {
      if (res.status === 401) { showAuth('로그인이 끝났어요. 다시 로그인해 주세요.'); return; }
      if (!res.ok) { $('opsNewsList').innerHTML = alertHtml('새 소식을 불러오지 못했습니다.'); return; }
      state.news = res.data.items || [];
      renderNews();
    });
  }

  function renderNews() {
    if (!state.news.length) { $('opsNewsList').innerHTML = '<p class="ops-empty">아직 쓴 소식이 없습니다.</p>'; return; }
    $('opsNewsList').innerHTML = state.news.map(function (n) {
      return '<article class="ops-news-item">' +
        '<p class="news-meta"><span class="news-tag news-tag-' + esc(n.source_tag) + '">' + esc(SOURCE_LABELS[n.source_tag] || n.source_tag) + '</span>' +
          (n.published ? '게시 ' + esc(fmtDate(n.published_at)) : '<strong>초안</strong>') + '</p>' +
        '<h3>' + esc(n.title) + '</h3>' +
        '<p class="news-body">' + esc(n.body) + '</p>' +
        '<div class="ops-news-actions">' +
          (n.published
            ? '<button type="button" class="btn btn-secondary btn-small" data-news-id="' + esc(n.id) + '" data-news-publish="false">게시 내리기</button>'
            : '<button type="button" class="btn btn-primary btn-small" data-news-id="' + esc(n.id) + '" data-news-publish="true">게시</button>') +
        '</div>' +
      '</article>';
    }).join('');
  }

  function submitNews(event) {
    event.preventDefault();
    var f = event.target;
    var payload = {
      title: f.elements.title.value.trim(),
      body: f.elements.body.value.trim(),
      source_tag: f.elements.source_tag.value,
      published: !!f.elements.published.checked
    };
    if (!payload.title || !payload.body) { $('opsNewsMsg').innerHTML = alertHtml('제목과 내용을 적어 주세요.'); return; }
    api('POST', '/api/admin/news', payload).then(function (res) {
      if (!res.ok) { $('opsNewsMsg').innerHTML = alertHtml('저장하지 못했어요: ' + ((res.data && (res.data.detail || res.data.error)) || res.status)); return; }
      f.reset();
      $('opsNewsMsg').innerHTML = alertHtml(payload.published ? '게시했어요.' : '초안으로 저장했어요.', 'ok');
      loadNews();
    });
  }

  function togglePublish(id, publish) {
    api('PATCH', '/api/admin/news/' + encodeURIComponent(id), { published: publish }).then(function (res) {
      if (!res.ok) { $('opsNewsMsg').innerHTML = alertHtml('바꾸지 못했어요 (HTTP ' + res.status + ').'); return; }
      loadNews();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
