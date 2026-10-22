---
name: cgi-product-browser-verify
description: "ZCode 내장 브라우저(IAB)로 상품 사이트를 실측·검증하고, HTTP 수집 결과와 교차 검증하는 절차. Cafe24 기반 B2B/B2C 상점처럼 스펙행이 사이트마다 다른 경우에 '없는 필드는 null로 두기', '브라우저 원시 덤프 → 스키마 변환 → dedupe' 흐름을 재사용한다. Use when verifying product data on a website, reconciling two catalogs, or building a product master from live pages."
---

# CGI 상품 브라우저 검증 스킬

ZCode 공식 `browser-use` 플러그인의 `control-browser` 스킬로 상품 사이트를
**실제 렌더된 화면**에서 확인하고, 그 값을 스키마로 정리하는 절차.

이 스킬은 2026-10-22 samasound.co.kr / samamusic.co.kr 실측에서 얻은
실전 절차다. 기존 문서: `docs/CGI_BROWSER_VERIFICATION_REPORT.md`,
`docs/CGI_PRODUCT_MASTER_SCHEMA.md`.

---

## 0. 사전 점검

```
agent.browsers.list()
```

* `iab` (ZCode In-app Browser) 가 있으면 그것을 쓴다.
* `extension` / `cdp` 가 목록에 없으면 **사용했다고 말하지 않는다.**
  백엔드를 조용히 바꿀 수도 없다.
* `iab` 만 있으면 `agent.browsers.get("iab")` 로 고정한다.

---

## 1. 매 JS 호출마다 부트스트랩 (변수·상태는 안 살아남는다)

`mcp__node_repl__js` 의 커널은 호출마다 새로 시작한다. `browser`, `tab` 변수는
**정의상 존재하지 않는다**. 그래서 매 호출 첫 줄에 부트스트랩을 넣는다.

```js
const browserPluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
if (!browserPluginRoot) throw new Error("Browser plugin root is unavailable in the node_repl host");
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const browserClientUrl = pathToFileURL(join(browserPluginRoot, "scripts", "browser-client.mjs")).href;
const { setupBrowserRuntime } = await import(browserClientUrl);
await setupBrowserRuntime({ globals: globalThis });

const browser = await agent.browsers.get("iab");
```

> `process.env.ZCODE_PLUGIN_ROOT` 로 루트를 잡는다. 스킬 디렉터리 경로로
> 조립하면 안 된다(플러그인 런타임 자산이 스킬 밑에 없다).

---

## 2. 탭 선택 규칙

1. 논리적 작업 묶음의 **시작**에, 전용 JS 호출 하나로 전체 탭 목록을 모델에 돌려준다.

   ```js
   const controlledTabs = await browser.tabs.list();
   controlledTabs;   // 이 값을 마지막 식으로 둔다
   ```

2. 그 **다음** 호출에서 id/URL/title 로 대상을 찾아 `browser.tabs.get(id)` 한다.
   배열 인덱스(`[0]`, `at(-1)`)로 고르지 않는다.
3. 제어된 탭에 없으면 `browser.user.openTabs()` 로 사용자가 연 탭을 확인하고
   `browser.user.claimTab(info)` 로 점유한다.
4. 같은 호스트의 탭을 계속 쓸 때는 `await agent.browsers.open(url)` 가
   재사용 + 활성화까지 처리해 준다. 다른 호스트면 새 탭이 만들어진다.

---

## 3. 관측과 이동

```js
const tab = await agent.browsers.open("https://example.com/product/1");
await tab.playwright.waitForLoadState({ state: "domcontentloaded" });  // goto 뒤 반드시
const snap = await tab.playwright.domSnapshot();                     // 기본 관측
```

* `domSnapshot()` 이 **근거**다. 스냅샷에 있는 role/이름/속성만으로 locator 를 만든다.
  추정 selector 를 시험용으로 던지지 않는다.
* `goto()` 뒤에는 `waitForLoadState({ state: "domcontentloaded" })` 를 명시적으로 호출한다.
* `networkidle` 은 IAB 백엔드에서 거부된다. `waitForTimeout` 은 예외적 상황에서만.
* `evaluate()` 는 **페이지 상태를 읽는** 용도로 제한적으로 쓴다.
  아래 §5 의 "필드 일괄 추출" 처럼 스냅샷으로는 표현하기 어려운 *수집* 용도로 쓴다.
  스냅샷에 이미 있는 정보를 다시 뒤질 필요는 없다.

---

## 4. 수집 루프 패턴

```js
const out = [];
for (const url of urls) {
  await tab.goto(url);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
  out.push(await tab.playwright.evaluate(() => { /* 한 페이지 분량만 */ }));
}
```

