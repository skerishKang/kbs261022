---
name: ecount-erp-browser
description: >-
  이카운트 ERP 를 브라우저로 읽기 전용 탐색하고 화면 구조(필드명·버튼·그리드 컬럼·
  일괄등록 템플릿 스펙)를 추출하는 스킬. 사용 시점: "이카운트 화면 확인", "ERP 필드 이름",
  "품목등록 양식", "이카운트 일괄등록 템플릿", "쇼핑몰 연동 지원 여부", "ERP 재고·주문·전표 구조",
  "CGI ERP 연동 설계". 단, "이카운트 ERP", "ecount", "품목등록 E040103", "쇼핑몰관리 C000654" 같은 표현.
  공개 계정으로 로그인하되 계정정보는 로컬에서만 취급하고 보고서·GitHub에 남기지 않는다.
  실제 운영 데이터의 생성·수정·삭제는 하지 않는다(읽기 전용 탐색 + 빈 서식 템플릿 다운로드까지).
---

# 이카운트 ERP 브라우저 탐색 스킬

이카운트 ERP 의 **화면 구조를 다시 조사하지 않고** 바로 원하는 필드/절차를 확인하기 위한 스킬.
모델 B 실계정 분석(2026-10-22)에서 **실제로 확인한 경로만** 담았다. 추측 경로는 없다.

---

## 0. 절대 규칙

1. **계정정보(회사코드·ID·암호·인증키·`ec_req_sid`)는 리포트·스크린샷·GitHub·대화에 남기지 않는다.**
   - 필요 시 작업자 로컬 임시 파일에 두고 읽어 쓰는 방식 사용.
   - 이 스킬의 스크립트는 **계정을 인자로 받지 않는다.** 로그인은 브라우저에서 사람이 하거나,
     로컬 자격증명 저장소에서 주입한다.
2. **운영 데이터의 생성·수정·삭제 금지.** 허용: 화면 이동, 조회, `엑셀서식내려받기`(빈 서식 파일), `API매뉴얼` 열람.
   금지: `저장(F8)`, `저장/전표(F7)`, `키발급`, `자료올리기`(실행), `선택삭제`, `사용중단/재사용`.
3. **실데이터 행을 저장소에 옮기지 않는다.** 구조(필드명·컬럼명·버튼·라벨)만 저장한다.
4. `robots.txt`·약관 준수. 요청은 순차 + 지연. 대량 조회는 `오천건이상조회` 기능으로 처리.

---

## 1. 로그인

| 항목 | 값 |
|---|---|
| 로그인 URL | `https://login.ecount.com/Login?lan_type=ko-KR` |
| 입력 | `#com_code` (회사코드, maxlength 6) · `#id` (아이디) · `#passwd` (비밀번호) |
| 제출 | `#save` (버튼 "로그인") |
| 캡차 | 로그인 화면에 캡차 위젯 없음(확인함). MFA/2차 인증 발생 시 사람에게 인계 |
| 성공 시 | `https://loginca.ecount.com/ec56/view/erp?w_flag=1&ec_req_sid=<세션>` 로 이동, 문서 title = 회사명 |
| 세션 | `ec_req_sid` 쿼리. **URL 캡처/공유 금지** |
| 세션 만료 | URL 이 `/login` 으로 되돌아가면 만료. 재로그인 |

로그인 화면의 유효 입력 필드는 `com_code`, `id`, `passwd` 뿐이고 나머지는 hidden(`spasswd`, `loginck`, `logintimeinck`, `lan_type`, `ts`, `zone`, `db_shard_no`, `domain`, `deviceFlag`, `deviceKey`, `s_second_auth_sid` 등).

---

## 2. 프로그램 이동 — 두 가지 방법

### 2.1 메뉴검색 (권속 · 가장 빠름)

좌상단 `#inputFavMSearch` (placeholder "메뉴검색"). 한국어 2~4자 입력 → 자동완성.

```js
await page.fill('#inputFavMSearch', '');
await page.type('#inputFavMSearch', '품목', { delay: 55 });
await page.waitForTimeout(2200);
const hit = await page.evaluate(() => {
  const a = [...document.querySelectorAll('.ui-menu-item a')].find(x => x.innerText.trim() === '품목등록');
  if (a) { a.click(); return a.id; }   // id = ui-id-<n>MENUTREE_xxxxxx
  return null;
});
await page.waitForTimeout(5000);
```

