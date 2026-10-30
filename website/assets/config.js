/*
 * config.js — CGI 홈페이지 설정 (대표/관리자가 여기만 고치면 됩니다)
 *
 * 1) 쇼핑몰(PR #17, main 병합본) 주소
 *    - website/ 와 site/ 가 같은 배포 루트에 있을 때의 기본값입니다.
 *    - 실제 도메인을 쓰게 되면 여기 한 줄만 바꾸면 됩니다.
 *    - URL 파라미터로도 덮어쓸 수 있습니다:  index.html?mall=https://example.com/site/
 *
 * 2) 쇼핑몰 라우팅 규칙 (PR #17 구현 기준 — 해시 라우터)
 *    - 홈        : index.html#/
 *    - 전체 목록 : index.html#/products
 *    - 브랜드 필터: index.html#/products?brand=SHURE   (쉼표로 다중 지정)
 *    - 상품 상세 : index.html#/product/<id>
 *    - brand 값은 쇼핑몰의 brand_norm(대문자 정규화) 기준입니다.
 *      예) Shure → SHURE, Q Acoustics → Q ACOUSTICS, Allen&Heath → ALLEN&HEATH
 *
 * 3) 취급 브랜드 목록
 *    - 삼아사운드 공개 페이지를 실측해 확정한 31개 (Issue #5).
 *    - 각 항목은 쇼핑몰의 브랜드 필터로 연결됩니다.
 *
 * 4) 공통 상품 마스터 연동 (이슈 #19 대비 준비)
 *    - mallDataUrl 의 상품 데이터를 읽을 수 있으면 홈페이지 브랜드 목록·건수를
 *      마스터 기준으로 자동 표시합니다(샘플 39건 → 전체 4,575건 교체 시 자동 반영).
 *    - 파일이 없으면 아래 brands 목록(31종)으로 graceful fallback 합니다.
 *    - 쇼핑몰 데이터 규격: 각 항목에 brand_norm(대문자) / brand / name / price.
 */
window.CGI_CONFIG = {
  siteName: '(주)시지아이 CGI',

  // ── 쇼핑몰(PR #17) 연결 주소 ────────────────────────────────
  // 이슈 #128: 두 Pages가 복본을 서빙하므로 상대경로 대신 상대 프로젝트의
  // canonical Pages URL로 이동한다(한쪽만 재배포해도 구버전 링크 노출 방지).
  // cgishop.pages.dev 루트는 /site/ 로 302 리다이렉트되며 해시는 보존된다.
  mallUrl: 'https://cgishop.pages.dev/',                  // 쇼핑몰 홈
  mallListUrl: 'https://cgishop.pages.dev/#/products',    // 쇼핑몰 전체 목록
  mallBrandParam: 'brand',                       // 브랜드 필터 쿼리 키
  mallBrandCase: 'upper',                        // brand_norm 에 맞춰 대문자 정규화

  // ── 공통 상품 마스터 연동 (있으면 자동 반영, 없으면 fallback) ──
  mallDataUrl: '../site/data/products.js',        // window.CGI_PRODUCTS 를 expose 하는 파일
  mallDataGlobal: 'CGI_PRODUCTS',

  // ── 취급 브랜드 (실측: samasound.co.kr 31개) ───────────────
  brands: [
    'Shure', 'Genelec', 'PRESONUS', 'Allen&Heath', 'Neutrik', 'HK Audio',
    'K&M', 'Martin Audio', 'Clear-Com', 'APOGEE', 'RADIAL', 'KLOTZ',
    'ARTURIA', '브랜드 미확인', 'REAN', 'IK MULTIMEDIA', 'VICOUSTIC', 'DYNAUDIO',
    'NATIVE INSTRUMENTS', 'iMAG', 'Q Acoustics', 'POSITIVE GRID', 'CLOUD',
    'ROTOSOUND', 'NASH GUITARS', 'TUTTLE GUITARS', 'COMPLY', 'QED', 'JICO',
    'Fidelice', 'Q-SYS'
  ]
};
