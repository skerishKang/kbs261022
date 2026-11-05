/* CGI 입찰정보 — 개인화 모듈 (이슈 #188 7차)
   - 맞춤 조건 저장(최대 10개) / 제외 발주처 / 관심공고(상태·메모) / CSV 내보내기 / 캘린더 날짜 계산
   - 서버 저장 없음: 브라우저 localStorage만 사용한다(기기 단위). 로그인과 무관하게 동작한다.
   - 이 파일은 순수 함수 위주로 짜서 node --test(bid/test)에서 vm 컨텍스트로 검증한다. */
(function () {
  "use strict";

  var KEYS = {
    filters: "bid-filters-v1",
    exclude: "bid-exclude-agencies-v1",
    stars: "bid-stars-v1"
  };
  var MAX_FILTERS = 10;
  var STAR_STATES = ["검토중", "투찰예정", "투찰완료", "포기"];
  var MEMO_MAX = 200;

  /* ── localStorage 안전 래퍼 ── */
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* ── 맞춤 조건 (이름 붙여 저장/불러오기/삭제, 최대 10개) ── */
  function listFilters() {
    var v = load(KEYS.filters, []);
    return Array.isArray(v) ? v : [];
  }
  /* cond는 bids.html의 필터 상태 객체(cat/q/region/agency/price/period/status/method/sort/view) 그대로 저장 */
  function saveFilter(name, cond) {
    var n = String(name || "").trim();
    if (!n || n.length > 40) return { ok: false, reason: "이름" };
    var list = listFilters();
    if (list.some(function (f) { return f.name === n; })) return { ok: false, reason: "중복" };
    if (list.length >= MAX_FILTERS) return { ok: false, reason: "최대" };
    list.push({ name: n, cond: cond || {}, at: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) });
    return { ok: save(KEYS.filters, list) };
  }
  function getFilter(name) {
    var f = listFilters().find(function (x) { return x.name === name; });
    return f ? f.cond : null;
  }
  function deleteFilter(name) {
    var list = listFilters().filter(function (x) { return x.name !== name; });
    return save(KEYS.filters, list);
  }

  /* ── 제외 발주처 (발주기관명 부분일치) ── */
  function getExcludes() {
    var v = load(KEYS.exclude, []);
    return Array.isArray(v) ? v : [];
  }
  function addExclude(term) {
    var t = String(term || "").trim();
    if (!t || t.length > 60) return false;
    var list = getExcludes();
    if (list.indexOf(t) >= 0) return true; // 이미 있으면 성공 취급
    list.push(t);
    return save(KEYS.exclude, list);
  }
  function removeExclude(term) {
    var list = getExcludes().filter(function (x) { return x !== term; });
    return save(KEYS.exclude, list);
  }
  function isExcluded(agencyName, excludes) {
    var ex = excludes || getExcludes();
    var a = String(agencyName || "");
    for (var i = 0; i < ex.length; i++) {
      if (a.indexOf(ex[i]) >= 0) return true;
    }
    return false;
  }
  /* 필터링된 뒤 목록에서 제외된 건수를 세서 화면에 표시한다 */
  function countExcluded(bids) {
    var ex = getExcludes();
    if (!ex.length) return 0;
    return bids.filter(function (b) { return isExcluded(b.a, ex); }).length;
  }
  function applyExcludes(bids) {
    var ex = getExcludes();
    if (!ex.length) return bids;
    return bids.filter(function (b) { return !isExcluded(b.a, ex); });
  }

  /* ── 관심공고 (별표 + 상태 4종 + 메모 200자) ── */
  function getStars() {
    var v = load(KEYS.stars, {});
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  function isStarred(no) {
    return !!getStars()[String(no)];
  }
  function getStar(no) {
    return getStars()[String(no)] || null;
  }
  function starCount() {
    return Object.keys(getStars()).length;
  }
  function setStar(no, patch) {
    var k = String(no);
    if (!k) return false;
    var stars = getStars();
    var cur = stars[k] || { state: STAR_STATES[0], memo: "", at: "" };
    var next = {
      state: patch && STAR_STATES.indexOf(patch.state) >= 0 ? patch.state : cur.state,
      memo: String(patch && patch.memo != null ? patch.memo : cur.memo).slice(0, MEMO_MAX),
      at: cur.at || new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
    };
    stars[k] = next;
    return save(KEYS.stars, stars);
  }
  function toggleStar(no) {
    var k = String(no);
    var stars = getStars();
    if (stars[k]) { delete stars[k]; return { starred: false, ok: save(KEYS.stars, stars) }; }
    stars[k] = { state: STAR_STATES[0], memo: "", at: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10) };
    return { starred: true, ok: save(KEYS.stars, stars) };
  }

  /* ── 별표 버튼 바인딩 (이벤트 위임: 목록 전체에 한 번만) ── */
  function bindStars(root, onChange) {
    if (!root || root.__persBound) return;
    root.__persBound = true;
    root.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".star-btn") : null;
      if (!btn || !btn.dataset.no) return;
      ev.preventDefault();
      var r = toggleStar(btn.dataset.no);
      paintStarBtn(btn, r.starred);
      if (onChange) onChange(btn.dataset.no, r.starred);
    });
  }
  function paintStarBtn(btn, on) {
    btn.classList.toggle("on", !!on);
    btn.setAttribute("aria-pressed", String(!!on));
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-label", on ? "관심공고 해제" : "관심공고 저장");
  }
  function starBtnHtml(no) {
    var on = isStarred(no);
    return '<button type="button" class="star-btn' + (on ? " on" : "") + '" data-no="' + String(no).replace(/"/g, "&quot;") +
      '" aria-pressed="' + on + '" aria-label="' + (on ? "관심공고 해제" : "관심공고 저장") + '" title="관심공고">' + (on ? "★" : "☆") + "</button>";
  }

  /* ── CSV 내보내기 (UTF-8 BOM, 엑셀 호환 CRLF) ── */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCsv(headers, rows) {
    var lines = [headers.map(csvCell).join(",")];
    (rows || []).forEach(function (r) { lines.push((r || []).map(csvCell).join(",")); });
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }
  function downloadCsv(filename, headers, rows) {
    var blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ── 한국시간 날짜 계산 (캘린더) ──
     데이터의 일시는 KST 벽시계 문자열("YYYY-MM-DD HH:MM:SS")이다. */
  function kstDate(v) {
    if (!v) return null;
    var s = String(v).replace(" ", "T");
    var ms = Date.parse(s.length > 10 ? s + "+09:00" : s + "T00:00:00+09:00");
    if (isNaN(ms)) return null;
    return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  }
  /* 관심공고 한 건의 캘린더 일정. 6차 규칙:
     - 장기(상시) 접수 공고(lt)는 달력에서 제외(월간 달력에 놓일 날짜가 없다)
     - 투찰 마감이 없는 공고(cd 없음)는 개찰일만 표시하고 마감일 미공개로 둔다 */
  function calEvents(b) {
    if (!b || b.lt) return [];
    var evs = [];
    var pd = kstDate(b.pd);
    var cd = b.cd ? kstDate(b.cd) : null;
    var od = b.od ? kstDate(b.od) : null;
    if (pd) evs.push({ date: pd, kind: "공고", no: b.no });
    if (cd) evs.push({ date: cd, kind: "투찰마감", no: b.no });
    if (od) evs.push({ date: od, kind: "개찰", no: b.no });
    return evs;
  }

  window.BID_PERS = {
    KEYS: KEYS, MAX_FILTERS: MAX_FILTERS, STAR_STATES: STAR_STATES, MEMO_MAX: MEMO_MAX,
    listFilters: listFilters, saveFilter: saveFilter, getFilter: getFilter, deleteFilter: deleteFilter,
    getExcludes: getExcludes, addExclude: addExclude, removeExclude: removeExclude,
    isExcluded: isExcluded, countExcluded: countExcluded, applyExcludes: applyExcludes,
    getStars: getStars, isStarred: isStarred, getStar: getStar, starCount: starCount,
    setStar: setStar, toggleStar: toggleStar, bindStars: bindStars, starBtnHtml: starBtnHtml,
    csvCell: csvCell, toCsv: toCsv, downloadCsv: downloadCsv,
    kstDate: kstDate, calEvents: calEvents
  };
})();