- 자동완성 항목 id 에 `MENUTREE_xxxxxx` 가 붙는다 → **3단계 프로그램의 `menuSeq`** 를 얻는 방법.
- `page.goto()` 로 프로그램 URL 에 직접 가면 **SPA 해시 라우팅이 깨진다.** 반드시 메뉴검색/좌측 네비로 이동한다.
- 메뉴검색은 **접두사 일치** 기준이라 `입고` 처럼 넓은 단어는 후보가 많다. 후보를 먼저 출력해서 고르고.
- 흔한 후보: `품목` → 품목등록 / 품목중심입력 / 품목별단가 / 쇼핑몰품목코드연결 / 품목vs시리얼재고수량비교

### 2.2 메뉴 트리 API (전수 덤프)

```
GET https://loginca.ecount.com/ec5/api/app.setup/action/menu_setting/GetNavigationTopMenuAction
  ?sid=root | <MENUTREE_sid>
  &version=<캐시버전> &tenant_sid=<사번> &user_sid=<ID> &ec_req_sid=<세션>
  &pathv3=https:loginca.ecount.com/ec56/view/erp
```
- `sid=root` → 1~2단계 `menu_info`. `sid=<2단계 sid>` → 그 그룹의 3단계 자식(`selected_menu.children_order`).
- **`version` 값은 브라우저가 이미 받은 URL 의 것을 그대로 재사용한다.** 임의 변경/Date.now() 대체 시 빈 응답.
- 전체 프로그램은 `Data.sid_mapping_info`(823개)에서 `prg_id` 로 조회.

---

## 3. 화면 구조 추출 (읽기 전용)

```js
const EXTRACT = () => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const o = { title: document.title, url: location.href.replace(/ec_req_sid=[^&]*/gi, 'ec_req_sid=REDACTED') };
  o.grids = [...document.querySelectorAll('table')].map(t => ({
    id: t.id || null,
    cols: [...t.querySelectorAll('thead th')].map(th => clean(th.innerText)).filter(Boolean),
    rows: t.querySelectorAll('tbody tr').length,          // 행 개수만. 값은 가져가지 않는다
  })).filter(g => g.cols.length);
  const f = {};
  [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].forEach(e => {
    const cid = e.getAttribute('data-cid');
    const key = cid || e.getAttribute('name') || e.id || null;
    if (!key || /^(tbody|thead)/.test(key)) return;
    const box = e.closest('.control-set, .form-group, .form-inline, td, li');
    const lab = box ? clean(box.querySelector('label,.tit,.field-label,.control-label')?.innerText) : '';
    if (!f[key]) f[key] = { key, cid: cid || null, name: e.getAttribute('name') || null,
      label: lab || e.getAttribute('placeholder') || e.getAttribute('title') || '',
      tag: e.tagName.toLowerCase(), type: e.type || null, ro: e.readOnly === true };
  });
  o.fields = Object.values(f);
  o.buttons = [...new Set([...document.querySelectorAll('button, a.btn')].map(b => clean(b.innerText || b.value)).filter(Boolean))];
  o.tabs   = [...new Set([...document.querySelectorAll('ul.nav-tabs li')].map(t => clean(t.innerText)).filter(Boolean))];
  o.labels = [...new Set([...document.querySelectorAll('label, .tit, .field-label, legend')].map(t => clean(t.innerText)).filter(t => t && t.length < 60))];
  return o;
};
```

### DOM 규칙 (실측)

| 대상 | 규칙 |
|---|---|
| 새 화면(V3) | 입력 필드가 `data-cid="<필드키>"` 를 가진다. `data-ecpath` 는 경로. **이게 진짜 필드명** |
| 구 화면(회계 전표 등) | `data-cid` 없음. `name`/`id` + `placeholder` 로 식별 |
| 그리드 | `table#grid-main`(본체) + `table#grid-fixedtop`(고정 헤더). 두 개가 별개 테이블이라 **헤더가 본체보다 클 수 있다** |
| 고정 헤더 표 | `thead` 가 본체와 분리. 열 매핑이 필요하면 **x좌표(getBoundingClientRect().left)** 로 매칭한다 |
| 모달(신규/수정 폼) | `#mainPage` 내부 `.tab-pane` 다수. 탭 이름은 `ul.nav-tabs li` 의 `id`(basic/A2/A3…)와 순서 대응 |
| 알림 | `console` 에 열려도 무해. 실제 오류는 `page.on('console')` 로 type=error 만 |

