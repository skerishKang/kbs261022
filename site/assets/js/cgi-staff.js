(function () {
  'use strict';
  var products = window.CGI_PRODUCTS || [];
  var services = window.CGI_SERVICES || [];
  var requests = [];
  var current = null;
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

  function renderList() {
    var el = document.getElementById('requestList');
    if (!requests.length) {
      el.innerHTML = '<p class="empty-state">접수된 견적 요청이 없습니다.</p>';
      return;
    }
    var html = '<table class="spec-table"><thead><tr><th>요청번호</th><th>일시</th><th>회사</th><th>담당자</th><th>상품수</th><th></th></tr></thead><tbody>';
    requests.forEach(function (r) {
      html += '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.createdAt) + '</td><td>' + esc(r.company) + '</td><td>' + esc(r.name) + '</td><td>' + (r.items ? r.items.length : 0) + '</td><td><button class="btn-search" data-open="' + esc(r.id) + '">열기</button></td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('button[data-open]'), function (btn) {
      btn.addEventListener('click', function () {
        openRequest(btn.getAttribute('data-open'));
      });
    });
  }

  function openRequest(id) {
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
    var html = '<div class="detail-block"><h3>견적 요청 상세: ' + esc(r.id) + '</h3>';
    html += '<p>회사: ' + esc(r.company) + ' / 담당자: ' + esc(r.name) + ' / 연락처: ' + esc(r.phone) + ' / 이메일: ' + esc(r.email) + '</p>';
    html += '<p>장소: ' + esc(r.location) + '</p>';
    html += '<p>요청 사항: ' + esc(r.note) + '</p>';
    html += '<p>서비스: ' + esc((r.services || []).join(', ')) + '</p>';
    html += '<table class="spec-table"><thead><tr><th>상품</th><th>브랜드</th><th>카테고리</th><th>수량</th><th>단가(입력)</th><th>금액</th></tr></thead><tbody>';
    var total = 0;
    (r.items || []).forEach(function (it) {
      var p = findProduct(it.id);
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
        '<td><input type="number" min="0" step="1" data-price="' + esc(it.id) + '" value="' + esc(unit) + '" style="width:100px"></td>' +
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
        '<td><input type="number" min="0" step="1" data-svcprice="' + esc(sid) + '" value="' + esc(unit) + '" style="width:100px"></td>' +
        '<td>' + (unit !== '' && !isNaN(unit) ? amount.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    html += '<p><strong>합계(확정분): ' + total.toLocaleString('ko-KR') + '</strong> (미확정 항목 제외)</p>';
    html += '<div style="margin-top:10px">' +
      '<button class="btn-search" id="exportCsvBtn">견적서 CSV 내보내기</button> ' +
      '<button class="btn-search" id="exportHtmlBtn">견적서 HTML 내보내기</button> ' +
      '<button class="btn-search" id="exportXlsxBtn">견적서 XLSX 내보내기</button> ' +
      '<button class="btn-search" id="exportPdfBtn">견적서 PDF 내보내기</button> ' +
      '<button class="btn-search" id="savePriceBtn">단가 저장</button>' +
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
      try {
        localStorage.setItem('cgiQuotePrices', JSON.stringify(prices));
        localStorage.setItem('cgiQuoteServicePrices', JSON.stringify(servicePrices));
      } catch (e) {}
      alert('단가가 저장되었습니다.');
      renderDetail();
    });
    document.getElementById('exportCsvBtn').addEventListener('click', function () { exportCsv(); });
    document.getElementById('exportHtmlBtn').addEventListener('click', function () { exportHtml(); });
    document.getElementById('exportXlsxBtn').addEventListener('click', function () { exportXlsx(); });
    document.getElementById('exportPdfBtn').addEventListener('click', function () { exportPdf(); });
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


  function fmtNum(v) {
    if (v === '' || v === null || v === undefined || isNaN(v)) return '미확정';
    return Number(v);
  }

  function buildQuoteRows() {
    var r = current;
    var rows = [];
    var items = r.items || [];
    var svcs = r.services || [];
    // company info header
    rows.push(['CGI 견적서']);
    rows.push(['견적번호', r.id]);
    rows.push(['요청일시', r.createdAt]);
    rows.push(['회사', r.company]);
    rows.push(['담당자', r.name]);
    rows.push(['연락처', r.phone]);
    rows.push(['이메일', r.email || '']);
    rows.push(['장소', r.location || '']);
    rows.push(['서비스 항목', (svcs || []).join(', ')]);
    rows.push(['요청 사항', r.note || '']);
    rows.push([]);
    rows.push(['공급자', '주식회사 시지아이 (CGI Inc.)']);
    rows.push(['주소', '광주광역시 광산구 하남산단천변좌로 19, 광주드림파크 111호 (오선동)']);
    rows.push(['연락처', 'TEL 062) 576-8100  FAX 062) 576-8181']);
    rows.push(['블로그', 'blog.naver.com/cgiinc']);
    rows.push([]);
    rows.push(['견적번호','구분','상품명','모델','수량','단가','공급가액','부가세','합계']);
    var totalSupply = 0, totalVat = 0, totalAll = 0;
    var unconfirmed = 0;
    items.forEach(function (it) {
      var p = findProduct(it.id);
      var model = p ? (p.model || '') : '';
      var unit = prices[it.id];
      var qty = it.qty || 1;
      var has = (unit !== undefined && unit !== '' && !isNaN(unit));
      var supply = has ? (Number(unit) * qty) : '';
      var vat = has ? Math.round(supply * 0.1) : '';
      var tot = has ? (supply + vat) : '';
      if (has) { totalSupply += supply; totalVat += vat; totalAll += tot; }
      else unconfirmed++;
      rows.push([
        r.id,
        '상품',
        it.name,
        model,
        qty,
        has ? Number(unit) : '미확정',
        has ? supply : '미확정',
        has ? vat : '미확정',
        has ? tot : '미확정'
      ]);
    });
    svcs.forEach(function (sid) {
      var svc = null;
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) { svc = services[i]; break; }
      var name = svc ? svc.name : sid;
      var unit = servicePrices[sid];
      var has = (unit !== undefined && unit !== '' && !isNaN(unit));
      var supply = has ? Number(unit) : '';
      var vat = has ? Math.round(supply * 0.1) : '';
      var tot = has ? (supply + vat) : '';
      if (has) { totalSupply += supply; totalVat += vat; totalAll += tot; }
      else unconfirmed++;
      rows.push([
        r.id,
        '서비스',
        name + ' (서비스)',
        '',
        1,
        has ? Number(unit) : '미확정',
        has ? supply : '미확정',
        has ? vat : '미확정',
        has ? tot : '미확정'
      ]);
    });
    rows.push(['','','','','','','','','']);
    rows.push(['합계(확정분)','','','','', '', totalSupply, totalVat, totalAll]);
    rows.push(['미확정 항목', unconfirmed + '건 (0원으로 확정하지 않음)']);
    rows._totals = {supply: totalSupply, vat: totalVat, total: totalAll, unconfirmed: unconfirmed};
    return rows;
  }

  function exportXlsx() {
    if (!current) return;
    if (typeof XLSX === 'undefined') { alert('XLSX 라이브러리를 불러오지 못했습니다.'); return; }
    var r = current;
    var aoa = buildQuoteRows();
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    // column widths
    ws['!cols'] = [{wch:14},{wch:8},{wch:34},{wch:24},{wch:6},{wch:12},{wch:14},{wch:12},{wch:14}];
    // number formats for currency columns (F,G,H,I) rows after header
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '견적서');
    XLSX.writeFile(wb, r.id + '_quote.xlsx');
  }

  function exportPdf() {
    if (!current) return;
    if (typeof html2pdf === 'undefined') { alert('PDF 라이브러리를 불러오지 못했습니다.'); return; }
    var r = current;
    var totals = null;
    var rows = buildQuoteRows();
    // find totals from last
    // build html
    var items = r.items || [];
    var svcs = r.services || [];
    var totalSupply = 0, totalVat = 0, totalAll = 0, unconfirmed = 0;
    var trs = '';
    items.forEach(function (it) {
      var p = findProduct(it.id);
      var model = p ? (p.model || '') : '';
      var unit = prices[it.id];
      var qty = it.qty || 1;
      var has = (unit !== undefined && unit !== '' && !isNaN(unit));
      var supply = has ? (Number(unit) * qty) : null;
      var vat = has ? Math.round(supply * 0.1) : null;
      var tot = has ? (supply + vat) : null;
      if (has) { totalSupply += supply; totalVat += vat; totalAll += tot; } else unconfirmed++;
      trs += '<tr>' +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(model) + '</td>' +
        '<td style="text-align:center">' + qty + '</td>' +
        '<td style="text-align:right">' + (has ? Number(unit).toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? supply.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? vat.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? tot.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '</tr>';
    });
    svcs.forEach(function (sid) {
      var svc = null;
      for (var i = 0; i < services.length; i++) if (services[i].id === sid) { svc = services[i]; break; }
      var name = svc ? svc.name : sid;
      var unit = servicePrices[sid];
      var has = (unit !== undefined && unit !== '' && !isNaN(unit));
      var supply = has ? Number(unit) : null;
      var vat = has ? Math.round(supply * 0.1) : null;
      var tot = has ? (supply + vat) : null;
      if (has) { totalSupply += supply; totalVat += vat; totalAll += tot; } else unconfirmed++;
      trs += '<tr>' +
        '<td>' + esc(name) + ' (서비스)</td>' +
        '<td></td>' +
        '<td style="text-align:center">1</td>' +
        '<td style="text-align:right">' + (has ? Number(unit).toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? supply.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? vat.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '<td style="text-align:right">' + (has ? tot.toLocaleString('ko-KR') : '미확정') + '</td>' +
        '</tr>';
    });
    var html = '' +
      '<div style="font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif;font-size:11px;color:#111;padding:16px;width:794px;">' +
      '<h1 style="font-size:18px;margin:0 0 4px;">CGI 견적서</h1>' +
      '<p style="margin:2px 0;">견적번호: ' + esc(r.id) + ' &nbsp; 요청일시: ' + esc(r.createdAt) + '</p>' +
      '<p style="margin:2px 0;">회사: ' + esc(r.company) + ' &nbsp; 담당자: ' + esc(r.name) + ' &nbsp; 연락처: ' + esc(r.phone) + ' &nbsp; 이메일: ' + esc(r.email || '') + '</p>' +
      '<p style="margin:2px 0;">장소: ' + esc(r.location || '') + '</p>' +
      '<p style="margin:2px 0;">서비스 항목: ' + esc((svcs || []).join(', ')) + '</p>' +
      '<p style="margin:2px 0;">요청 사항: ' + esc(r.note || '') + '</p>' +
      '<hr style="margin:8px 0;">' +
      '<p style="margin:2px 0;font-weight:bold;">공급자: 주식회사 시지아이 (CGI Inc.)</p>' +
      '<p style="margin:2px 0;">주소: 광주광역시 광산구 하남산단천변좌로 19, 광주드림파크 111호 (오선동)</p>' +
      '<p style="margin:2px 0;">연락처: TEL 062) 576-8100 &nbsp; FAX 062) 576-8181 &nbsp; blog.naver.com/cgiinc</p>' +
      '<table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:10px;" border="1">' +
      '<thead><tr style="background:#eee;">' +
      '<th style="padding:4px;">품목</th><th style="padding:4px;">모델</th><th style="padding:4px;">수량</th><th style="padding:4px;">단가</th><th style="padding:4px;">공급가액</th><th style="padding:4px;">부가세</th><th style="padding:4px;">합계</th>' +
      '</tr></thead><tbody>' + trs +
      '<tr style="font-weight:bold;background:#f5f5f5;">' +
      '<td colspan="4" style="padding:4px;text-align:right;">합계(확정분)</td>' +
      '<td style="padding:4px;text-align:right;">' + totalSupply.toLocaleString('ko-KR') + '</td>' +
      '<td style="padding:4px;text-align:right;">' + totalVat.toLocaleString('ko-KR') + '</td>' +
      '<td style="padding:4px;text-align:right;">' + totalAll.toLocaleString('ko-KR') + '</td>' +
      '</tr>' +
      '</tbody></table>' +
      '<p style="margin-top:8px;font-size:10px;">미확정 항목: ' + unconfirmed + '건 (0원으로 임의 확정하지 않음)</p>' +
      '<p style="margin-top:8px;font-size:9px;color:#555;">본 견적서는 CGI 견적 관리 화면에서 생성되었습니다. 미확정 항목은 0원으로 확정하지 않습니다.</p>' +
      '</div>';
    var container = document.createElement('div');
    container.innerHTML = html;
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '0';
    document.body.appendChild(container);
    var opt = {
      margin: 8,
      filename: r.id + '_quote.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] }
    };
    html2pdf().set(opt).from(container.firstChild).save().then(function () {
      document.body.removeChild(container);
    }).catch(function (e) {
      console.error(e);
      if (container.parentNode) document.body.removeChild(container);
      alert('PDF 생성 실패: ' + e);
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
    var token = localStorage.getItem('cgiAdminToken');
    if (!token) {
      token = prompt('관리자 토큰을 입력하세요');
      if (token) localStorage.setItem('cgiAdminToken', token);
    }
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