* 한 번에 너무 많은 URL 을 돌리지 않는다. 호출당 타임아웃(기본 60초, 최대 120초)을 넘기면
  루프를 쪼개는 게 먼저다. 14~15건씩이 실전에서 안정적이었다.
* 루프는 **읽기 전용**이어야 한다. 상태 변경 액션은 관측 사이 1회.

---

## 5. 필드 일괄 추출 (페이지 안에서)

```js
const rows = await tab.playwright.evaluate(() => {
  const out = {};
  document.querySelectorAll('table tr').forEach(tr => {
    const th = tr.querySelector('th'), td = tr.querySelector('td');
    if (th && td) {
      const k = (th.textContent || '').replace(/\s+/g, ' ').trim();
      const v = (td.textContent || '').replace(/\s+/g, ' ').trim();
      if (k && !(k in out)) out[k] = v;   // 첫 등장만
    }
  });
  return out;
});
```

* 라벨 → 값 사전을 그대로 **원본 증거**로 남긴다. 정규화는 나중에 코드로 한다.
* 이미지에 alt 속성이 상품명으로 들어있는 경우가 많다. 스펙행에 상품명이
  없을 때 대체 근거로 쓸 수 있다.
* `link[rel=canonical]` 은 반드시 따로 뽑는다. **canonical 호스트가 수집 호스트와
  다를 수 있다** (실측: `www.samamusic.co.kr` → canonical 은 `samastore.co.kr`).

---

## 6. 결과를 디스크에 쓰기 (브라우저 → 파일)

`mcp__node_repl__js` 안에서 `node:fs/promises` 를 쓸 수 있다. 손으로 옮기지 않고
브라우저가 직접 파일을 쓰게 하면 옮김 실수가 없다.

```js
const fs = await import('node:fs/promises');
await fs.mkdir('C:/repo/reports/data', { recursive: true });
await fs.writeFile('C:/repo/reports/data/_browser_dump.json', JSON.stringify(out, null, 2), 'utf8');
```

* 파일명 앞에 `_` 를 붙여 "원시 덤프"임을 드러낸다. 정식 산출물은 변환 후 생성한다.
* 원시 덤프와 정식 산출물을 **분리**한다. 변환 로직은 나중에 재실행 가능해야 한다.

---

## 7. 스키마로 옮길 때 — 없는 필드는 null

가장 자주 틀리는 부분이다. **사이트마다 스펙행이 다르다.**

| | samasound (B2B) | samamusic (B2C) |
|---|---|---|
| `브랜드` 행 | 없음 | 있음 |
| `제조사` 행 | 있음 | 없음 |
| `모델명` 행 | 없음 | 있음 |
| `판매가` | "가격 문의" (숫자 없음) | 실제 금액 |

규칙:

1. 원본에 있는 행만 옮긴다. 없는 행은 `null`.
2. 이름에서 브랜드를 파싱해 `brand` 를 채우지 않는다.
   (`Fender Studio Pro` 의 `제조사` 는 `PreSonus` 다. 상품명 파싱은 원본과 어긋난다.)
3. `영문상품명` 같은 "그럴듯한" 행이 있어도 `모델명` 이 없으면 `model` 은 `null` 로 두고,
   원문은 `specs` 안에 증거로만 남긴다.
4. "가격 문의" 에서 숫자를 만들어내지 않는다. `price_type='inquiry'`, `public_price=null`.
5. 재고·도매가는 공개 근거가 없으면 **항상** `null`.

이 규칙을 **코드로 강제**한다. 사람이 실수하지 않게 검증기가 있어야 한다.
(구현: `tools/product_master/validate.py` 의 `validate_policy`)

---

## 8. HTTP 수집으로 옮길 때 (반복 수집은 HTTP 가 정답)

브라우저는 렌더 결과를 보지만 반복 수집에는 비효율적이다. 브라우저로 확인한
페이지를 HTTP 로 그대로 가져와 **같은 원시 형식**으로 저장하면 이후 코드가
완전히 공유된다.

```python
client = HttpClient(user_agent=DEFAULT_USER_AGENT, delay=1.2, respect_robots=True)
result = client.get_with_retry(url)
dump = parse_detail(result.text, site, product_id=..., collection_url=url)
```

반드시 지킬 것:

* **User-Agent**: `python-requests/…` 는 403 이다. 브라우저/curl UA 를 쓴다.
  UA 를 안 바꾸면 "사이트 죽음"으로 오판한다. (samasound·samamusic 양쪽에서 실측)
* **robots.txt**: `/product/*` 는 보통 허용되지만 `/api`, `/exec/front/`, `/member/`,
  `/myshop/`, `/protected/`, `/skin-*/`, 게시판 쓰기 경로는 금지다. 검사 후에만 요청한다.