---

## 4. 프로그램 이력 (2026-10-22 실측)

| 화면 | prgId | menuSeq | 그룹 |
|---|---|---|---|
| 품목등록 리스트 | `E040103` | `MENUTREE_000174` | `MENUTREE_000029` (재고 I>기초등록) |
| 거래처리스트(거래처) | `E010101` | `MENUTREE_000255` | `MENUTREE_000042` (그룹웨어>고객관리) |
| 창고등록리스트 | `E040102` | `MENUTREE_000172` | `MENUTREE_000029` |
| 재고현황 | `E040701` | `MENUTREE_000212` | `MENUTREE_000035` (재고 I>출력물) |
| 판매현황 | `E040207` | `MENUTREE_000573` | `MENUTREE_000035` |
| 미판매현황 | `E040212` | `MENUTREE_000578` | `MENUTREE_000035` |
| 주문서입력 | `E040203` | `MENUTREE_000488` | `MENUTREE_000030` (재고 I>영업관리) |
| 주문서조회 | `E040204` | `MENUTREE_000489` | `MENUTREE_000030` |
| 매출전표 I | `E010301` | `MENUTREE_000076` | `MENUTREE_000011` (회계 I>매출매입거래) |
| 매입전표 I | `E010303` | `MENUTREE_000078` | `MENUTREE_000011` |
| **쇼핑몰등록** | `E041003` | `MENUTREE_002575` | `MENUTREE_002571` (재고 I>쇼핑몰관리) |
| **쇼핑몰품목코드연결** | `E041004` | `MENUTREE_002576` | `MENUTREE_002571` |
| **엑셀자료올리기기능** | `E000129` | `MENUTREE_000279` | `MENUTREE_001602` (Self-Customizing>다운로드) |
| **API인증키발급** | `E000125` | `MENUTREE_001534` | `MENUTREE_001600` (Self-Customizing>정보관리) |
| 데이터수집 | `C001402` | `MENUTREE_002777` | 데이터센터 |
| 데이터내보내기 | `C001403` | `MENUTREE_002910` | 데이터센터 |
| 입고처리(WMS) | `E090181` | `MENUTREE_001969` | `MENUTREE_001959` (WMS) |

> **미확인**: `데이터내보내기`(C001403) · `ERP전표생성(입고/출고)` 화면 구조 · `WMS 입고처리`(E090181) 렌더. 프로그램 ID만 확인됨.

---

## 5. 일괄등록 템플릿 스펙 (빈 서식 파일 다운로드)

```js
// 대상 메뉴로 이동 → '웹자료올리기' 클릭 → '엑셀서식내려받기' 클릭 → download 캡처
const dlP = page.waitForEvent('download', { timeout: 15000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button,a.btn,a')]
    .find(x => (x.innerText||'').replace(/\s+/g,' ').trim() === '엑셀서식내려받기');
  b?.click();
});
const dl = await dlP;              // 항상 "Template.xlsx"
await dl.saveAs('<로컬경로>/Template.xlsx');
```

**xlsx 파싱 포인트**

| 파일 | 내용 |
|---|---|
| `xl/workbook.xml` | 시트명 (`<sheet name="...">`) |
| `xl/worksheets/sheet1.xml` | 헤더 행 셀 값 (열 A~Q) |
| `xl/comments1.xml` | **각 헤더 셀의 주석 = 입력 규격**(필수/선택, 최대 길이, 허용값). 필수다. |
| `xl/sharedStrings.xml` | 문자열 테이블 |

주석에서 `* 입력내용` / `* 입력글자제한` / 허용값 목록을 파싱하면 **정식 스펙**이 된다.
`xl/comments1.xml` 안의 텍스트는 `\uXXXX` 형태가 아니라 실제 UTF-8 이므로 그대로 읽으면 된다(확인함).

