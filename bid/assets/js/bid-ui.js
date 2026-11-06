/* CGI 입찰정보 — 공통 UI 스크립트
   - 데이터 원천: window.CGI_BID_DATA (bid/assets/data/bid-data.js, tools/procurement/build_bid_data.py 또는
     g2b_openapi_collector.py 가 생성)
   - 낙찰 데이터: window.CGI_RESULT_DATA (bid/assets/data/result-data.js, 수집 전에는 null)
   - 연결 주소: window.CGI_BID_CONFIG (bid/config.js)
   - 상태 표시·D-day는 **실제 지금(한국 시간)** 대비로 계산한다. snapshot은 "수집일" 표시와
     시범 데이터 판정에만 쓴다(수집일이 오늘보다 2일 이상 지나면 시범 데이터).
   - 시험에서 기준 시각을 고정할 때는 window.CGI_BID_NOW(ISO 문자열 또는 epoch ms)를 준다. */
(function () {
  "use strict";

  var DATA = window.CGI_BID_DATA || { snapshot: "", bids: [] };
  var SNAPSHOT = DATA.snapshot;
  var CFG = window.CGI_BID_CONFIG || {};
  var RESULTS_READY = !!(window.CGI_RESULT_DATA && Array.isArray(window.CGI_RESULT_DATA.results) && window.CGI_RESULT_DATA.results.length);

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
  /* 기준 시각 = 실제 지금. window.CGI_BID_NOW 로 고정할 수 있다(시험·검증용). */
  var NOW_FIXED = (function () {
    var v = window.CGI_BID_NOW;
    if (v == null || v === "") return null;
    var ms = typeof v === "number" ? v : Date.parse(String(v));
    return isNaN(ms) ? null : ms;
  })();
  function nowMs() { return NOW_FIXED != null ? NOW_FIXED : Date.now(); }
  function nowDay() { return Math.floor((nowMs() + KST_MS) / DAY_MS); }
  function kstToday() { return new Date(nowMs() + KST_MS).toISOString().slice(0, 10); }
  /* 수집일 나이 → 시범 데이터 여부. 수집일이 오늘보다 2일 이상 전이면 시범 데이터로 본다. */
  var SNAPSHOT_DAY = SNAPSHOT ? dayIndex(SNAPSHOT) : null;
  var TRIAL_AFTER_DAYS = 2;
  function dataAgeDays() { return SNAPSHOT_DAY == null ? 0 : nowDay() - SNAPSHOT_DAY; }
  function isTrialData() { return dataAgeDays() >= TRIAL_AFTER_DAYS; }

  /* 실제 기준 D-day.
     - 장기(상시) 접수 공고(lt: 다수공급자계약 등)는 D-day 대신 "상시 접수"로 보여 주고 마감 임박에서 뺀다.
     - 투찰 마감이 원본에 없는 공고(cd 없음)는 개찰일시를 기준으로 상태를 정한다(이전에는 모두 '지난 공고' 취급). */
  function ddState(closeIso, openIso, bid) {
    var baseDay = nowDay();
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
    { href: "watchlist.html", label: "관심공고", key: "watch" },
    { href: "agency.html", label: "발주기관", key: "agency" },
    { href: "pricing.html", label: "요금 안내", key: "pricing" }
  ];
  /* 시범 데이터 띠 — 수집일이 오늘보다 2일 이상 전이면 모든 화면 상단에 붙인다 */
  function trialBarHtml() {
    if (!isTrialData()) return "";
    return '<div class="trial-bar" id="trialBar" role="status"><strong>시범 데이터</strong> — ' +
      esc(SNAPSHOT) + " 수집분입니다. 마감 여부는 나라장터 원문으로 확인하십시오.</div>";
  }
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
            '<label class="sr-only" for="topSearchInput">공고 통합검색</label>' +
            '<input type="search" id="topSearchInput" name="q" placeholder="공고명·발주기관·공고번호 통합검색" value="' + esc(param("q")) + '">' +
            '<button type="submit">검색</button>' +
          '</form>' +
          '<div class="topbar-actions">' +
            '<button type="button" class="icon-btn search-toggle" id="searchToggle" aria-expanded="false" aria-controls="mobileSearch" aria-label="공고 검색 열기">⌕</button>' +
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
      "</div>" + trialBarHtml();
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

  /* CGI 취급 품목 매칭 키워드 칩 (7차 — build_bid_data.py가 공고마다 cgi_match·mk를 만든다) */
  function mkChips(b, max) {
    var lim = max || 4;
    if (!b.cgi_match || !Array.isArray(b.mk) || !b.mk.length) return "";
    var shown = b.mk.slice(0, lim);
    var rest = b.mk.length - shown.length;
    return '<span class="mk-chips" aria-label="CGI 취급 품목 키워드">' +
      shown.map(function (k) { return '<span class="mk-chip">' + esc(k) + "</span>"; }).join("") +
      (rest > 0 ? '<span class="mk-chip mk-more">+' + rest + "</span>" : "") +
      "</span>";
  }

  function cardHtml(b) {
    var region = b.r ? '<span class="region">' + esc(b.r) + "</span>" : "";
    var dd = ddOf(b);
    var closeLabel = dd.lt ? "상시 접수" : (dd.noClose ? "개찰 " + fmtDt(b.od) : fmtDt(b.cd));
    var pers = window.BID_PERS;
    return (
      '<article class="bid-card">' +
        '<div class="card-badges">' + badgeCat(b.c) + methodBadge(b) + badgeStatus(b.s) + chipDd(b) +
          (pers ? '<span class="card-star">' + pers.starBtnHtml(b.no) + "</span>" : "") +
        "</div>" +
        '<h3 class="bid-card-title"><a href="bid.html?no=' + encodeURIComponent(b.no) + '">' + esc(b.t) + "</a></h3>" +
        '<div class="bid-card-meta"><span class="agency" title="' + esc(b.a) + '">' + esc(b.a) + "</span>" + region + "</div>" +
        mkChips(b) +
        '<div class="price-line"><span class="p-k">추정가격</span><span class="p-v num">' + esc(fmtWon(b.ep)) + "</span></div>" +
        '<div class="bid-card-nums">' +
          '<span class="k">' + (dd.noClose ? "개찰일시" : "투찰마감") + '</span><span class="v num">' + esc(closeLabel) + "</span>" +
          '<span class="k">공고번호</span><span class="v num">' + esc(b.no) + "</span>" +
        "</div>" +
      "</article>"
    );
  }

  /* 상단 숫자 카드용 집계 (실제 오늘 기준) */
  function statsSummary() {
    var act = activeBids();
    var today = 0, inProgress = 0, weekOpen = 0;
    var base = nowDay() * DAY_MS - KST_MS; // 한국 시간 오늘 0시
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

  /* 개찰 단계: 실제 오늘 대비 개찰일시로 판정(개찰 결과 데이터와 무관) */
  function openPhase(b) {
    if (!b.od) return "개찰 후 반영";
    var open = dayIndex(b.od);
    var base = nowDay();
    if (open == null || base == null) return "개찰 후 반영";
    return open <= base ? "개찰 완료" : "개찰 대기";
  }

  /* ── 사정율 통계 패널 (8차) ──
     collected:false면 숫자를 하나도 내보내지 않는다(가짜 수치 금지 — 실데이터가 모인 뒤에만 표시). */
  function rateStatsPanel(hasData, bundle) {
    if (!hasData || !bundle) {
      var msg = hasData
        ? "표본 부족 — 이 공고가 속한 묶음의 개찰 표본이 부족해 통계를 내지 않았습니다"
        : "낙찰 데이터 수집 전 — 공개 개찰결과로 산출 예정";
      return '<div class="empty-state rate-empty"><strong>사정율 통계</strong>' + esc(msg) +
        '. 수치는 실데이터가 충분히 모인 뒤에만 표시합니다.</div>';
    }
    var hist = Array.isArray(bundle.histogram) ? bundle.histogram : [];
    var maxCount = hist.reduce(function (a, h) { return Math.max(a, h.count); }, 0) || 1;
    var lo = hist.length ? hist[0].bucket_low : 99;
    var hi = hist.length ? hist[hist.length - 1].bucket_high : 101;
    var span = Math.max(hi - lo, 0.2);
    function bx(v) { return ((v - lo) / span) * 100; }
    var bars = hist.map(function (h) {
      var x = bx(h.bucket_low), w = bx(h.bucket_high) - x;
      var hgt = Math.round((h.count / maxCount) * 100);
      return '<rect x="' + x.toFixed(2) + '%" y="' + (100 - hgt) + '" width="' + w.toFixed(2) + '%" height="' + hgt + '" class="rs-bar"><title>' +
        esc(h.bucket_low) + "~" + esc(h.bucket_high) + "% : " + esc(h.count) + "건</title></rect>";
    }).join("");
    var axis = hist.filter(function (_, i) { return i % Math.ceil(hist.length / 6) === 0; }).map(function (h) {
      return '<span style="left:' + bx(h.bucket_low).toFixed(2) + '%">' + esc(h.bucket_low) + "</span>";
    }).join("");
    return (
      '<div class="rs-wrap">' +
        '<div class="rs-kv"><span class="k">사용한 묶음</span><span class="v">' + esc(bundle.bundle) + "</span></div>" +
        '<div class="rs-nums">' +
          '<span>평균 <strong class="num">' + esc(bundle.mean) + "%</strong></span>" +
          "<span>중앙값 <strong class=\"num\">" + esc(bundle.median) + "%</strong></span>" +
          "<span>표준편차 <strong class=\"num\">" + esc(bundle.stdev) + "%p</strong></span>" +
          '<span>표본 <strong class="num">' + esc(bundle.n) + "건</strong></span>" +
          '<span>기간 <strong class="num">' + esc(bundle.first_open) + " ~ " + esc(bundle.last_open) + "</strong></span>" +
        "</div>" +
        '<svg class="rs-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="사정율 분포 히스토그램">' +
          bars +
        "</svg>" +
        '<div class="rs-axis num">' + axis + "</div>" +
        '<div class="rs-note">사정률 = 예정가격 ÷ 기초금액 × 100 · 표본 n이 ' + "30건 이상인 묶음만 계산합니다.</div>" +
      "</div>"
    );
  }

  /* 업무형 목록 행 (10차 — 메인 3표는 mini, 목록 표는 전체 열)
     목록 행은 2줄 고정: 1줄 제목+키워드 칩, 2줄 발주기관+공고번호.
     칩을 2개로 줄이고 제목 줄 안에서 잘라 행 높이가 늘지 않게 한다. */
  function bizRowHtml(b, seq, mini) {
    var dd = ddOf(b);
    var chips = (window.BID_PERS && b.cgi_match ? mkChips(b, mini ? 3 : 2) : "");
    if (mini) {
      return "<tr>" +
        '<td class="t-title"><a href="bid.html?no=' + encodeURIComponent(b.no) + '">' + esc(b.t) + "</a>" +
          '<span class="t-sub">' + esc(b.a) + ' <span class="num">' + esc(b.no) + "</span>" + chips + "</span>" +
        "</td>" +
        '<td class="t-right num">' + esc(fmtWon(b.ep)) + "</td>" +
        '<td style="text-align:right">' + chipDd(b) + "</td>" +
        "</tr>";
    }
    return "<tr>" +
      '<td class="t-no num">' + (seq != null ? seq : "—") + "</td>" +
      '<td class="t-cat">' + badgeCat(b.c) + (b.k && b.k !== "-" ? methodBadge(b) : "") + "</td>" +
      '<td class="t-title">' +
        '<span class="t-main"><a href="bid.html?no=' + encodeURIComponent(b.no) + '">' + esc(b.t) + "</a>" + chips + "</span>" +
        '<span class="t-sub">' + esc(b.a) + ' <span class="num">' + esc(b.no) + "</span></span>" +
      "</td>" +
      '<td class="t-right num">' + esc(fmtWon(b.ep)) + "</td>" +
      '<td class="t-region">' + esc(b.r || "—") + "</td>" +
      '<td class="t-right num">' + esc(fmtDate(b.pd)) + "</td>" +
      '<td class="t-right num">' + (dd.lt ? "상시 접수" : (b.cd ? esc(fmtDt(b.cd)) : "—")) + "</td>" +
      '<td class="t-right num">' + esc(fmtDt(b.od)) + "</td>" +
      '<td style="text-align:right">' + chipDd(b) + "</td>" +
      (window.BID_PERS ? '<td class="t-star">' + window.BID_PERS.starBtnHtml(b.no) + "</td>" : "") +
      "</tr>";
  }

  window.BID_UI = {
    DATA: DATA, SNAPSHOT: SNAPSHOT, CFG: CFG, RESULTS_READY: RESULTS_READY,
    esc: esc, param: param, fmtWon: fmtWon, fmtDate: fmtDate, fmtDt: fmtDt,
    nowMs: nowMs, kstToday: kstToday, dataAgeDays: dataAgeDays, isTrialData: isTrialData,
    TRIAL_AFTER_DAYS: TRIAL_AFTER_DAYS, trialBarHtml: trialBarHtml,
    ddState: ddState, ddOf: ddOf, activeBids: activeBids, byNo: byNo, openPhase: openPhase,
    agencyStats: agencyStats, regionText: regionText, statsSummary: statsSummary,
    methodBadge: methodBadge, methodList: methodList, mkChips: mkChips, rateStatsPanel: rateStatsPanel,
    bizRowHtml: bizRowHtml,
    renderHeader: renderHeader, renderFooter: renderFooter,
    badgeCat: badgeCat, badgeStatus: badgeStatus, chipDd: chipDd,
    cardHtml: cardHtml, bindSheet: window.bindSheet, CAT_ICONS: CAT_ICONS
  };
})();