* ** politeness**: 호스트별 최소 간격(1.2초) + `Crawl-delay` 존중.
* **존재하지 않는 id**: 404 는 "수집 실패"가 아니라 "그 id 는 존재하지 않음"이다.
  브라우저에서도 상품명이 없으면 양쪽에서 똑같이 제외되는지 확인한다.

---

## 9. 브라우저 ↔ HTTP 교차 검증

브라우저 확인값이 "진짜 화면값"임을 보장하려면, 같은 URL 을 HTTP 로 다시
가져와 **필드 단위로** 비교한다.

| 비교 | 판정 |
|---|---|
| 양쪽 null | `both_null` |
| 한쪽만 값 있음 | `browser_only` / `http_only` (경로 가용성 차이) |
| 값이 같음 | `match` |
| 값이 다름 | `mismatch` → **FAIL** |

실측 결과: 29/29 레코드가 8개 필드 전부 일치 (`rate=1.0`).
이 결과가 있어야 "반복 수집은 HTTP 로, 브라우저는 검증·예외 복구"라는
운영 판단이 성립한다.

브라우저가 필요한 잔여 상황:

* HTTP 가 403/429 를 주는 URL (UA·쿠키·동적 렌더링)
* JS 로만 채워지는 값
* 사용자에게 보여줄 **시각적** 확인 (스크린샷)
* 예외 복구 — 수집 결과가 이상할 때 원본 화면을 다시 열어 눈으로 확인

---

## 10. 중복 판정에서의 함정 (실측 사례)

| 사례 | 결론 |
|---|---|
| `WL93` ⊂ `GLXD14R+/93 … WL93 포함` | 포함 관계일 뿐 다른 상품 → 후보 아님 |
| `SLXD4+` vs `SLXD4D+` | 접두 관계일 뿐 다른 모델 |
| `SM35-XLR` vs `SM35-TQG` | 접두 `SM35` 공유 → 부분 문자열 매칭은 위험 |
| `KSM32C 라이트 세트` vs `KSM32C 프리미엄 세트` | 모델만으로는 구분 불가 → **변형 서명** 필요 |
| `MVX2U G2` vs `MVX2UG2 (2세대)` | 공백·세대 표기 차이 → 정규화 필요 |

원칙: **부분 문자열이 아니라 표현 단위 일치**, **모호한 표현은 변형 서명으로
구분**, **확신 부족하면 자동 병합하지 않는다.**

---

## 11. 체크리스트

- [ ] `agent.browsers.list()` 로 백엔드 확인 (없는 백엔드 사용하지 않음)
- [ ] 매 호출 부트스트랩
- [ ] 작업 묶음 시작에 `tabs.list()` 로 탭 목록 확인 → 다음 호출에서 `tabs.get(id)`
- [ ] `goto()` 후 `waitForLoadState({ state: "domcontentloaded" })`
- [ ] `domSnapshot()` 으로 locator 근거 확보 (추정 selector 금지)
- [ ] 원본 라벨→값 사전을 그대로 보존 (원시 덤프)
- [ ] canonical URL 별도 확보
- [ ] 없는 스펙행은 `null` — 이름 파싱으로 메우지 않기
- [ ] "가격 문의"/"대리점 문의" 에서 숫자 생성 금지
- [ ] HTTP 수집 시 UA · robots · 간격 준수
- [ ] 브라우저 ↔ HTTP 교차 검증 결과 기록
- [ ] 원시 덤프와 정식 산출물 분리

---

## 12. 이 저장체에서의 재현

```bash
# 브라우저 덤프 → 마스터 샘플
python -m tools.product_master.cli build-sample \
  --dump reports/data/_browser_dump_samasound.json \
  --dump reports/data/_browser_dump_samamusic.json \
  --out-json reports/data/product_master_sample.json \
  --out-csv  reports/data/product_master_sample.csv

# HTTP 재수집 → 교차 검증
python -m tools.product_master.cli collect \
  --from-dump reports/data/_browser_dump_samasound.json \
  --from-dump reports/data/_browser_dump_samamusic.json \
  --out reports/data/_http_dump.json --delay 1.2
python -m tools.product_master.cli crosscheck \
  --browser reports/data/product_master_sample.json \
  --http    reports/data/http_collected_sample.json \
  --json-out reports/data/crosscheck_report.json

# 중복 판정 + 검증 + 테스트
python -m tools.product_master.cli dedupe --records reports/data/product_master_sample.json
python -m tools.product_master.cli validate --records reports/data/product_master_sample.json
python -m unittest discover -t . -s tools/product_master/tests -v
```