### 확인된 템플릿 스펙

**품목등록 (신규) 17컬럼**
`품목코드(20) · 품목명(100) · 바코드(30) · 규격구분(1) · 규격(100) · 단위(20) · 품목구분(1) · 세트여부(1) · 재고수량관리(1) · 입고단가(12/6) · 입고단가VAT포함여부(1) · 출고단가(12/6) · 출고단가VAT포함여부(1) · 부가세율(매출)(3/3) · 부가세율(매입)(3/3) · 검색창내용(100) · 품목공유여부(1)`

**거래처등록**
`거래처코드 · 상호(이름) · 대표자명 · 업태 · 종목 · 전화 · Fax · Email · 검색창내용 · 주소1 우편번호 · 주소1`

**쇼핑몰품목코드연결**
`쇼핑몰코드 · 품목코드 · 품목명 · 쇼핑몰품목key`

**창고별안전재고올리기 (품목등록 웹자료올리기 > 3번째 탭)**
`품목코드 · 창고코드 · 안전재고수량`

---

## 6. 자주 쓰는 화면 조작

| 하고 싶은 것 | 경로 | 주의 |
|---|---|---|
| 품목 등록 폼(필드 정의) | 품목등록 → `신규(F2)` | 모달. `저장(F8)` 는 **누르지 않는다** |
| 품목 변경 가능 필드 전체 | 품목등록 → `웹자료올리기` → `변경항목선택` | 153 항목 표. 그룹/필드키/라벨이 그대로 나온다 |
| 쇼핑몰 지원 기능 | 쇼핑몰등록 → `쇼핑몰별제공기능` | 34행 매트릭스. 헤더가 3단 + colSpan → **x좌표 매칭** 필요 |
| API 매뉴얼 | API인증키발급 → `API매뉴얼` | 새 탭으로 `https://sboapica.ecount.com/ECERP/OAPIView/OAPIManual?lan_type=ko-KR` |
| 메뉴 전체 구조 | 좌측 네비 클릭 또는 2.2 API | 3단계 프로그램은 메뉴검색으로 찾으면 빠르다 |
| 대용량 조회 | 각 화면 `오천건이상조회` | 1페이지는 20~26행 |

---

## 7. 스크립트

```
skills/ecount-erp-browser/scripts/
├── ecount_screen_probe.js   # 화면 구조 일괄 추출(읽기 전용) → JSON
├── ecount_menu_tree.js      # 메뉴 트리 API 전수 덤프 → JSON
└── ecount_template_dump.py  # xlsx → 컬럼/주석(규격) 텍스트
```

사용:

```bash
node skills/ecount-erp-browser/scripts/ecount_screen_probe.js --targets 품목등록,거래처등록,쇼핑몰등록
node skills/ecount-erp-browser/scripts/ecount_menu_tree.js
python skills/ecount-erp-browser/scripts/ecount_template_dump.py ./Template.xlsx
```

- 스크립트는 **계정 인자를 받지 않는다.** 로그인은 브라우저 세션 재사용 또는 운영자가 직접 수행.
- 산출 JSON 에는 `ec_req_sid` 를 포함하지 않는다(추출 시 치환).

---

## 8. 이 스킬로 알 수 있는 것 / 없는 것

| | |
|---|---|
| **있음** | 화면별 필드명(`data-cid`)·라벨·버튼·탭·그리드 컬럼, 품목 마스터 정식 필드 153개, 일괄등록 템플릿 스펙(컬럼·허용값·최대길이), 쇼핑몰 34개 지원 매트릭스, OAPI 발급 절차 |
| **없음(읽기전용 원칙)** | 실 품목/거래처/주문/재고 값, 인증키 값, 계정정보, OAPI 엔드포인트 상세(외부 매뉴얼), 제공가(전표 입력 시에만 존재) |
| **부재** | 이카운트에는 **브랜드·모델명 기본 필드가 없다.** `cont2~6`(문자형추가항목) 또는 `ADD_TXT_01~10` 확장필드로 처리해야 한다. `cont1` 은 `조달등록번호` 전용 |
| **부재** | 웹(카페24) 옵션 구조 = 이카운트 규격 구조 아님. `추가구성상품` 개념 없음 |
