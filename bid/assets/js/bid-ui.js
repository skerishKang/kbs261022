/* CGI 입찰정보 — 공통 UI 스크립트
   - 데이터 원천: window.CGI_BID_DATA (bid/assets/data/bid-data.js, tools/procurement/build_bid_data.py 또는
     g2b_openapi_collector.py 가 생성)
   - 낙찰 데이터: window.CGI_RESULT_DATA (bid/assets/data/result-data.js, 수집 전에는 null)
   - 연결 주소: window.CGI_BID_CONFIG (bid/config.js)
   - 상태 표시·D-day는 데이터 기준일(snapshot) 대비로 계산한다. 수집이 매일 갱신되면 기준일도 함께 움직인다. */
(function () {
  "use strict";

  var DATA = window.CGI_BID_DATA || { snapshot: "", bids: [] };
  var SNAPSHOT = DATA.snapshot;
  var CFG = window.CGI_BID_CONFIG || {};
  var RESULTS_READY = !!(window.CGI_RESULT_DATA && Array.isArray(window.CGI_RESULT_DATA.results) && window.CGI_RESULT_DATA.results.length);

  /* ── 테마 (시스템 설정 기본, 버튼으로 직접 전환) ── */
  function savedTheme() {
    try { return localStorage.getItem("bid-theme") || ""; } catch (e) { return ""; }
  }
  function applyTheme(t) {
    if (t === "light" || t === "dark") {
      document.documentElement.dataset.theme = t;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }
  applyTheme(savedTheme());
  window.bindThemeToggle = function (btn) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      var cur = document.documentElement.dataset.theme || savedTheme();
      var dark = cur === "dark" || (!cur && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      var next = dark ? "light" : "dark";
      try { localStorage.setItem("bid-theme", next); } catch (e) {}
      applyTheme(next);
      paintThemeBtn(btn, next === "dark");
    });
    paintThemeBtn(btn, (document.documentElement.dataset.theme || savedTheme()) === "dark" ||
      (!savedTheme() && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
  };
  function paintThemeBtn(btn, isDark) {
    btn.textContent = isDark ? "☀" : "☾";
    btn.setAttribute("aria-label", isDark ? "라이트 모드로 전환" : "다크 모드로 전환");
  }

  /* ── 공통 유틸 ── */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function param(name) {
    return new URLSearchParams(location.search).get(name) || "";
  }
  function fmtWon(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("ko-KR") + "원";
  }
  function fmtDate(s) {
    return s ? String(s).slice(0, 10).replace(/-/g, ".") : "—";
  }
  function fmtDt(s) {
    if (!s) return "—";
    var d = String(s).slice(0, 10).replace(/-/g, ".");
    var t = String(s).slice(11, 16);
    return t ? d + " " + t : d;
  }
  var DAY_MS = 86400000;
  var KST_MS = 9 * 3600000;
  function dayIndex(iso, time) {
    var t = new Date(String(iso).replace(" ", "T") + (String(iso).length > 10 ? "" : "T" + (time || "00:00:00")) + "+09:00").getTime();
    // 한국 날짜 기준으로 자른다(UTC로 자르면 오전 9시 이전 마감이 하루 앞당겨진다).
    return isNaN(t) ? null : Math.floor((t + KST_MS) / DAY_MS);
  }
  /* snapshot 기준 D-day.
     - 장기(상시) 접수 공고(lt: 다수공급자계약 등)는 D-day 대신 "상시 접수"로 보여 주고 마감 임박에서 뺀다.
     - 투찰 마감이 원본에 없는 공고(cd 없음)는 개찰일시를 기준으로 상태를 정한다(이전에는 모두 '지난 공고' 취급). */
  function ddState(closeIso, openIso, bid) {
    var baseDay = dayIndex(SNAPSHOT, "13:00:00");
    if (bid && bid.lt) return { label: "상시 접수", cls: "dd-later", over: false, diff: 9999, lt: true };
    if (!closeIso) {
      var oDay = openIso ? dayIndex(openIso) : null;
      if (oDay == null) return { label: "마감일 미공개", cls: "dd-done", over: true, diff: -1 };
      var odiff = oDay - baseDay;
      if (odiff > 0) return { label: "개찰 D-" + odiff, cls: odiff <= 3 ? "dd-soon" : "dd-later", over: false, diff: odiff, noClose: true };
      if (odiff === 0) return { label: "오늘 개찰", cls: "dd-today", over: false, diff: 0, noClose: true };
      return { label: "개찰 완료", cls: "dd-done", over: true, diff: odiff };
    }
    var closeDay = dayIndex(closeIso);
    if (closeDay == null) return { label: "마감일 미공개", cls: "dd-done", over: true, diff: -1 };
    var diff = closeDay - baseDay;
    if (diff > 0) return { label: "D-" + diff, cls: diff <= 3 ? "dd-soon" : "dd-later", over: false, diff: diff };
    if (diff === 0) return { label: "오늘 마감", cls: "dd-today", over: false, diff: 0 };
    if (openIso) {
      var open = dayIndex(openIso);
      if (open != null && open > baseDay) return { label: "마감 · 개찰 대기", cls: "dd-done", over: true, diff: diff };
      return { label: "개찰 완료", cls: "dd-done", over: true, diff: diff };
    }
    return { label: "마감", cls: "dd-done", over: true, diff: diff };
  }
  function ddOf(b) { return ddState(b.cd, b.od, b); }
  function activeBids() {
    return DATA.bids.filter(function (b) { return b.s !== "취소공고"; });
  }
  function byNo(no) {
    return DATA.bids.find(function (b) { return b.no === no; }) || null;
  }
  /* 발주기관별 통계 (수집 데이터 범위) */
  function agencyStats(name) {
    var list = activeBids().filter(function (b) { return b.a === name; });
    var opened = 0, inProgress = 0, sumP = 0, withP = 0;
    list.forEach(function (b) {
      var dd = ddOf(b);
      if (dd.over) opened++; else inProgress++;
      if (b.ep) { sumP += b.ep; withP++; }
    });
    return {
      name: name, total: list.length, opened: opened, inProgress: inProgress,
      avgPrice: withP ? Math.round(sumP / withP) : null, list: list
    };
  }
  /* 지역 보정: r이 없으면 "—" 표시 */
  function regionText(b) { return b.r || "지역 미지정"; }
  /* 경쟁방식 표기 — 수의계약(견적제출)은 경쟁입찰과 구분해 보여 준다 */
  var METHOD_LABELS = { "수의계약": "수의(견적)", "지명경쟁": "지명경쟁" };
  function methodBadge(b) {
    var k = b.k;
    if (!k || k === "-" || !METHOD_LABELS[k]) return "";
    return '<span class="badge badge-method" data-method="' + esc(k) + '" title="' + esc(k) + '">' + esc(METHOD_LABELS[k]) + "</span>";
  }
  function methodList() {
    var seen = {};
    activeBids().forEach(function (b) { if (b.k && b.k !== "-") seen[b.k] = 1; });
    var order = ["일반경쟁", "제한경쟁", "지명경쟁", "수의계약"];
    return order.filter(function (k) { return seen[k]; }).concat(Object.keys(seen).filter(function (k) { return order.indexOf(k) < 0; }));
  }

  /* ── 헤더/푸터 ── */
  var NAV = [
    { href: "index.html", label: "홈", key: "home" },
    { href: "bids.html", label: "입찰공고", key: "bids" },
    { href: "results.html", label: "낙찰 결과", key: "results", soon: !RESULTS_READY },
    { href: "agency.html", label: "발주기관", key: "agency" },
    { href: "pricing.html", label: "요금 안내", key: "pricing" }
  ];
  function renderHeader(active) {
    var host = document.getElementById("appHeader");
    if (!host) return;
    host.innerHTML =
      '<div class="topbar">' +
        '<div class="topbar-inner">' +
          '<a class="brand" href="index.html" aria-label="CGI 입찰정보 홈">' +
            '<span class="brand-mark" aria-hidden="true">C</span>' +
            '<span class="brand-text"><strong>CGI 입찰정보</strong><small>COMPETITIVE BID PORTAL</small></span>' +
          '</a>' +
          '<form class="topbar-search" id="topSearch" role="search">' +
            '<label class="sr-only" for="topSearchInput">공고 검색</label>' +
            '<input type="search" id="topSearchInput" name="q" placeholder="공고명·발주기관·공고번호 검색" value="' + esc(param("q")) + '">' +
            '<button type="submit">검색</button>' +
          '</form>' +
          '<div class="topbar-actions">' +
            '<button type="button" class="icon-btn search-toggle" id="searchToggle" aria-expanded="false" aria-controls="mobileSearch" aria-label="공고 검색 열기">⌕</button>' +
            '<button type="button" class="icon-btn" id="themeToggle"></button>' +
            '<a class="btn btn-ghost btn-sm btn-auth-text" href="pricing.html#signup">로그인</a>' +
            '<a class="btn btn-primary btn-sm" href="pricing.html#signup">회원가입</a>' +
          '</div>' +
        '</div>' +
        '<div class="mobile-search" id="mobileSearch">' +
          '<form role="search">' +
            '<label class="sr-only" for="mobileSearchInput">공고 검색</label>' +
            '<input type="search" id="mobileSearchInput" placeholder="공고명·발주기관·공고번호 검색" value="' + esc(param("q")) + '">' +
            '<button type="submit">검색</button>' +
          '</form>' +
        '</div>' +
        '<nav class="navbar" aria-label="주요 메뉴"><div class="navbar-inner">' +
          NAV.map(function (n) {
            return '<a href="' + n.href + '"' + (n.key === active ? ' class="active" aria-current="page"' : "") + ">" + n.label +
              (n.soon ? ' <span class="nav-soon">준비 중</span>' : "") + "</a>";
          }).join("") +
        "</div></nav>" +
      "</div>";
    var form = document.getElementById("topSearch");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = document.getElementById("topSearchInput").value.trim();
      location.href = "bids.html?q=" + encodeURIComponent(q);
    });
    var panel = document.getElementById("mobileSearch");
    var toggle = document.getElementById("searchToggle");
    toggle.addEventListener("click", function () {
      var open = panel.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "공고 검색 닫기" : "공고 검색 열기");
      if (open) document.getElementById("mobileSearchInput").focus();
    });
    panel.querySelector("form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = document.getElementById("mobileSearchInput").value.trim();
      panel.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
      location.href = "bids.html?q=" + encodeURIComponent(q);
    });
    window.bindThemeToggle(document.getElementById("themeToggle"));
  }

  function renderFooter() {
    var host = document.getElementById("appFooter");
    if (!host) return;
    var source = DATA.source || "나라장터(www.g2b.go.kr) 입찰공고 수집분";
    host.innerHTML =
      '<footer class="footer"><div class="footer-inner">' +
        '<div class="foot-links">' +
          '<a href="pricing.html">요금 안내</a>' +
          '<a href="' + esc(CFG.termsUrl || "../site/terms.html") + '">이용약관</a>' +
          '<a href="' + esc(CFG.privacyUrl || "../site/privacy.html") + '">개인정보처리방침</a>' +
          '<a href="' + esc(CFG.homepageUrl || "../website/index.html") + '">회사 홈페이지</a>' +
          '<a href="' + esc(CFG.mallUrl || "../site/index.html") + '">상품 쇼핑몰</a>' +
        "</div>" +
        '<div class="foot-source">출처: ' + esc(source) + '. 공고 데이터 기준일은 <span class="num">' + esc(SNAPSHOT) + "</span>이며, 기준일 이후 변경된 내용은 나라장터 원문이 우선합니다. 정확한 공고 내용·첨부서류는 나라장터 공고 원문으로 확인하십시오. 기초금액·낙찰하한율·적격심사 세부기준·공고 원문 요약은 회원 전용 항목입니다.</div>" +
        '<div class="foot-copy">© (주)시지아이 · 입찰정보 서비스 문의는 회사 홈페이지 고객센터를 이용하십시오.</div>' +
      "</div></footer>";
  }

  /* ── 하단 시트 (모바일 필터) ── */
  window.bindSheet = function (bar, openBtn, closeBtn) {
    var backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    document.body.appendChild(backdrop);
    function open() { bar.classList.add("sheet-open"); backdrop.classList.add("show"); document.body.style.overflow = "hidden"; }
    function close() { bar.classList.remove("sheet-open"); backdrop.classList.remove("show"); document.body.style.overflow = ""; }
    openBtn && openBtn.addEventListener("click", open);
    closeBtn && closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    return { open: open, close: close };
  };

  /* ── 카드/행 렌더 (공용) ── */
  function badgeCat(c) { return '<span class="badge badge-cat" data-cat="' + esc(c) + '">' + esc(c) + "</span>"; }
  function badgeStatus(s) { return '<span class="badge badge-status" data-re="' + esc(s) + '">' + esc(s) + "</span>"; }
  function chipDd(b) { var d = ddOf(b); return '<span class="chip-dd ' + d.cls + '">' + esc(d.label) + "</span>"; }

  var CAT_ICONS = {
    "구매": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1.6"/><circle cx="19" cy="21" r="1.6"/><path d="M2.5 3h2l2.6 12.4a2 2 0 0 0 2 1.6h9.2a2 2 0 0 0 2-1.6L22 7H6"/></svg>',
    "공사": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 20h20"/><path d="M5 20V9l7-6 7 6v11"/><path d="M9 20v-6h6v6"/></svg>',
    "용역": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4.5 4.5 0 0 0-6.4 6.4l-5.6 5.6L4 21.5l3.2-1.3 5.6-5.6a4.5 4.5 0 0 0 6.4-6.4l-2.9 2.9-2.5-2.5 2.9-2.9z"/></svg>',
    "매각": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.6c0-1.1 1.1-1.9 2.5-1.9s2.5.8 2.5 1.9c0 2.6-5 1.7-5 4.3 0 1.1 1.1 1.9 2.5 1.9s2.5-.8 2.5-1.9"/></svg>'
  };

  function cardHtml(b) {
    var region = b.r ? '<span class="region">' + esc(b.r) + "</span>" : "";
    var dd = ddOf(b);
    var closeLabel = dd.lt ? "상시 접수" : (dd.noClose ? "개찰 " + fmtDt(b.od) : fmtDt(b.cd));
    return (
      '<article class="bid-card">' +
        '<div class="card-badges">' + badgeCat(b.c) + methodBadge(b) + badgeStatus(b.s) + chipDd(b) + "</div>" +
        '<h3 class="bid-card-title"><a href="bid.html?no=' + encodeURIComponent(b.no) + '">' + esc(b.t) + "</a></h3>" +
        '<div class="bid-card-meta"><span class="agency" title="' + esc(b.a) + '">' + esc(b.a) + "</span>" + region + "</div>" +
        '<div class="price-line"><span class="p-k">추정가격</span><span class="p-v num">' + esc(fmtWon(b.ep)) + "</span></div>" +
        '<div class="bid-card-nums">' +
          '<span class="k">' + (dd.noClose ? "개찰일시" : "투찰마감") + '</span><span class="v num">' + esc(closeLabel) + "</span>" +
          '<span class="k">공고번호</span><span class="v num">' + esc(b.no) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  /* 상단 숫자 카드용 집계 (기준일 대비) */
  function statsSummary() {
    var act = activeBids();
    var today = 0, inProgress = 0, weekOpen = 0;
    var base = new Date(SNAPSHOT + "T00:00:00+09:00").getTime();
    act.forEach(function (b) {
      var d = ddOf(b);
      if (d.diff === 0 && !d.noClose) today++;
      if (!d.over) inProgress++;
      if (b.od) {
        var o = new Date(String(b.od).replace(" ", "T") + "+09:00").getTime();
        if (!isNaN(o) && o >= base && o <= base + 7 * DAY_MS) weekOpen++;
      }
    });
    return { total: act.length, today: today, inProgress: inProgress, weekOpen: weekOpen };
  }

  /* 개찰 단계: 기준일 대비 개찰일시로 판정(개찰 결과 데이터와 무관) */
  function openPhase(b) {
    if (!b.od) return "개찰 후 반영";
    var open = dayIndex(b.od);
    var base = dayIndex(SNAPSHOT, "13:00:00");
    if (open == null || base == null) return "개찰 후 반영";
    return open <= base ? "개찰 완료" : "개찰 대기";
  }

  window.BID_UI = {
    DATA: DATA, SNAPSHOT: SNAPSHOT, CFG: CFG, RESULTS_READY: RESULTS_READY,
    esc: esc, param: param, fmtWon: fmtWon, fmtDate: fmtDate, fmtDt: fmtDt,
    ddState: ddState, ddOf: ddOf, activeBids: activeBids, byNo: byNo, openPhase: openPhase,
    agencyStats: agencyStats, regionText: regionText, statsSummary: statsSummary,
    methodBadge: methodBadge, methodList: methodList,
    renderHeader: renderHeader, renderFooter: renderFooter,
    badgeCat: badgeCat, badgeStatus: badgeStatus, chipDd: chipDd,
    cardHtml: cardHtml, bindSheet: window.bindSheet, CAT_ICONS: CAT_ICONS
  };
})();
