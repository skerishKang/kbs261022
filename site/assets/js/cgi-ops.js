/* ==========================================================================
   CGI 운영센터(관리자) — 러브트리 운영센터와 같은 탭 구성.
   한눈에 · 고객 · 의견 · 사용 일지 · 고치는 일 (+ CGI 전용 새 소식)
   - 관리자/총관리자 회원 세션(쿠키 + X-CSRF-Token)만 쓴다.
   - 모든 변경은 Worker API 로만. 계산·거르기는 cgi-ops-view.js(순수 조각)가 한다.
   ========================================================================== */
(function () {
  'use strict';

  var V = window.CGI_OPS_VIEW;
  var esc = V.escapeText;
  var SOURCE_LABELS = { user_feedback: '사용자 의견으로 고친 것', ai_member: 'AI 명예회원이 알려 준 것' };
  var state = { feedback: null, received: 0 };

  function $(id) { return document.getElementById(id); }
  function api(method, path, body) { return window.CGI_AUTH.api(method, path, body); }
  function isStaff(m) { return !!(m && (m.role === 'admin' || m.role === 'superadmin' || m.is_admin)); }
  function safeHref(url) { return /^https?:\/\//i.test(String(url || '')) ? String(url) : ''; }
  function badge(status) {
    return '<span class="fb-status fb-status-' + esc(status) + '">' + esc(V.STATUS_LABEL[status] || status) + '</span>';
  }
  function alertHtml(text, kind) {
    return text ? '<p class="fb-alert ' + (kind || 'error') + '" role="status">' + esc(text) + '</p>' : '';
  }
  function view() { return $('opsView'); }
  function loading() { view().innerHTML = '<p class="ops-empty">불러오는 중…</p>'; }
  function failed(res, what) {
    if (res && res.status === 401) { showAuth('로그인이 끝났어요. 다시 로그인해 주세요.'); return; }
    view().innerHTML = alertHtml(what + '을(를) 불러오지 못했습니다 (HTTP ' + (res ? res.status : 0) + ').');
  }
  function chips(tabs, current, attr) {
    return '<div class="ops-chips" role="group">' + tabs.map(function (t) {
      var count = t.count == null ? '' : ' <span class="ops-chip-count">' + t.count + '</span>';
      return '<button type="button" class="ops-chip' + (t.key === current ? ' is-active' : '') + '" ' + attr + '="' + esc(t.key) + '"' +
        (t.key === current ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(t.label) + count + '</button>';
    }).join('') + '</div>';
  }
  function card(label, value) {
    return '<div class="ops-card"><p class="ops-card-label">' + esc(label) + '</p><p class="ops-card-value">' + esc(value) + '</p></div>';
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
    route();
  }

  function boot() {
    if (!window.CGI_AUTH || !V) { showAuth('운영센터 모듈을 불러오지 못했어요.'); return; }
    window.CGI_AUTH.refresh().then(function (m) {
      if (isStaff(m)) enter();
      else showAuth(m ? '이 계정에는 운영센터 권한이 없어요.' : '');
    }).catch(function () { showAuth('로그인 상태를 확인하지 못했어요.'); });

    $('opsLoginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var f = event.target;
      window.CGI_AUTH.login({ email: f.elements.email.value.trim(), password: f.elements.password.value })
        .then(function (ok) { if (!ok) { showAuth('이메일 또는 비밀번호를 확인해 주세요.'); return null; } return window.CGI_AUTH.refresh(); })
        .then(function (m) { if (m == null) return; if (isStaff(m)) enter(); else showAuth('이 계정에는 운영센터 권한이 없어요.'); });
    });

    $('opsTabs').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-ops-view]');
      if (btn) { location.hash = V.viewHash(btn.getAttribute('data-ops-view')); return; }
      if (event.target.closest('[data-action="logout"]')) window.CGI_AUTH.logout().then(function () { showAuth(''); });
    });
    view().addEventListener('click', onViewClick);
    view().addEventListener('submit', onViewSubmit);
    view().addEventListener('change', onViewChange);
    window.addEventListener('hashchange', function () { if (!$('opsApp').hidden) route(); });
  }

  function renderTabs(current) {
    var tab = V.viewToTab(current);
    $('opsTabs').innerHTML = V.MENU_TABS.map(function (t) {
      var on = t.view === tab;
      var count = t.countKey === 'opinion' && state.received ? ' <span class="ops-tab-count" title="새 글">' + state.received + '</span>' : '';
      return '<button type="button" class="ops-tab' + (on ? ' is-active' : '') + '" role="tab" aria-selected="' + on + '" data-ops-view="' + t.view + '">' + esc(t.label) + count + '</button>';
    }).join('') + '<button type="button" class="ops-tab" data-action="logout">로그아웃</button>';
  }

  function loadFeedback() {
    return api('GET', '/api/admin/feedback?limit=500').then(function (res) {
      if (!res.ok) return { ok: false, res: res };
      state.feedback = res.data.items || [];
      state.received = V.menuReceivedCounts(state.feedback).opinion;
      return { ok: true, rows: state.feedback };
    });
  }

  function route() {
    var s = V.parseHash(location.hash);
    renderTabs(s.view);
    loading();
    if (s.view === 'overview') return renderOverview();
    if (s.view === 'customers') return renderCustomers(s);
    if (s.view === 'customer') return renderCustomer(s.id);
    if (s.view === 'feedback') return renderFeedback(s.id);
    if (s.view === 'journals') return renderJournals(s);
    if (s.view === 'issues') return renderIssues();
    if (s.view === 'news') return renderNews();
    return renderBoard(s);
  }

  /* ------------------------------------------------------------ 한눈에 */

  function renderOverview() {
    Promise.all([api('GET', '/api/admin/ops/stats'), loadFeedback(), api('GET', '/api/admin/journals?limit=300')]).then(function (r) {
      var statsRes = r[0], fb = r[1], jr = r[2];
      if (statsRes.status === 401) { showAuth('로그인이 끝났어요. 다시 로그인해 주세요.'); return; }
      renderTabs('overview');
      var cards = statsRes.ok ? V.statsCards(statsRes.data.stats) : { error: true, cards: [] };
      var html = '<section class="ops-section"><h2 class="ops-h">숫자</h2>';
      html += cards.cards.length ? '<div class="ops-cards">' + cards.cards.map(function (c) {
        return '<div class="ops-card ops-card-' + esc(c.key) + '"><p class="ops-card-label">' + esc(c.label) + '</p><p class="ops-card-value">' +
          (c.value == null ? '—' : c.value.toLocaleString('ko-KR')) + '</p>' + (c.detail ? '<p class="ops-card-detail">' + esc(c.detail) + '</p>' : '') + '</div>';
      }).join('') + '</div>' : alertHtml('숫자를 불러오지 못했어요.');
      html += '<p class="fb-hint">실제 고객·AI 명예회원·시험 계정은 겹치지 않고 합이 전체예요. 시험 계정은 예약 도메인(example.com 등)과 운영 변수 목록으로 셉니다.</p></section>';

      var todos = fb.ok ? V.overviewTodos(fb.rows, 5) : [];
      html += '<section class="ops-section"><h2 class="ops-h">오늘 할 일 <span class="ops-sub">답글 없는 할 일, 오래된 순</span></h2>';
      html += !fb.ok ? alertHtml('의견을 불러오지 못했어요.') : todos.length ? '<div class="ops-list">' + todos.map(feedbackRow).join('') + '</div>'
        : '<p class="ops-empty">답을 기다리는 의견이 없어요.</p>';
      html += '<p><a class="ops-link" href="' + V.viewHash('board') + '">의견 탭에서 모두 보기 →</a></p></section>';

      if (jr.ok) {
        var sum = V.journalsSummary(jr.data.journals || [], jr.data.today);
        html += '<section class="ops-section"><h2 class="ops-h">사용 일지 · 오늘</h2><div class="ops-cards ops-cards-small">' +
          card('오늘 일지', sum.journalCount) + card('활동 고객', sum.activeCustomers) +
          card('평균 다시 올 점수', sum.avgScore == null ? '—' : sum.avgScore) + card('떠남 위험', sum.atRisk) + '</div>' +
          '<p><a class="ops-link" href="' + V.viewHash('journals') + '">사용 일지 탭 →</a></p></section>';
      }
      view().innerHTML = html;
    });
  }

  /* ------------------------------------------------------------ 고객 */

  function renderCustomers(s, q) {
    var query = q == null ? '' : q;
    api('GET', '/api/admin/customers' + (query ? '?q=' + encodeURIComponent(query) : '')).then(function (res) {
      if (!res.ok) { failed(res, '고객 목록'); return; }
      var all = res.data.customers || [];
      var tabs = V.CUSTOMER_KIND_TABS.map(function (t) {
        return { key: t.key, label: t.label, count: all.filter(function (c) { return !t.key || c.kind === t.key; }).length };
      });
      var rows = s.kind ? all.filter(function (c) { return c.kind === s.kind; }) : all;
      view().innerHTML =
        '<form class="ops-toolbar ops-toolbar-compact" data-form="customer-search"><label>검색<input type="search" name="q" value="' + esc(query) + '" placeholder="이메일 · 이름"></label><button type="submit" class="btn btn-secondary">찾기</button></form>' +
        chips(tabs, s.kind || '', 'data-customer-kind') +
        '<p class="ops-count">' + rows.length + '명 · 줄을 누르면 자세히 봅니다(열어 본 기록이 90일 동안 남아요).</p>' +
        (rows.length ? '<div class="ops-list">' + rows.map(function (c) {
          return '<button type="button" class="ops-row" data-open-customer="' + esc(c.id) + '">' +
            '<span class="ops-row-top"><strong class="ops-name">' + esc(c.name) + '</strong>' +
            (c.kind === 'ai_member' ? '<span class="ops-ai">AI 명예회원</span>' : '<span class="ops-flag">' + esc(c.kind_label) + '</span>') +
            (c.role === 'admin' || c.role === 'superadmin' ? '<span class="ops-flag">' + esc(c.role_label) + '</span>' : '') +
            '<span class="ops-flag">가입 ' + esc(V.formatTime(c.joined_at)) + '</span></span>' +
            '<span class="ops-row-body">' + esc(c.email) + '</span>' +
            '<span class="ops-row-top"><span class="ops-flag">의견 ' + c.feedback_count + '</span><span class="ops-flag">일지 ' + c.journal_count + '</span>' +
            '<span class="ops-flag">최근 로그인 ' + esc(V.formatTime(c.last_login_at)) + '</span></span></button>';
        }).join('') + '</div>' : '<p class="ops-empty">조건에 맞는 고객이 없어요.</p>');
    });
  }

  function renderCustomer(id, notice) {
    api('GET', '/api/admin/customers/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { failed(res, '고객 정보'); return; }
      var c = res.data.customer;
      var staff = c.role === 'admin' || c.role === 'superadmin';
      var html = '<p><a class="ops-link" href="' + V.viewHash('customers') + '">← 고객 목록</a></p>' +
        '<article class="ops-detail ops-detail-static"><h2>' + esc(c.name) + ' ' +
        (c.kind === 'ai_member' ? '<span class="ops-ai">AI 명예회원</span>' : '<span class="ops-flag">' + esc(c.kind_label) + '</span>') + '</h2>' +
        '<dl><dt>이메일</dt><dd>' + esc(c.email) + '</dd><dt>역할</dt><dd>' + esc(c.role_label) + '</dd>' +
        '<dt>가입</dt><dd>' + esc(V.formatTime(c.joined_at)) + '</dd><dt>최근 로그인</dt><dd>' + esc(V.formatTime(c.last_login_at)) + '</dd>' +
        '<dt>이메일 인증</dt><dd>' + (c.email_verified ? '됨' : '안 됨') + '</dd>' +
        '<dt>견적·주문</dt><dd>견적 ' + c.quote_count + ' · 주문 ' + c.order_count + '</dd></dl>' +
        '<form class="ops-form" data-form="customer-role" data-customer-id="' + esc(c.id) + '">' +
        '<label>AI 명예회원 지정<select name="role"' + (staff ? ' disabled' : '') + '>' +
        '<option value="member"' + (c.role !== 'ai_member' ? ' selected' : '') + '>일반 회원</option>' +
        '<option value="ai_member"' + (c.role === 'ai_member' ? ' selected' : '') + '>AI 명예회원</option></select></label>' +
        (staff ? '<p class="fb-hint">관리자 계정의 역할은 여기서 바꾸지 않아요.</p>' : '<p class="fb-hint">AI 명예회원은 마이페이지에 사용 일지 탭이 생기고, 쇼핑몰 머리글과 의견에 \'AI 명예회원\'으로 표시돼요.</p>') +
        '<div data-msg>' + (notice ? alertHtml(notice, 'ok') : '') + '</div>' +
        (staff ? '' : '<button type="submit" class="btn btn-primary">역할 저장</button>') + '</form></article>';

      html += '<section class="ops-section"><h2 class="ops-h">의견 ' + c.feedback.length + '</h2>' +
        (c.feedback.length ? '<div class="ops-list">' + c.feedback.map(feedbackRow).join('') + '</div>' : '<p class="ops-empty">보낸 의견이 없어요.</p>') + '</section>';
      html += '<section class="ops-section"><h2 class="ops-h">사용 일지 ' + c.journals.length + '</h2>' +
        (c.journals.length ? '<div class="ops-list">' + c.journals.map(journalCard).join('') + '</div>' : '<p class="ops-empty">쓴 일지가 없어요.</p>') + '</section>';
      html += '<section class="ops-section"><h2 class="ops-h">열어 본 기록 <span class="ops-sub">최근 20건 · 90일 뒤 지워져요</span></h2><ul class="ops-views">' +
        (res.data.views || []).map(function (v) { return '<li>' + esc(V.formatTime(v.viewed_at)) + ' · ' + esc(v.admin_label) + '</li>'; }).join('') + '</ul></section>';
      view().innerHTML = html;
    });
  }

  /* ------------------------------------------------------------ 의견 */

  function feedbackRow(f) {
    return '<button type="button" class="ops-row" data-open-feedback="' + esc(f.id) + '">' +
      '<span class="ops-row-top"><span class="fb-id">' + esc(f.id) + '</span>' + badge(f.status) +
      '<span>' + esc(f.kind_label || V.KIND_LABEL[f.kind] || f.kind) + '</span>' +
      (f.ai_member_label ? '<span class="ops-ai">' + esc(f.ai_member_label) + '</span>' : '') +
      (f.member_id ? '<span class="ops-flag">회원</span>' : '<span class="ops-flag">비회원</span>') +
      (f.has_reply ? '<span class="ops-flag">답글</span>' : '') +
      (f.followup_count ? '<span class="ops-flag">덧붙임 ' + f.followup_count + '</span>' : '') +
      (f.issue_ref ? '<span class="ops-flag">' + esc(f.issue_ref) + '</span>' : '') +
      '<span class="ops-flag">' + esc(V.formatTime(f.created_at)) + '</span></span>' +
      '<span class="ops-row-body">' + esc(f.body_preview) + '</span>' +
      (f.contact_email_masked ? '<span class="ops-flag">연락처 ' + esc(f.contact_email_masked) + '</span>' : '') +
    '</button>';
  }

  function renderBoard(s) {
    loadFeedback().then(function (fb) {
      if (!fb.ok) { failed(fb.res, '의견'); return; }
      renderTabs('board');
      var rows = V.filterBoardRows(fb.rows, { cat: s.cat, status: s.status });
      view().setAttribute('data-board', JSON.stringify({ cat: s.cat, status: s.status }));
      view().innerHTML =
        '<div class="ops-chip-rows">' + chips(V.boardCatTabs(fb.rows, s.status), s.cat, 'data-board-cat') +
        chips(V.boardStatusTabs(fb.rows, s.cat), s.status, 'data-board-status') + '</div>' +
        '<p class="ops-count">' + rows.length + '건 · 최신순</p>' +
        (rows.length ? '<div class="ops-list">' + rows.map(feedbackRow).join('') + '</div>' : '<p class="ops-empty">이 칩에 맞는 의견이 없어요.</p>');
    });
  }

  function renderFeedback(id, notice) {
    api('GET', '/api/admin/feedback/' + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) { failed(res, '의견'); return; }
      var f = res.data.feedback;
      var page = safeHref(f.page_url);
      var options = V.STATUS_ORDER.map(function (k) {
        return '<option value="' + k + '"' + (k === f.status ? ' selected' : '') + '>' + V.STATUS_LABEL[k] + '</option>';
      }).join('');
      var followups = (f.followups || []).map(function (x) {
        return '<li class="ops-followup' + (x.deleted ? ' is-deleted' : '') + '"><span class="ops-flag">' + esc(V.formatTime(x.created_at)) +
          (x.edited ? ' · 고침' : '') + (x.deleted ? ' · 고객이 지움' : '') + '</span><p>' + V.richParagraph(x.body) + '</p></li>';
      }).join('');
      view().setAttribute('data-feedback', JSON.stringify(f));
      view().innerHTML = '<p><a class="ops-link" href="' + V.viewHash('board') + '">← 의견 목록</a></p>' +
        '<article class="ops-detail ops-detail-static">' +
        '<h2>' + esc(f.id) + ' ' + badge(f.status) + '</h2>' +
        (f.ai_member_label ? '<p><span class="ops-ai">' + esc(f.ai_member_label) + '</span></p>' : '') +
        '<dl><dt>접수</dt><dd>' + esc(V.formatTime(f.created_at)) + '</dd><dt>최근 변경</dt><dd>' + esc(V.formatTime(f.updated_at)) + '</dd>' +
        '<dt>종류</dt><dd>' + esc(f.kind_label) + '</dd>' +
        '<dt>보던 화면</dt><dd>' + (page ? '<a href="' + esc(page) + '" target="_blank" rel="noopener noreferrer">' + esc(page) + '</a>' : '—') + '</dd>' +
        '<dt>연락 이메일</dt><dd>' + (f.contact_email ? esc(f.contact_email) : '—') + '</dd>' +
        '<dt>회원</dt><dd>' + (f.member_id ? '<a class="ops-link" href="' + V.viewHash('customer', f.member_id) + '">회원 #' + esc(f.member_id) + '</a>' : '비회원') + '</dd></dl>' +
        '<p class="fb-body">' + V.richParagraph(f.body) + '</p>' +
        (followups ? '<h3 class="ops-h3">고객 덧붙임</h3><ul class="ops-followups">' + followups + '</ul>' : '') +
        '<form class="ops-form" data-form="feedback">' +
          '<div class="ops-form-row">' +
            '<label>상태<select name="status">' + options + '</select></label>' +
            '<label>GitHub 이슈<input name="issue_ref" value="' + esc(f.issue_ref || '') + '" placeholder="#123" maxlength="120"></label>' +
            '<label>AI 명예회원 이름<input name="ai_member" value="' + esc(f.ai_member || '') + '" placeholder="비우면 일반 의견" maxlength="40"></label>' +
          '</div>' +
          '<label>고객에게 보이는 답글<textarea name="admin_reply" maxlength="2000" placeholder="마이페이지 → 내 의견에 그대로 보입니다">' + esc(f.admin_reply || '') + '</textarea></label>' +
          '<label class="ops-note-label">내부 메모 (고객에게 안 보임)<textarea name="admin_note" maxlength="4000">' + esc(f.admin_note || '') + '</textarea></label>' +
          '<div data-msg>' + (notice ? alertHtml(notice, 'ok') : '') + '</div>' +
          '<button type="submit" class="btn btn-primary">저장</button>' +
        '</form></article>';
    });
  }

  function saveFeedback(form) {
    var f = JSON.parse(view().getAttribute('data-feedback') || '{}');
    var patch = {};
    if (form.elements.status.value !== f.status) patch.status = form.elements.status.value;
    ['admin_reply', 'admin_note', 'issue_ref', 'ai_member'].forEach(function (k) {
      var v = String(form.elements[k].value || '').trim();
      if (v !== String(f[k] || '')) patch[k] = v || null;
    });
    var msg = form.querySelector('[data-msg]');
    if (!Object.keys(patch).length) { msg.innerHTML = alertHtml('바뀐 내용이 없어요.', 'info'); return; }
    api('PATCH', '/api/admin/feedback/' + encodeURIComponent(f.id), patch).then(function (res) {
      if (!res.ok) { msg.innerHTML = alertHtml('저장하지 못했어요: ' + ((res.data && (res.data.detail || res.data.error)) || res.status)); return; }
      renderFeedback(f.id, '저장했어요.');
    });
  }

  /* ------------------------------------------------------------ 사용 일지 */

  function journalCard(j) {
    return '<article class="ops-journal" data-journal-id="' + esc(j.id) + '">' +
      '<p class="ops-row-top"><strong class="ops-name">' + esc(j.customer || '') + '</strong><span class="ops-flag">' + esc(j.journal_date) + '</span>' +
      '<span class="ops-score">다시 올 점수 ' + (j.score == null ? '—' : esc(j.score)) + '</span>' +
      (j.append_count ? '<span class="ops-flag">덧붙임 ' + esc(j.append_count) + '</span>' : '') + '</p>' +
      '<h3 class="ops-h3">' + esc(j.title || '(제목 없음)') + '</h3>' +
      '<details class="ops-journal-body"><summary>본문 보기</summary><p>' + V.richParagraph(j.body) + '</p></details>' +
      '<form class="ops-form ops-form-inline" data-form="journal-note" data-journal-id="' + esc(j.id) + '">' +
      '<label class="ops-note-label">내부 메모 (고객에게 안 보임)<textarea name="admin_note" maxlength="4000" rows="2">' + esc(j.admin_note || '') + '</textarea></label>' +
      '<div data-msg></div><button type="submit" class="btn btn-secondary btn-small">메모 저장</button></form>' +
    '</article>';
  }

  function renderJournals(s) {
    api('GET', '/api/admin/journals?limit=500').then(function (res) {
      if (!res.ok) { failed(res, '사용 일지'); return; }
      var all = res.data.journals || [];
      var sum = V.journalsSummary(all, res.data.today);
      var options = V.journalCustomerOptions(V.journalListRows(all));
      var rows = s.member ? all.filter(function (j) { return String(j.member_id) === String(s.member); }) : all;
      var people = V.journalRowsByCustomer(all);
      view().innerHTML =
        '<div class="ops-cards ops-cards-small">' + card('오늘 일지', sum.journalCount) + card('활동 고객', sum.activeCustomers) +
        card('평균 다시 올 점수', sum.avgScore == null ? '—' : sum.avgScore) + card('떠남 위험', sum.atRisk) + '</div>' +
        (people.length ? '<div class="ops-people">' + people.map(function (p) {
          return '<span class="ops-person' + (p.atRisk ? ' is-risk' : '') + '">' + esc(p.name) + ' · ' + esc(p.stage) + ' · ' + p.dayCount + '일 · 최근 ' + (p.latestScore == null ? '—' : p.latestScore) +
            (p.atRisk ? ' · 떠남 위험' : '') + '</span>';
        }).join('') + '</div>' : '') +
        '<div class="ops-toolbar ops-toolbar-compact"><label>고객<select id="opsJournalMember"><option value="">전체</option>' +
        options.map(function (o) { return '<option value="' + esc(o.member_id) + '"' + (String(o.member_id) === String(s.member) ? ' selected' : '') + '>' + esc(o.name) + '</option>'; }).join('') +
        '</select></label></div>' +
        '<p class="ops-count">' + rows.length + '건 · 최신순 · 일지는 알림을 보내지 않아요</p>' +
        (rows.length ? '<div class="ops-list">' + rows.map(journalCard).join('') + '</div>' : '<p class="ops-empty">쓴 일지가 없어요.</p>');
    });
  }

  /* ------------------------------------------------------------ 고치는 일 */

  function renderIssues() {
    loadFeedback().then(function (fb) {
      if (!fb.ok) { failed(fb.res, '의견'); return; }
      renderTabs('issues');
      var groups = V.linkedIssueGroups(fb.rows);
      view().innerHTML = '<p class="ops-count">이슈 번호가 연결된 의견만 모았어요(' + groups.length + '개 이슈).</p>' +
        (groups.length ? groups.map(function (g) {
          return '<section class="ops-issue"><h3 class="ops-h3"><a href="' + esc(g.url) + '" target="_blank" rel="noopener noreferrer">#' + esc(g.number) + '</a>' +
            ' <span class="ops-flag">의견 ' + g.total + ' · 고침/닫음 ' + g.done + ' · 남음 ' + g.open + '</span></h3>' +
            '<div class="ops-list">' + g.rows.map(feedbackRow).join('') + '</div></section>';
        }).join('') : '<p class="ops-empty">이슈 번호가 연결된 의견이 없어요. 의견 상세에서 GitHub 이슈 칸에 번호를 넣으면 여기 모입니다.</p>');
    });
  }

  /* ------------------------------------------------------------ 새 소식 */

  function renderNews(notice) {
    api('GET', '/api/admin/news').then(function (res) {
      if (!res.ok) { failed(res, '새 소식'); return; }
      var items = res.data.items || [];
      view().innerHTML = '<div class="ops-news-grid">' +
        '<form class="ops-form ops-detail ops-detail-static" data-form="news"><h2>새 소식 쓰기</h2>' +
        '<label>제목<input name="title" maxlength="120" required></label>' +
        '<label>내용<textarea name="body" maxlength="4000" rows="6" required></textarea></label>' +
        '<label>출처 묶음<select name="source_tag"><option value="user_feedback">사용자 의견으로 고친 것</option><option value="ai_member">AI 명예회원이 알려 준 것</option></select></label>' +
        '<p class="fb-hint">공개 화면에는 출처 묶음만 나오고, 누가 말했는지는 나오지 않아요.</p>' +
        '<label class="ops-check"><span><input type="checkbox" name="published"> 바로 게시</span></label>' +
        '<div data-msg>' + (notice ? alertHtml(notice, 'ok') : '') + '</div><button type="submit" class="btn btn-primary">저장</button></form>' +
        '<div class="ops-list">' + (items.length ? items.map(function (n) {
          return '<article class="ops-news-item"><p class="news-meta"><span class="news-tag news-tag-' + esc(n.source_tag) + '">' + esc(SOURCE_LABELS[n.source_tag] || n.source_tag) + '</span>' +
            (n.published ? '게시 ' + esc(V.formatTime(n.published_at)) : '<strong>초안</strong>') + '</p><h3>' + esc(n.title) + '</h3><p class="news-body">' + esc(n.body) + '</p>' +
            '<div class="ops-news-actions"><button type="button" class="btn btn-small ' + (n.published ? 'btn-secondary' : 'btn-primary') + '" data-news-id="' + esc(n.id) + '" data-news-publish="' + (!n.published) + '">' + (n.published ? '게시 내리기' : '게시') + '</button></div></article>';
        }).join('') : '<p class="ops-empty">아직 쓴 소식이 없습니다.</p>') + '</div></div>';
    });
  }

  /* ------------------------------------------------------------ 이벤트 */

  function currentBoard() { return JSON.parse(view().getAttribute('data-board') || '{}'); }

  function onViewClick(event) {
    var t = event.target;
    var el;
    if ((el = t.closest('[data-open-feedback]'))) { location.hash = V.viewHash('feedback', el.getAttribute('data-open-feedback')); return; }
    if ((el = t.closest('[data-open-customer]'))) { location.hash = V.viewHash('customer', el.getAttribute('data-open-customer')); return; }
    if ((el = t.closest('[data-customer-kind]'))) { location.hash = V.viewHash('customers', null, { kind: el.getAttribute('data-customer-kind') }); return; }
    if ((el = t.closest('[data-board-cat]'))) { var b1 = currentBoard(); location.hash = V.viewHash('board', null, { cat: el.getAttribute('data-board-cat'), status: b1.status }); return; }
    if ((el = t.closest('[data-board-status]'))) {
      var b2 = currentBoard();
      var key = el.getAttribute('data-board-status');
      // 고른 상태 칩을 다시 누르면 상태 거르기를 풀어 그 갈래의 모든 글을 본다(러브트리와 같다).
      location.hash = V.viewHash('board', null, { cat: b2.cat, status: key === b2.status ? V.ALL_STATUS : key });
      return;
    }
    if ((el = t.closest('[data-news-publish]'))) {
      api('PATCH', '/api/admin/news/' + encodeURIComponent(el.getAttribute('data-news-id')), { published: el.getAttribute('data-news-publish') === 'true' })
        .then(function (res) { renderNews(res.ok ? '바꿨어요.' : ''); });
    }
  }

  function onViewChange(event) {
    if (event.target.id === 'opsJournalMember') location.hash = V.viewHash('journals', null, { member: event.target.value });
  }

  function onViewSubmit(event) {
    var form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    var kind = form.getAttribute('data-form');
    var msg = form.querySelector('[data-msg]');
    if (kind === 'feedback') return saveFeedback(form);
    if (kind === 'customer-search') return renderCustomers(V.parseHash(location.hash), form.elements.q.value.trim());
    if (kind === 'customer-role') {
      var id = form.getAttribute('data-customer-id');
      api('PATCH', '/api/admin/customers/' + encodeURIComponent(id) + '/role', { role: form.elements.role.value }).then(function (res) {
        if (!res.ok) { msg.innerHTML = alertHtml('저장하지 못했어요: ' + ((res.data && (res.data.detail || res.data.error)) || res.status)); return; }
        renderCustomer(id, '역할을 저장했어요.');
      });
      return;
    }
    if (kind === 'journal-note') {
      api('PATCH', '/api/admin/journals/' + encodeURIComponent(form.getAttribute('data-journal-id')), { admin_note: form.elements.admin_note.value }).then(function (res) {
        msg.innerHTML = res.ok ? alertHtml('메모를 저장했어요.', 'ok') : alertHtml('저장하지 못했어요 (HTTP ' + res.status + ').');
      });
      return;
    }
    if (kind === 'news') {
      var payload = { title: form.elements.title.value.trim(), body: form.elements.body.value.trim(), source_tag: form.elements.source_tag.value, published: !!form.elements.published.checked };
      if (!payload.title || !payload.body) { msg.innerHTML = alertHtml('제목과 내용을 적어 주세요.'); return; }
      api('POST', '/api/admin/news', payload).then(function (res) {
        if (!res.ok) { msg.innerHTML = alertHtml('저장하지 못했어요: ' + ((res.data && (res.data.detail || res.data.error)) || res.status)); return; }
        renderNews(payload.published ? '게시했어요.' : '초안으로 저장했어요.');
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
