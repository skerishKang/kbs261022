/*
 * product.js — CGI 상품 카탈로그 상세 페이지
 *
 * 원본 삼아스토어 상세 페이지에서 분석해 확인한 구조를 재사용한다:
 *   · 갤러리: 정사각형 메인 이미지 + 썸네일 리스트(클릭 시 교체) — 원본 .ThumbImage ↔ big_img_box 와 동일 동작
 *   · 기본 정보 표(th/td) — 원본 '기본 정보' caption 과 동일 형식
 *   · 탭: 상세정보 / 옵션 정보 / 출처·검증 — 원본 상세정보·구매안내·상품후기 구조를 정보성 탭으로 재구성
 *   · 옵션: 원본에서 수집된 옵션(선택지 + 추가가 + 품절 표기)만 표시하고 주문으로 연결하지 않는다
 */
(function () {
  'use strict';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }
  function won(n) { return Number(n).toLocaleString('ko-KR') + '원'; }

  var SPEC_SKIP = {
    '상품명': 1, '판매가': 1, '번호': 1, '제목': 1,
    '길이선택': 1, '길이 선택': 1, '색상 선택': 1, '색상선택': 1, '상품선택': 1
  };

  function renderGallery(p, root) {
    var g = el('div', 'gallery');
    var main = el('div', 'main');
    var imgs = p.imageUrls.length ? p.imageUrls : (p.image ? [p.image] : []);
    if (!imgs.length) {
      main.appendChild(el('div', 'placeholder', '이미지 없음'));
    } else {
      var big = el('img');
      big.src = imgs[0];
      big.alt = p.name;
      big.addEventListener('error', function () {
        big.remove();
        main.appendChild(el('div', 'placeholder', '이미지 없음'));
      });
      main.appendChild(big);
    }
    g.appendChild(main);

    if (imgs.length > 1) {
      var thumbs = el('div', 'thumbs');
      imgs.slice(0, 8).forEach(function (src, i) {
        var b = el('button');
        b.type = 'button';
        b.setAttribute('aria-current', i === 0 ? 'true' : 'false');
        b.setAttribute('aria-label', '이미지 ' + (i + 1));
        var t = el('img');
        t.src = src;
        t.alt = '';
        t.loading = 'lazy';
        b.appendChild(t);
        b.addEventListener('click', function () {
          $$('button', thumbs).forEach(function (x) { x.setAttribute('aria-current', 'false'); });
          b.setAttribute('aria-current', 'true');
          big.src = src;
        });
        thumbs.appendChild(b);
      });
      g.appendChild(thumbs);
    }
    root.appendChild(g);
  }

  function renderPrice(p, root) {
    var box = el('div', 'pricebox');
    box.appendChild(el('div', 'label', '원본 공개가 (참고용)'));
    if (p.priceState === 'public' && p.price !== null) {
      box.appendChild(el('div', 'value', won(p.price)));
    } else if (p.priceState === 'inquiry_price') {
      box.classList.add('inquiry');
      box.appendChild(el('div', 'value', '가격 문의 (공급처 문의 필요)'));
    } else if (p.priceState === 'sold_out_sale_completed') {
      box.classList.add('inquiry');
      box.appendChild(el('div', 'value', '판매 완료 / 품절'));
    } else {
      box.classList.add('unknown');
      box.appendChild(el('div', 'value', '가격 정보 없음'));
    }
    var cav = el('div', 'caveat');
    cav.appendChild(el('div', null, 'CGI 판매가 · 공급가 · 재고: 미확정 (추정 금액을 표시하지 않습니다)'));
    cav.appendChild(el('div', null, '위 금액은 원본 공개 페이지 표기이며 CGI 판매 가격이 아닙니다.'));
    box.appendChild(cav);
    root.appendChild(box);
  }

  function renderOptions(p, root) {
    if (!p.options || !p.options.length) { return; }
    var wrap = el('div');
    p.options.forEach(function (grp) {
      var g = el('div', 'optgroup');
      g.appendChild(el('label', null, grp.name + (grp.values.length ? '' : ' (선택지 미확인)')));
      if (grp.values_uncertain) {
        // 원본 HTML 에서 선택지가 이어붙여져 있어 경계를 확정할 수 없다.
        // 추정해서 나누지 않고 원본 표기 그대로 안내한다.
        var raw = el('div');
        raw.style.cssText = 'font-size:12.5px;color:#6b7280;line-height:1.6;';
        raw.textContent = '원본 표기: ' + grp.values.map(function (v) { return v.label; }).join(' / ') +
          ' — 선택지 경계가 원본에서 이어붙여져 있어 확정할 수 없습니다(추정 표시 안 함)';
        g.appendChild(raw);
      } else if (grp.values.length) {
        var chips = el('div', 'opts');
        grp.values.forEach(function (v) {
          var b = el('button', 'chip');
          b.type = 'button';
          b.setAttribute('aria-pressed', 'false');
          b.appendChild(document.createTextNode(v.label));
          if (v.add_price) {
            b.appendChild(el('span', 'add', ' (+' + Number(v.add_price).toLocaleString('ko-KR') + '원)'));
          }
          if (v.sold_out) { b.appendChild(el('span', 'add', ' [품절]')); }
          b.addEventListener('click', function () {
            $$('.chip', chips).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
            b.setAttribute('aria-pressed', 'true');
            var note = $('#selNote');
            if (note) {
              note.textContent = '선택: ' + grp.name + ' = ' + v.label +
                (v.add_price ? ' (+' + Number(v.add_price).toLocaleString('ko-KR') + '원)' : '') +
                (v.sold_out ? ' (품절)' : '');
            }
          });
          chips.appendChild(b);
        });
        g.appendChild(chips);
      }
      wrap.appendChild(g);
    });
    var note = el('div');
    note.id = 'selNote';
    note.style.cssText = 'font-size:12.5px;color:#6b7280;margin-top:4px;';
    note.textContent = '옵션은 참고용 표시이며 주문·결제로 연결되지 않습니다.';
    wrap.appendChild(note);
    root.appendChild(wrap);
  }

  function renderTabs(p, root) {
    var tabs = el('div', 'tabs');
    var list = el('div', 'tablist');
    list.setAttribute('role', 'tablist');
    var panels = [];

    function addTab(label, build) {
      var btn = el('button', null, label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      var panel = el('div', 'tabpanel');
      panel.setAttribute('role', 'tabpanel');
      panel.hidden = true;
      build(panel);
      panels.push({ btn: btn, panel: panel });
      list.appendChild(btn);
    }

    addTab('상세정보', function (panel) {
      var keys = Object.keys(p.specs).filter(function (k) { return !SPEC_SKIP[k]; });
      if (!keys.length) {
        panel.appendChild(el('div', null, '수집된 상세 설명이 없습니다.'));
        return;
      }
      var kv = el('div', 'kv');
      keys.forEach(function (k) {
        kv.appendChild(el('div', null, k));
        kv.appendChild(el('div', null, p.specs[k]));
      });
      panel.appendChild(kv);
    });

    addTab('옵션 정보', function (panel) {
      if (!p.options || !p.options.length) {
        panel.appendChild(el('div', null, '이 상품에는 옵션이 없거나 옵션 정보가 수집되지 않았습니다.'));
        return;
      }
      p.options.forEach(function (grp) {
        var t = el('table');
        var tb = el('tbody');
        var tr = el('tr');
        tr.appendChild(el('th', null, grp.name));
        var td = el('td');
        if (!grp.values.length) {
          td.textContent = '선택지 미확인';
        } else {
          grp.values.forEach(function (v) {
            var line = v.label;
            if (v.add_price) { line += ' (+' + Number(v.add_price).toLocaleString('ko-KR') + '원)'; }
            if (v.sold_out) { line += ' [품절]'; }
            if (v.item_code) { line += ' · 품번 ' + v.item_code; }
            td.appendChild(el('div', null, line));
          });
        }
        tr.appendChild(td);
        tb.appendChild(tr);
        t.appendChild(tb);
        panel.appendChild(t);
      });

      if (p.bundledItems && p.bundledItems.length) {
        var h = el('div', null, '구성·추가상품 (원본 기준)');
        h.style.cssText = 'font-weight:700;color:#16233d;margin:16px 0 6px;font-size:13.5px;';
        panel.appendChild(h);
        var ul = el('div');
        p.bundledItems.forEach(function (b) {
          ul.appendChild(el('div', null, '· ' + b.name + (b.price_text ? ' — ' + b.price_text : '') + (b.sold_out ? ' [품절]' : '')));
        });
        panel.appendChild(ul);
      }
    });

    addTab('출처 · 검증', function (panel) {
      var kv = el('div', 'kv');
      function row(k, v, isPre) {
        kv.appendChild(el('div', null, k));
        var d = el('div');
        if (isPre) {
          var pre = el('pre', null, v);
          d.appendChild(pre);
        } else {
          d.textContent = v || '미확인';
        }
        kv.appendChild(d);
      }
      row('원본 사이트', p.sourceSiteLabel);
      row('원본 상품 ID', p.sourceProductId);
      row('원본 카테고리', p.sourceCategoryPath || '미확인');
      row('원본 상품 페이지', p.canonicalUrl);
      var a = el('a', null, '원본 페이지 열기 ↗');
      a.href = p.canonicalUrl; a.target = '_blank'; a.rel = 'noopener nofollow';
      var wrapA = el('div');
      wrapA.appendChild(a);
      kv.appendChild(el('div', null, '바로가기'));
      kv.appendChild(wrapA);
      row('수집 방법', p.extractionMethod);
      row('검증 상태', p.verificationStatus);
      row('수집 시각', p.updatedAt);
      row('출처 근거', p.sourceEvidence, true);
      panel.appendChild(kv);
    });

    addTab('스마트스토어 매핑 (예정)', function (panel) {
      panel.appendChild(el('div', null,
        '스마트스토어 개설 후 등록 데이터를 만들 때 사용할 매핑 초안입니다. 현재는 확정값이 아닙니다.'));
      var kv = el('div', 'kv');
      var sm = p.smartstore || {};
      function row(k, v) {
        kv.appendChild(el('div', null, k));
        kv.appendChild(el('div', null, v === null || v === undefined || v === '' ? '미확정' : String(v)));
      }
      row('등록 상품명', sm.product_name || p.name);
      row('원본 카테고리', p.sourceCategoryPath || '미확인');
      row('옵션 구분', sm.option_type || '미확정');
      row('등록 가격', '미확정 — 공급가 확정 후 결정');
      row('재고', '미확정');
      row('등록 이미지', (p.imageUrls.length || 0) + '건 수집됨 (원본 출처 이미지)');
      row('준비 상태', sm.ready ? '준비됨' : '미준비 (스토어 개설 전)');
      panel.appendChild(kv);
    });

    tabs.appendChild(list);

    panels.forEach(function (t, i) {
      t.btn.addEventListener('click', function () {
        panels.forEach(function (x) {
          x.btn.setAttribute('aria-selected', 'false');
          x.panel.hidden = true;
        });
        t.btn.setAttribute('aria-selected', 'true');
        t.panel.hidden = false;
      });
      if (i === 0) {
        t.btn.setAttribute('aria-selected', 'true');
        t.panel.hidden = false;
      }
      tabs.appendChild(t.panel);
    });

    root.appendChild(tabs);
  }

  function render(p, root) {
    var crumbs = $('#crumbs');
    crumbs.innerHTML = '';
    crumbs.appendChild(el('a', null, '홈'));
    crumbs.appendChild(document.createTextNode(' › '));
    crumbs.appendChild(el('a', null, '전체 상품'));
    crumbs.appendChild(document.createTextNode(' › '));
    crumbs.appendChild(el('span', null, p.name || '(상품명 미확인)'));

    var detail = el('div', 'detail');

    var left = el('div');
    renderGallery(p, left);
    detail.appendChild(left);

    var right = el('div', 'pinfo');
    right.appendChild(el('h1', null, p.name || '(상품명 미확인)'));

    var meta = el('div', 'meta');
    var isSamaStore = p.sourceSite.indexOf('samamusic') >= 0;
    meta.appendChild(el('span', 'badge ' + (isSamaStore ? 'src-samamusic' : 'src-samasound'), p.sourceSiteLabel));
    meta.appendChild(el('span', 'badge ' + (p.cgiSaleStatus === 'approved' ? 'approved' : 'unapproved'),
      p.cgiSaleStatus === 'approved' ? 'CGI 판매 승인' : 'CGI 승인 전 · 수집 참고'));
    if (p.brand) { meta.appendChild(el('span', null, '브랜드 ' + p.brand)); }
    if (p.model) { meta.appendChild(el('span', null, '모델 ' + p.model)); }
    if (p.countryOfOrigin) { meta.appendChild(el('span', null, '원산지 ' + p.countryOfOrigin)); }
    right.appendChild(meta);

    if (p.summary) {
      var s = el('p', null, p.summary);
      s.style.cssText = 'font-size:13.5px;color:#4b5563;margin:0 0 14px;line-height:1.7;';
      right.appendChild(s);
    }

    renderPrice(p, right);
    renderOptions(p, right);

    var actions = el('div', 'actionrow');
    var ask = el('button', 'btn primary', 'CGI 문의하기');
    ask.type = 'button';
    ask.setAttribute('aria-disabled', 'true');
    ask.title = '스마트스토어 개설 후 문의/주문 기능이 활성화됩니다.';
    ask.addEventListener('click', function () {
      window.alert('아직 문의·주문 기능이 제공되지 않습니다.\n네이버 스마트스토어 개설 후 활성화 예정입니다.');
    });
    actions.appendChild(ask);

    var srcBtn = el('a', 'btn', '원본 상품 페이지 보기 ↗');
    srcBtn.href = p.canonicalUrl;
    srcBtn.target = '_blank';
    srcBtn.rel = 'noopener nofollow';
    actions.appendChild(srcBtn);
    right.appendChild(actions);

    var nofix = el('div', 'nofix');
    nofix.appendChild(el('strong', null, '주문·결제 기능 미구현'));
    nofix.appendChild(el('div', null,
      '네이버 스마트스토어 개설 전이므로 이 페이지에서 주문, 결제, 장바구니 담기가 동작하지 않습니다. ' +
      '현재 표시된 정보는 공급처 공개 페이지에서 수집한 참고용 정보이며 CGI가 판매를 승인한 상품 목록과 다릅니다.'));
    right.appendChild(nofix);

    detail.appendChild(right);
    root.appendChild(detail);

    renderTabs(p, root);
  }

  function boot() {
    var id = new URLSearchParams(location.search).get('id') || '';
    CGICatalog.load({
      inlineVar: 'CGI_CATALOG',
      jsonUrls: ['data/catalog.full.json', 'data/catalog.demo.json']
    }).then(function (catalog) {
      var root = $('#detailRoot');
      var p = catalog.products.filter(function (x) { return x.id === id; })[0];
      if (!p) {
        var e = el('div', 'empty');
        e.appendChild(el('strong', null, '해당 상품을 찾을 수 없습니다.'));
        e.appendChild(el('div', null, '카탈로그가 교체되었거나 링크가 오래되었습니다.'));
        var back = el('a', 'btn', '← 전체 상품으로');
        back.href = 'index.html';
        back.style.marginTop = '14px';
        e.appendChild(back);
        root.appendChild(e);
        return;
      }
      document.title = (p.name || '상품 상세') + ' — CGI 상품 카탈로그';
      render(p, root);
    }).catch(function (err) {
      var root = $('#detailRoot');
      var e = el('div', 'empty');
      e.appendChild(el('strong', null, '카탈로그 데이터를 불러오지 못했습니다.'));
      e.appendChild(el('div', null, String(err && err.message ? err.message : err)));
      root.appendChild(e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
