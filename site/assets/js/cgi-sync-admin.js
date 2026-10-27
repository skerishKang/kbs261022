(function () {
  'use strict';

  const API = ((window.CGI_SITE_CONFIG && window.CGI_SITE_CONFIG.quoteApiUrl) || '') + '/api';
  const state = { items: [], summary: null, selected: new Set() };

  function $(id) { return document.getElementById(id); }

  async function authHeaders() {
    const token = localStorage.getItem('cgiAdminToken') || '';
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  async function fetchJson(path) {
    const res = await fetch(API + path, { credentials: 'include', headers: await authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function postJson(path, body) {
    const res = await fetch(API + path, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, await authHeaders()),
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function renderSummary() {
    const box = $('syncStatusBox');
    if (!state.summary) { box.textContent = '상태 정보 없음'; return; }
    const s = state.summary;
    const parts = ['전체 ' + (s.total || 0)];
    for (const [k, v] of Object.entries(s.byStatus || {})) parts.push(k + ' ' + v);
    box.innerHTML = '<p class="toolbar-note">' + parts.join(' · ') + '</p>';
    const targetParts = [];
    for (const [t, st] of Object.entries(s.byTarget || {})) {
      targetParts.push(t + ': ' + Object.entries(st).map(([k, v]) => k + ' ' + v).join(', '));
    }
    if (targetParts.length) box.innerHTML += '<p class="toolbar-note">' + targetParts.join(' | ') + '</p>';
  }

  function renderTable() {
    const box = $('syncTableBox');
    const items = state.items || [];
    if (!items.length) { box.innerHTML = '<p class="toolbar-note">표시할 상품 동기화 상태가 없습니다.</p>'; return; }
    let html = '<table class="request-table"><thead><tr><th><input type="checkbox" id="selectAll"></th><th>CGI ID</th><th>대상</th><th>상태</th><th>재시도</th><th>마지막 오류</th><th>마지막 시도</th></tr></thead><tbody>';
    for (const it of items) {
      const checked = state.selected.has(it.cgi_id) ? 'checked' : '';
      html += '<tr>' +
        '<td><input type="checkbox" class="rowCheck" data-id="' + escapeHtml(it.cgi_id) + '" ' + checked + '></td>' +
        '<td>' + escapeHtml(it.cgi_id) + '</td>' +
        '<td>' + escapeHtml(it.target) + '</td>' +
        '<td>' + escapeHtml(it.status) + '</td>' +
        '<td>' + (it.retry_count || 0) + '</td>' +
        '<td>' + escapeHtml(it.last_error || '-') + '</td>' +
        '<td>' + escapeHtml(it.last_attempt_at || '-') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    box.innerHTML = html;
    const selectAll = $('selectAll');
    if (selectAll) selectAll.addEventListener('change', (e) => {
      const checks = box.querySelectorAll('.rowCheck');
      checks.forEach((c) => { if (e.target.checked) state.selected.add(c.dataset.id); else state.selected.delete(c.dataset.id); c.checked = e.target.checked; });
    });
    box.querySelectorAll('.rowCheck').forEach((c) => {
      c.addEventListener('change', () => {
        if (c.checked) state.selected.add(c.dataset.id); else state.selected.delete(c.dataset.id);
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function load() {
    const target = $('syncTarget').value;
    const status = $('syncStatus').value;
    const q = $('syncSearch').value.trim();
    const params = [];
    if (target) params.push('target=' + encodeURIComponent(target));
    if (status) params.push('status=' + encodeURIComponent(status));
    if (q) params.push('q=' + encodeURIComponent(q));
    params.push('limit=200');
    try {
      const data = await fetchJson('/admin/sync/products?' + params.join('&'));
      state.items = data.items || [];
      const summary = await fetchJson('/admin/sync/status');
      state.summary = summary;
      renderSummary();
      renderTable();
      $('syncSummary').textContent = '조회 ' + state.items.length + '건';
    } catch (e) {
      $('syncSummary').textContent = '불러오기 실패: ' + e.message;
    }
  }

  async function retry() {
    const ids = [...state.selected];
    if (!ids.length) { alert('재처리할 상품을 선택하세요.'); return; }
    try {
      const r = await postJson('/admin/sync/retry', { cgiIds: ids });
      alert('재처리 요청 ' + r.retried + '/' + r.total + '건');
      state.selected.clear();
      await load();
    } catch (e) {
      alert('재처리 실패: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if ($('syncRefreshBtn')) $('syncRefreshBtn').addEventListener('click', load);
    if ($('syncRetryBtn')) $('syncRetryBtn').addEventListener('click', retry);
    if ($('syncTarget')) $('syncTarget').addEventListener('change', load);
    if ($('syncStatus')) $('syncStatus').addEventListener('change', load);
    let t;
    if ($('syncSearch')) $('syncSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
    if ($('logoutBtn')) $('logoutBtn').addEventListener('click', () => { localStorage.removeItem('cgiAdminToken'); location.reload(); });
    load();
  });
})();
