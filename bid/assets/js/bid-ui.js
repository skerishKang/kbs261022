/* CGI 입찰정보 — 공통 UI 스크립트
   - 데이터 원천: window.CGI_BID_DATA (bid/assets/data/bid-data.js, scripts/build_data.py 생성)
   - 상태 표시·D-day는 데이터 기준일(snapshot) 대비로 계산한다. 수집이 매일 갱신되면 기준일도 함께 움직인다. */
(function () {
  "use strict";

  var DATA = window.CGI_BID_DATA || { snapshot: "", bids: [] };
  var SNAPSHOT = DATA.snapshot;

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
  /* snapshot 기준 D-day: 마감일이 기준일이면 "오늘 마감", 지났으면 마감/개찰 완료 */
  function ddState(closeIso, openIso) {
    if (!closeIso) return { label: "마감일 미공개", cls: "dd-done", over: true };
    var base = new Date(SNAPSHOT + "T13:00:00+09:00").getTime();
    var close = new Date(closeIso.replace(" ", "T") + "+09:00").getTime();
    if (isNaN(close)) return { label: "마감일 미공개", cls: "dd-done", over: true };
    var dayMs = 86400000;
    var baseDay = Math.floor(base / dayMs);
    var closeDay = Math.floor(close / dayMs);
    var diff = closeDay - baseDay;
    if (diff > 0) return { label: "D-" + diff, cls: diff <= 3 ? "dd-soon" : "dd-later", over: false, diff: diff };
    if (diff === 0) return { label: "오늘 마감", cls: "dd-today", over: false, diff: 0 };
    if (openIso) {
      var open = new Date(openIso.replace(" ", "T") + "+09:00").getTime();
      if (!isNaN(open) && Math.floor(open / dayMs) > baseDay) return { label: "마감 · 개찰 대기", cls: "dd-done", over: true };
      return { label: "개찰 완료", cls: "dd-done", over: true };
    }
    return { label: "마감", cls: "dd-done", over: true };
  }
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
      var dd = ddState(b.cd, b.od);
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

  /* ── 헤더/푸터 ── */
  var NAV = [
    { href: "index.html", label: "홈", key: "home" },
    { href: "bids.html", label: "입찰공고", key: "bids" },
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
            '<button type="button" class="icon-btn" id="themeToggle"></button>' +
            '<a class="btn btn-ghost btn-sm btn-auth-text" href="pricing.html">로그인</a>' +
            '<a class="btn btn-primary btn-sm" href="pricing.html">회원가입</a>' +
          '</div>' +
        '</div>' +
        '<nav class="navbar" aria-label="주요 메뉴"><div class="navbar-inner">' +
          NAV.map(function (n) {
            return '<a href="' + n.href + '"' + (n.key === active ? ' class="active" aria-current="page"' : "") + ">" + n.label + "</a>";
          }).join("") +
        "</div></nav>" +
      "</div>";
    var form = document.getElementById("topSearch");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var q = document.getElementById("topSearchInput").value.trim();
      location.href = "bids.html?q=" + encodeURIComponent(q);
    });
    window.bindThemeToggle(document.getElementById("themeToggle"));
  }

  function renderFooter() {
    var host = document.getElementById("appFooter");
    if (!host) return;
    host.innerHTML =
      '<footer class="footer"><div class="footer-inner">' +
        '<div class="foot-links">' +
          '<a href="pricing.html">요금 안내</a>' +
          '<a href="../site/terms.html">이용약관</a>' +
          '<a href="../site/privacy.html">개인정보처리방침</a>' +
          '<a href="../website/index.html">회사 홈페이지</a>' +
        "</div>" +
        '<div class="foot-source">본 사이트의 공고 정보는 나라장터(www.g2b.go.kr)에 게시된 입찰공고를 수집·정리한 것으로, 공고 데이터 기준일은 <span class="num">' + esc(SNAPSHOT) + "</span>입니다. 정확한 공고 내용·첨부서류는 나라장터 공고 원문으로 확인하십시오. 기초금액·낙찰하한율·적격심사 세부기준·공고 원문 요약은 회원 전용 항목입니다.</div>" +
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
  function chipDd(b) { var d = ddState(b.cd, b.od); return '<span class="chip-dd ' + d.cls + '">' + esc(d.label) + "</span>"; }

  function cardHtml(b) {
    return (
      '<article class="bid-card">' +
        '<div class="card-badges">' + badgeCat(b.c) + badgeStatus(b.s) + chipDd(b) + "</div>" +
        '<h3 class="bid-card-title"><a href="bid.html?no=' + encodeURIComponent(b.no) + '">' + esc(b.t) + "</a></h3>" +
        '<div class="bid-card-meta"><span class="agency">' + esc(b.a) + "</span><span>" + esc(regionText(b)) + "</span></div>" +
        '<div class="bid-card-nums">' +
          '<span class="k">추정가격</span><span class="v price num">' + esc(fmtWon(b.ep)) + "</span>" +
          '<span class="k">투찰마감</span><span class="v num">' + esc(fmtDt(b.cd)) + "</span>" +
          '<span class="k">공고번호</span><span class="v num">' + esc(b.no) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  window.BID_UI = {
    DATA: DATA, SNAPSHOT: SNAPSHOT,
    esc: esc, param: param, fmtWon: fmtWon, fmtDate: fmtDate, fmtDt: fmtDt,
    ddState: ddState, activeBids: activeBids, byNo: byNo,
    agencyStats: agencyStats, regionText: regionText,
    renderHeader: renderHeader, renderFooter: renderFooter,
    badgeCat: badgeCat, badgeStatus: badgeStatus, chipDd: chipDd,
    cardHtml: cardHtml, bindSheet: window.bindSheet
  };
})();
