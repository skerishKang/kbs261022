/* ==========================================================================
   CGI 운영센터 화면의 순수 조각 — 러브트리 운영센터 src/admin-view.js 와 같은 이름·개념.
   DOM·가져오기 없이 node 시험(vm)에서 바로 쓴다. window.CGI_OPS_VIEW 로 내보낸다.
   - 탭: 한눈에 · 고객 · 의견 · 사용 일지 · 고치는 일 (+ CGI 전용 새 소식)
   - 의견 탭: 갈래 칩(고장·불편 / 요청 / 상품·가격) × 상태 칩(할 일 · 고침 · 더 보기)
   - 상태 코드 값은 러브트리와 같다: received(새 글) / reviewing / fixed / later / closed
   ========================================================================== */
(function (root) {
  'use strict';

  var GITHUB_REPO = 'skerishKang/kbs261022';

  var MENU_TABS = [
    { view: 'overview', label: '한눈에' },
    { view: 'customers', label: '고객' },
    { view: 'board', label: '의견', countKey: 'opinion' },
    { view: 'journals', label: '사용 일지' },
    { view: 'issues', label: '고치는 일' },
    { view: 'news', label: '새 소식' } // CGI 전용: 공개 버전 노트
  ];

  // '받음'은 운영센터에서 '새 글'로 부른다(러브트리 #570 2). 고객 화면 표시는 '접수'.
  var STATUS_LABEL = { received: '새 글', reviewing: '확인 중', fixed: '고침', later: '다음에', closed: '닫음' };
  var STATUS_ORDER = ['received', 'reviewing', 'fixed', 'later', 'closed'];
  var KIND_LABEL = { bug: '오류', inconvenient: '불편', feature: '요청', other: '기타', product: '상품·가격 문의' };

  var PENDING_STATUS = 'pending';
  var ALL_STATUS = 'all';
  var BOARD_STATUS_TABS = [
    { key: PENDING_STATUS, label: '할 일' },
    { key: 'fixed', label: '고침' },
    { key: 'more', label: '더 보기 ▾' }
  ];
  // 고장·불편 = 오류·불편·기타, 요청 = feature. 상품·가격 문의는 CGI 전용 갈래.
  var ISSUE_CATEGORIES = ['bug', 'inconvenient', 'other'];
  var BOARD_CAT_TABS = [
    { key: '', label: '전체' },
    { key: 'issue', label: '고장·불편' },
    { key: 'request', label: '요청' },
    { key: 'product', label: '상품·가격' }
  ];
  var CUSTOMER_KIND_TABS = [
    { key: '', label: '전체' },
    { key: 'real', label: '실제 고객' },
    { key: 'ai_member', label: 'AI 명예회원' },
    { key: 'tester', label: '시험 계정' }
  ];

  function list(rows) { return Array.isArray(rows) ? rows : []; }
  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function richParagraph(value) { return escapeText(value).replace(/\r\n|\n|\r/g, '<br>'); }
  function pad2(n) { return String(n).padStart(2, '0'); }

  /** '11.14 06:31' — 지역 시간, 초 없음. 없는 값은 '—'. */
  function formatTime(value) {
    if (value == null || value === '') return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isPendingStatus(status) { return status === 'received' || status === 'reviewing'; }

  /** 연결 이슈 번호를 숫자 글자로('#584' → '584'). 숫자가 아니면 ''. */
  function normalizeIssueNumber(value) {
    var raw = String(value == null ? '' : value).trim().replace(/^#/, '').trim();
    return /^\d{1,20}$/.test(raw) ? raw : '';
  }
  function issueUrl(number) {
    var n = normalizeIssueNumber(number);
    return n ? 'https://github.com/' + GITHUB_REPO + '/issues/' + n : '';
  }

  function inBoardCat(row, cat) {
    var kind = row && row.kind;
    if (!cat) return true;
    if (cat === 'request') return kind === 'feature';
    if (cat === 'product') return kind === 'product';
    // 종류가 비어 있는 옛 의견도 고장·불편에 둔다 — 어느 칩에서도 사라지지 않게.
    return !kind || ISSUE_CATEGORIES.indexOf(kind) >= 0;
  }

  /** 한 줄이 상태 칩에 들어가는가 — '더 보기'는 다음에·닫음·이슈 있는 글. */
  function inBoardStatus(row, key) {
    var status = String((row && row.status) || '');
    if (key === PENDING_STATUS) return isPendingStatus(status);
    if (key === 'fixed') return status === 'fixed';
    if (key === ALL_STATUS) return true;
    if (key === 'more') return status === 'later' || status === 'closed' || !!normalizeIssueNumber(row && row.issue_ref);
    return false;
  }

  /** 의견 목록 거르기 — 갈래와 상태를 함께. 상태 기본은 '할 일'. */
  function filterBoardRows(rows, opts) {
    var o = opts || {};
    var status = o.status || PENDING_STATUS;
    return list(rows).filter(function (row) { return inBoardCat(row, o.cat || '') && inBoardStatus(row, status); });
  }

  /** 상태 칩 숫자 — 지금 갈래 안에서 센다. */
  function boardStatusTabs(rows, cat) {
    var scoped = list(rows).filter(function (row) { return inBoardCat(row, cat || ''); });
    return BOARD_STATUS_TABS.map(function (tab) {
      return { key: tab.key, label: tab.label, count: scoped.filter(function (row) { return inBoardStatus(row, tab.key); }).length };
    });
  }

  /** 갈래 칩 숫자 — 지금 상태 칩 안에서 센다. */
  function boardCatTabs(rows, status) {
    var scoped = list(rows).filter(function (row) { return inBoardStatus(row, status || PENDING_STATUS); });
    return BOARD_CAT_TABS.map(function (tab) {
      return { key: tab.key, label: tab.label, count: scoped.filter(function (row) { return inBoardCat(row, tab.key); }).length };
    });
  }

  /** 상단 메뉴의 새 글(received) 수. */
  function menuReceivedCounts(rows) {
    return { opinion: list(rows).filter(function (row) { return row && row.status === 'received'; }).length };
  }

  /** 고치는 일: 이슈 번호가 연결된 의견만 번호별로 모아 번호 내림차순. */
  function linkedIssueGroups(rows) {
    var map = {};
    list(rows).forEach(function (row) {
      var n = normalizeIssueNumber(row && row.issue_ref);
      if (!n) return;
      (map[n] = map[n] || []).push(row);
    });
    return Object.keys(map).map(Number).sort(function (a, b) { return b - a; }).map(function (n) {
      var items = map[String(n)];
      var fixed = items.filter(function (r) { return r.status === 'fixed' || r.status === 'closed'; }).length;
      return { number: String(n), url: issueUrl(n), rows: items, total: items.length, done: fixed, open: items.length - fixed };
    });
  }

  /** 오늘 할 일: 답글 없는 할 일 상태 의견 중 오래된 순 5개. */
  function overviewTodos(rows, limit) {
    return list(rows)
      .filter(function (row) { return isPendingStatus(row && row.status) && !row.has_reply; })
      .slice()
      .sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); })
      .slice(0, limit || 5);
  }

  // ── 사용 일지 탭 ──

  function journalDayOf(row) { return String((row && row.journal_date) || String((row && row.created_at) || '').slice(0, 10)); }

  /** 일지 날짜 수로 보는 단계: 1일 '시작', 2~4일 '꾸준', 5일 이상 '정착'. */
  function journalStage(dayCount) { return dayCount >= 5 ? '정착' : dayCount >= 2 ? '꾸준' : '시작'; }

  /** 고객별 줄: 이름·단계·최근 점수·점수 흐름·마지막 기록일. 이틀 연속 2 이하면 떠남 위험. */
  function journalRowsByCustomer(journals) {
    var map = {};
    var order = [];
    list(journals).forEach(function (row) {
      var key = String(row.member_id || ('anon:' + row.id));
      if (!map[key]) { map[key] = { member_id: row.member_id, name: row.customer || '고객', journals: [] }; order.push(key); }
      map[key].journals.push(row);
    });
    var rows = order.map(function (key) {
      var entry = map[key];
      var byDay = {};
      entry.journals.forEach(function (row) { if (!byDay[journalDayOf(row)]) byDay[journalDayOf(row)] = row; });
      var days = Object.keys(byDay).sort();
      var last = days.length ? byDay[days[days.length - 1]].score : null;
      var prev = days.length >= 2 ? byDay[days[days.length - 2]].score : null;
      return {
        member_id: entry.member_id,
        name: entry.name,
        dayCount: days.length,
        stage: journalStage(days.length),
        latestScore: last == null ? null : last,
        lastDay: days.length ? days[days.length - 1] : '',
        flow: days.map(function (day) { return { day: day, score: byDay[day].score == null ? null : byDay[day].score }; }),
        atRisk: last != null && prev != null && last <= 2 && prev <= 2
      };
    });
    return rows.sort(function (a, b) { return String(b.lastDay).localeCompare(String(a.lastDay)); });
  }

  /** 오늘 요약: 활동 고객 수·오늘 일지 수·평균 다시 올 점수·떠남 위험 수. */
  function journalsSummary(journals, day) {
    var today = list(journals).filter(function (row) { return journalDayOf(row) === day; });
    var subjects = {};
    today.forEach(function (row) { if (row.member_id != null) subjects[row.member_id] = true; });
    var scores = today.map(function (row) { return row.score; }).filter(function (s) { return s != null; });
    return {
      activeCustomers: Object.keys(subjects).length,
      journalCount: today.length,
      avgScore: scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length * 10) / 10 : null,
      atRisk: journalRowsByCustomer(journals).filter(function (row) { return row.atRisk; }).length
    };
  }

  /** 일지 목록 줄: 최신 순, 고객·날짜·점수·제목. */
  function journalListRows(journals) {
    return list(journals).slice().sort(function (a, b) {
      return (journalDayOf(b) + String(b.updated_at || '')).localeCompare(journalDayOf(a) + String(a.updated_at || ''));
    }).map(function (row) {
      return {
        id: row.id, member_id: row.member_id, customer: row.customer || '고객', day: journalDayOf(row),
        score: row.score == null ? null : row.score, title: String(row.title || '(제목 없음)'), appended: Number(row.append_count || 0)
      };
    });
  }

  /** 일지 탭의 고객 거르기 목록(이름 가나다 순). */
  function journalCustomerOptions(rows) {
    var seen = {};
    list(rows).forEach(function (row) { if (row.member_id != null && !seen[row.member_id]) seen[row.member_id] = row.customer; });
    return Object.keys(seen).map(function (id) { return { member_id: id, name: seen[id] }; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ko'); });
  }

  /**
   * '한눈에' 숫자 카드 — 서버 /api/admin/ops/stats 응답만 받는다. 값이 이상하면 숫자를 지어내지 않고 error.
   * 실제 고객·AI 명예회원·시험 계정은 겹치지 않고 합이 전체다.
   */
  function statsCards(stats) {
    var num = function (v) { return Number.isSafeInteger(v) && v >= 0 ? v : null; };
    var a = stats && stats.accounts;
    var f = stats && stats.feedback;
    if (!a || !f) return { error: true, cards: [] };
    var cards = [
      { key: 'total', label: '전체 계정', value: num(a.total), detail: a.new7 ? '7일 새 ' + num(a.new7.total) : '' },
      { key: 'real', label: '실제 고객', value: num(a.real), detail: a.new7 ? '7일 새 ' + num(a.new7.real) : '' },
      { key: 'ai_member', label: 'AI 명예회원', value: num(a.ai_member), detail: a.new7 ? '7일 새 ' + num(a.new7.ai_member) : '' },
      { key: 'tester', label: '시험 계정', value: num(a.tester), detail: a.new7 ? '7일 새 ' + num(a.new7.tester) : '' },
      { key: 'new7', label: '7일 신규 가입', value: a.new7 ? num(a.new7.total) : null, detail: '' },
      { key: 'received', label: '새 의견', value: num(f.received), detail: '할 일 ' + num(f.pending) + ' · 7일 ' + num(f.new7) }
    ];
    return { error: cards.some(function (c) { return c.value === null; }), cards: cards };
  }

  // ── 주소(해시) ↔ 화면 상태 ──

  function parseHash(hash) {
    var raw = String(hash == null ? '' : hash).replace(/^#/, '');
    var parts = raw.split('?');
    var path = parts[0];
    var params = new URLSearchParams(parts[1] || '');
    var seg = path.split('/');
    var name = seg[0];
    var id = decodeURIComponent(seg.slice(1).join('/') || '');
    if (!name || name === 'overview') return { view: 'overview' };
    if (name === 'customers') {
      var kind = params.get('kind');
      return { view: 'customers', kind: ['real', 'ai_member', 'tester'].indexOf(kind) >= 0 ? kind : '' };
    }
    if (name === 'customer' && id) return { view: 'customer', id: id };
    if (name === 'feedback' && id) return { view: 'feedback', id: id };
    if (name === 'journals') return { view: 'journals', member: params.get('member') || '' };
    if (name === 'issues') return { view: 'issues' };
    if (name === 'news') return { view: 'news' };
    var status = params.get('status');
    var cat = params.get('cat');
    return {
      view: 'board',
      status: [PENDING_STATUS, 'fixed', 'more', ALL_STATUS].indexOf(status) >= 0 ? status : PENDING_STATUS,
      cat: ['issue', 'request', 'product'].indexOf(cat) >= 0 ? cat : ''
    };
  }

  function viewHash(view, id, filters) {
    var f = filters || {};
    if (view === 'board') {
      var q = [];
      if (f.status && f.status !== PENDING_STATUS) q.push('status=' + encodeURIComponent(f.status));
      if (f.cat) q.push('cat=' + encodeURIComponent(f.cat));
      return '#board' + (q.length ? '?' + q.join('&') : '');
    }
    if (view === 'feedback' && id != null) return '#feedback/' + encodeURIComponent(id);
    if (view === 'customer' && id != null) return '#customer/' + encodeURIComponent(id);
    if (view === 'customers') return '#customers' + (f.kind ? '?kind=' + encodeURIComponent(f.kind) : '');
    if (view === 'journals') return '#journals' + (f.member ? '?member=' + encodeURIComponent(f.member) : '');
    if (view === 'issues' || view === 'news' || view === 'overview') return '#' + view;
    return '#overview';
  }

  /** 상세 화면은 소속 탭을 눌린 것으로 본다. */
  function viewToTab(view) {
    if (view === 'customer') return 'customers';
    if (view === 'feedback') return 'board';
    return view || 'overview';
  }

  root.CGI_OPS_VIEW = {
    GITHUB_REPO: GITHUB_REPO,
    MENU_TABS: MENU_TABS,
    STATUS_LABEL: STATUS_LABEL,
    STATUS_ORDER: STATUS_ORDER,
    KIND_LABEL: KIND_LABEL,
    PENDING_STATUS: PENDING_STATUS,
    ALL_STATUS: ALL_STATUS,
    BOARD_STATUS_TABS: BOARD_STATUS_TABS,
    BOARD_CAT_TABS: BOARD_CAT_TABS,
    ISSUE_CATEGORIES: ISSUE_CATEGORIES,
    CUSTOMER_KIND_TABS: CUSTOMER_KIND_TABS,
    escapeText: escapeText,
    richParagraph: richParagraph,
    formatTime: formatTime,
    isPendingStatus: isPendingStatus,
    normalizeIssueNumber: normalizeIssueNumber,
    issueUrl: issueUrl,
    inBoardCat: inBoardCat,
    inBoardStatus: inBoardStatus,
    filterBoardRows: filterBoardRows,
    boardStatusTabs: boardStatusTabs,
    boardCatTabs: boardCatTabs,
    menuReceivedCounts: menuReceivedCounts,
    linkedIssueGroups: linkedIssueGroups,
    overviewTodos: overviewTodos,
    journalStage: journalStage,
    journalRowsByCustomer: journalRowsByCustomer,
    journalsSummary: journalsSummary,
    journalListRows: journalListRows,
    journalCustomerOptions: journalCustomerOptions,
    statsCards: statsCards,
    parseHash: parseHash,
    viewHash: viewHash,
    viewToTab: viewToTab
  };
})(typeof window !== 'undefined' ? window : globalThis);
