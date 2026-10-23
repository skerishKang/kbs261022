(function () {
  'use strict';
  var products = window.CGI_PRODUCTS || [];
  var services = window.CGI_SERVICES || [];
  var requests = [];
  var current = null;
  var adminToken = null;
  var isServerMode = false;
  var prices = {}; // productId -> unit price number
  var servicePrices = {}; // serviceId -> unit price number

  function loadRequests() {
    try { requests = JSON.parse(localStorage.getItem('cgiQuoteRequests') || '[]'); } catch (e) { requests = []; }
    if (!Array.isArray(requests)) requests = [];
  }

  function saveRequests() {
    try { localStorage.setItem('cgiQuoteRequests', JSON.stringify(requests)); } catch (e) {}
  }

  function findProduct(id) {
    for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i];
    return null;
  }

  var STATUS_LABELS = { received: '접수', quoted: '견적 발송', completed: '완료', cancelled: '취소' };

  function formatDate(value) {
    if (!value) return '일시 미확인';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function statusLabel(status) { return STATUS_LABELS[status] || '접수'; }

  function renderList() {
    var el = document.getElementById('requestList');
    if (!Array.isArray(requests) || !requests.length) {
      el.innerHTML = '<p class="staff-empty">접수된 견적 요청이 없습니다. 고객이 견적을 요청하면 이곳에 표시됩니다.</p>';
      return;
    }
    var html = '';
    requests.forEach(function (r) {
      var items = r.items;
      if (typeof items === 'string') { try { items = JSON.parse(items || '[]'); } catch (e) { items = []; } }
      var count = Array.isArray(items) ? items.length : 0;
      var status = r.status || 'received';
      html += '<article class="request-card" data-request-card="' + esc(r.id) + '">' +
        '<div class="request-main">' +
          '<span class="request-id">' + esc(r.id) + '</span>' +
          '<span class="request-company">' + esc(r.company || '회사 미확인') + '</span>' +
          '<div class="request-meta">' +
            '<span>' + esc(formatDate(r.createdAt || r.created_at)) + '</span>' +
            '<span>담당 ' + esc(r.name || '-') + '</span>' +
            '<span>상품 ' + count + '건</span>' +
          '</div>' +
        '</div>' +
        '<div class="request-actions">' +
          '<span class="status-badge ' + esc(status) + '">' + esc(statusLabel(status)) + '</span>' +
          '<button type="button" class="btn btn-secondary" data-open="' + esc(r.id) + '">상세 보기</button>' +
        '</div>' +
      '</article>';
    });
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('button[data-open]'), function (btn) {
      btn.addEventListener('click', function () {
        openRequest(btn.getAttribute('data-open'));
      });
    });
  }

  function openRequest(id) {
    if (isServerMode && apiUrl && adminToken) {
      fetch(apiUrl + '/api/quotes/' + encodeURIComponent(id), { headers: { 'Authorization': 'Bearer ' + adminToken } })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (row) {
          if (!row || !row.id) throw new Error('응답에 요청 정보가 없습니다.');
          if (typeof row.items === 'string') { try { row.items = JSON.parse(row.items || '[]'); } catch (e) { row.items = []; } }
          if (typeof row.services === 'string') { try { row.services = JSON.parse(row.services || '[]'); } catch (e) { row.services = []; } }
          if (typeof row.admin_prices === 'string') { try { row.admin_prices = JSON.parse(row.admin_prices || 'null'); } catch (e) { row.admin_prices = null; } }
          prices = {}; servicePrices = {};
          if (row.admin_prices && typeof row.admin_prices === 'object') {
            Object.keys(row.admin_prices).forEach(function (k) {
              if (findProduct(k)) prices[k] = row.admin_prices[k];
              else servicePrices[k] = row.admin_prices[k];
            });
          }
          for (var i = 0; i < requests.length; i++) {
            if (requests[i].id === id) { requests[i] = row; break; }
          }
          current = row;
          renderDetail();
        })
        .catch(function (err) {
          var local = null;
          for (var i = 0; i < requests.length; i++) {
            if (requests[i].id === id) { local = requests[i]; break; }
          }
          if (local) {
            current = local;
            renderDetail();
            return;
          }
          console.error(err);
          alert('상세 조회 실패: ' + err.message);
        });
      return;
    }
    for (var i = 0; i < requests.length; i++) {
      if (requests[i].id === id) { current = requests[i]; break; }
    }
    if (!current) return;
    renderDetail();
  }

  function renderDetail() {
    var el = document.getElementById('requestDetail');
    if (!current) { el.innerHTML = ''; return; }
    var r = current;
    var status = r.status || 'received';
    var serviceNames = (r.services || []).map(function (sid) {
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) return services[i].name;
      return sid;
    });
    var html = '<div class="detail-block"><h3>견적 요청 상세</h3>';
    html += '<p><strong>' + esc(r.id) + '</strong> · ' + esc(formatDate(r.createdAt || r.created_at)) +
      ' · <span class="status-badge ' + esc(status) + '">' + esc(statusLabel(status)) + '</span></p>';
    html += '<p>회사: ' + esc(r.company) + ' / 담당자: ' + esc(r.name) + ' / 연락처: ' + esc(r.phone) +
      ' / 이메일: ' + esc(r.email) + '</p>';
    html += '<p>장소: ' + esc(r.location || '-') + (r.note ? ' · 요청 사항: ' + esc(r.note) : '') + '</p>';
    html += '<p>서비스: ' + esc(serviceNames.length ? serviceNames.join(', ') : '없음') + '</p>';
    html += '<div class="table-scroll"><table class="spec-table"><thead><tr><th>상품</th><th>브랜드</th><th>카테고리</th><th>수량</th><th>단가(입력)</th><th>금액</th></tr></thead><tbody>';
    var total = 0;
    (r.items || []).forEach(function (it) {
      var unit = prices[it.id];
      if (unit === undefined) unit = '';
      var qty = it.qty || 1;
      var amount = (unit !== '' && !isNaN(unit)) ? (Number(unit) * qty) : 0;
      if (unit !== '' && !isNaN(unit)) total += amount;
      html += '<tr>' +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(it.brand) + '</td>' +
        '<td>' + esc(it.category) + '</td>' +
        '<td>' + qty + '</td>' +
        '<td><input type="number" min="0" step="1" data-price="' + esc(it.id) + '" value="' + esc(unit) + '"></td>' +
        '<td>' + (unit !== '' && !isNaN(unit) ? amount.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '</tr>';
    });
    // services
    (r.services || []).forEach(function (sid) {
      var svc = null;
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) { svc = services[i]; break; }
      var unit = servicePrices[sid];
      if (unit === undefined) unit = '';
      var amount = (unit !== '' && !isNaN(unit)) ? Number(unit) : 0;
      if (unit !== '' && !isNaN(unit)) total += amount;
      html += '<tr>' +
        '<td>' + esc(svc ? svc.name : sid) + ' (서비스)</td>' +
        '<td>-</td><td>-</td><td>1</td>' +
        '<td><input type="number" min="0" step="1" data-svcprice="' + esc(sid) + '" value="' + esc(unit) + '"></td>' +
        '<td>' + (unit !== '' && !isNaN(unit) ? amount.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<p><strong>합계(확정분): ' + total.toLocaleString('ko-KR') + '</strong> <span>(미확정 항목 제외)</span></p>';
    html += '<div class="staff-actions">' +
      '<label>상태 <select id="statusSelect">' +
        '<option value="received"' + (status === 'received' ? ' selected' : '') + '>접수</option>' +
        '<option value="quoted"' + (status === 'quoted' ? ' selected' : '') + '>견적 발송</option>' +
        '<option value="completed"' + (status === 'completed' ? ' selected' : '') + '>완료</option>' +
        '<option value="cancelled"' + (status === 'cancelled' ? ' selected' : '') + '>취소</option>' +
      '</select></label>' +
      '<button type="button" class="btn btn-primary" id="savePriceBtn">단가 저장</button>' +
      '<button type="button" class="btn btn-secondary" id="exportCsvBtn">CSV 내보내기</button>' +
      '<button type="button" class="btn btn-secondary" id="exportHtmlBtn">견적서 HTML</button>' +
      '</div>';
    html += '</div>';
    el.innerHTML = html;

    Array.prototype.forEach.call(el.querySelectorAll('input[data-price]'), function (inp) {
      inp.addEventListener('change', function () {
        var v = inp.value;
        if (v === '') delete prices[inp.getAttribute('data-price')];
        else prices[inp.getAttribute('data-price')] = Number(v);
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll('input[data-svcprice]'), function (inp) {
      inp.addEventListener('change', function () {
        var v = inp.value;
        if (v === '') delete servicePrices[inp.getAttribute('data-svcprice')];
        else servicePrices[inp.getAttribute('data-svcprice')] = Number(v);
      });
    });
    document.getElementById('savePriceBtn').addEventListener('click', function () {
      if (isServerMode && apiUrl && adminToken && current) {
        var total = 0;
        (current.items || []).forEach(function (it) {
          var unit = prices[it.id];
          if (unit !== undefined && unit !== '' && !isNaN(unit)) total += Number(unit) * (it.qty || 1);
        });
        (current.services || []).forEach(function (sid) {
          var unit = servicePrices[sid];
          if (unit !== undefined && unit !== '' && !isNaN(unit)) total += Number(unit);
        });
        var combined = {};
        Object.keys(prices).forEach(function (k) { combined[k] = prices[k]; });
        Object.keys(servicePrices).forEach(function (k) { combined[k] = servicePrices[k]; });
        var status = (document.getElementById('statusSelect') ? document.getElementById('statusSelect').value : (current.status || 'received'));
        fetch(apiUrl + '/api/quotes/' + encodeURIComponent(current.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
          body: JSON.stringify({ status: status, admin_prices: combined, total: total })
        }).then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
          .then(function (data) {
            current.status = data.status || status;
            current.total = data.total;
            current.admin_prices = JSON.stringify(combined);
            current.updated_at = data.updated_at;
            for (var i = 0; i < requests.length; i++) {
              if (requests[i].id === current.id) { requests[i].status = current.status; requests[i].total = current.total; break; }
            }
            try { localStorage.setItem('cgiQuotePrices', JSON.stringify(prices)); localStorage.setItem('cgiQuoteServicePrices', JSON.stringify(servicePrices)); } catch (e) {}
            alert('단가가 저장되었습니다.');
            renderDetail();
          })
          .catch(function (err) { console.error(err); alert('저장 실패: ' + err.message); });
        return;
      }
      try {
        localStorage.setItem('cgiQuotePrices', JSON.stringify(prices));
        localStorage.setItem('cgiQuoteServicePrices', JSON.stringify(servicePrices));
      } catch (e) {}
      alert('단가가 저장되었습니다.');
      renderDetail();
    });
    document.getElementById('exportCsvBtn').addEventListener('click', function () { exportCsv(); });
    document.getElementById('exportHtmlBtn').addEventListener('click', function () { exportHtml(); });
  }

  function exportCsv() {
    if (!current) return;
    var r = current;
    var lines = [];
    lines.push('견적번호,요청일시,회사,담당자,연락처,이메일,장소,서비스,상품ID,상품명,브랜드,카테고리,수량,단가,금액');
    (r.items || []).forEach(function (it) {
      var unit = prices[it.id];
      var amount = (unit !== undefined && unit !== '' && !isNaN(unit)) ? (Number(unit) * (it.qty || 1)) : '';
      lines.push([r.id,r.createdAt,r.company,r.name,r.phone,r.email,r.location,(r.services||[]).join('|'),it.id,it.name,it.brand,it.category,it.qty||1,(unit!==undefined?unit:''),amount].map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
    });
    (r.services || []).forEach(function (sid) {
      var svc = null;
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) { svc = services[i]; break; }
      var unit = servicePrices[sid];
      var amount = (unit !== undefined && unit !== '' && !isNaN(unit)) ? Number(unit) : '';
      lines.push([r.id,r.createdAt,r.company,r.name,r.phone,r.email,r.location,sid,(svc?svc.name:sid),'서비스','-','1',(unit!==undefined?unit:''),amount].map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = r.id + '_quote.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportHtml() {
    if (!current) return;
    var r = current;
    var html = '<html><head><meta charset="utf-8"><title>견적서 ' + esc(r.id) + '</title></head><body>';
    html += '<h1>CGI 견적서</h1>';
    html += '<p>견적번호: ' + esc(r.id) + ' / 요청일시: ' + esc(r.createdAt) + '</p>';
    html += '<p>회사: ' + esc(r.company) + ' / 담당자: ' + esc(r.name) + ' / 연락처: ' + esc(r.phone) + '</p>';
    html += '<p>장소: ' + esc(r.location) + '</p>';
    html += '<p>서비스: ' + esc((r.services||[]).join(', ')) + '</p>';
    html += '<table border="1" cellpadding="4"><tr><th>품목</th><th>수량</th><th>단가</th><th>금액</th></tr>';
    var total = 0;
    (r.items || []).forEach(function (it) {
      var unit = prices[it.id];
      var amount = (unit !== undefined && unit !== '' && !isNaN(unit)) ? (Number(unit)*(it.qty||1)) : 0;
      if (unit !== undefined && unit !== '' && !isNaN(unit)) total += amount;
      html += '<tr><td>' + esc(it.name) + '</td><td>' + (it.qty||1) + '</td><td>' + (unit!==undefined?unit:'미확정') + '</td><td>' + (unit!==undefined && unit !== '' && !isNaN(unit) ? amount : '미확정') + '</td></tr>';
    });
    (r.services || []).forEach(function (sid) {
      var svc = null;
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) { svc = services[i]; break; }
      var unit = servicePrices[sid];
      var amount = (unit !== undefined && unit !== '' && !isNaN(unit)) ? Number(unit) : 0;
      if (unit !== undefined && unit !== '' && !isNaN(unit)) total += amount;
      html += '<tr><td>' + esc(svc?svc.name:sid) + ' (서비스)</td><td>1</td><td>' + (unit!==undefined?unit:'미확정') + '</td><td>' + (unit!==undefined && unit !== '' && !isNaN(unit) ? amount : '미확정') + '</td></tr>';
    });
    html += '<tr><td colspan="3"><strong>합계(확정분)</strong></td><td><strong>' + total + '</strong></td></tr>';
    html += '</table>';
    html += '<p>요청 사항: ' + esc(r.note) + '</p>';
    html += '</body></html>';
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = r.id + '_quote.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  var importFile = document.getElementById('importFile');
  if (importFile) {
    importFile.addEventListener('change', function () {
      var nameEl = document.getElementById('importFileName');
      if (nameEl) nameEl.textContent = (importFile.files && importFile.files[0]) ? importFile.files[0].name : '선택된 파일 없음';
    });
  }

  document.getElementById('importBtn').addEventListener('click', function () {
    var file = document.getElementById('importFile').files[0];
    if (!file) { alert('JSON 파일을 선택하세요.'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var req = JSON.parse(e.target.result);
        if (!req.id) req.id = 'Q-' + Date.now();
        requests.unshift(req);
        saveRequests();
        renderList();
        alert('가져오기 완료');
      } catch (err) {
        alert('JSON 파싱 실패');
      }
    };
    reader.readAsText(file);
  });

  // load saved prices
  try {
    var p = JSON.parse(localStorage.getItem('cgiQuotePrices') || '{}');
    if (p && typeof p === 'object') prices = p;
    var sp = JSON.parse(localStorage.getItem('cgiQuoteServicePrices') || '{}');
    if (sp && typeof sp === 'object') servicePrices = sp;
  } catch (e) {}

  var apiUrl = (window.CGI_SITE_CONFIG && window.CGI_SITE_CONFIG.quoteApiUrl) || '';
  if (apiUrl) {
    isServerMode = true;
    var token = localStorage.getItem('cgiAdminToken');
    if (!token) {
      token = prompt('관리자 토큰을 입력하세요');
      if (token) localStorage.setItem('cgiAdminToken', token);
    }
    adminToken = token || null;
    if (token) {
      fetch(apiUrl + '/api/quotes', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (data) {
          requests = data.items || [];
          saveRequests();
          renderList();
        })
        .catch(function (err) {
          console.error(err);
          loadRequests();
          renderList();
        });
    } else {
      loadRequests();
      renderList();
    }
  } else {
    loadRequests();
    renderList();
  }
})();
