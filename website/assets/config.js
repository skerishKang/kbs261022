/*
 * config.js — CGI 홈페이지 설정 (대표/관리자가 여기만 고치면 됩니다)
 *
 * 1) 쇼핑몰(PR #17, main 병합본) 주소
 *    - website/ 와 site/ 가 같은 배포 루트에 있을 때의 기본값입니다.
 *    - 실제 도메인을 쓰게 되면 여기 한 줄만 바꾸면 됩니다.
 *    - URL 파라미터(?mall=) 덮어쓰기는 보안상 제거했습니다. 이 파일만 고치세요.
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
 * 4) 브랜드 목록 연동 (이슈 #19)
 *    - mallBrandsUrl 의 brands.json(브랜드 이름·건수만)을 읽어 자동 표시합니다.
 *      상품 전체(11MB)를 읽지 않으므로 첫 화면이 가볍습니다.
 *    - 파일이 없으면 아래 brands 목록(31종)으로 graceful fallback 합니다.
 */
window.CGI_CONFIG = {
  siteName: '(주)시지아이 CGI',

  // ── 쇼핑몰(PR #17) 연결 주소 ────────────────────────────────
  // 같은 cgishop 배포 안의 /site/ 로 이동한다. 상대경로라 도메인 전환에도
  // 그대로 동작하고, 옛 cgishop 루트 리다이렉트에 의존하지 않는다.
  mallUrl: '../site/index.html',                  // 쇼핑몰 홈
  mallListUrl: '../site/index.html#/products',    // 쇼핑몰 전체 목록
  mallBrandParam: 'brand',                       // 브랜드 필터 쿼리 키
  mallBrandCase: 'upper',                        // brand_norm 에 맞춰 대문자 정규화

  // ── 브랜드 목록 연동 (있으면 자동 반영, 없으면 fallback) ──
  mallBrandsUrl: '../site/data/brands.json',      // 브랜드 이름 + 건수만

  // ── 취급 브랜드 (실측: samasound.co.kr 목록) ───────────────
  // 브랜드 별칭 정리(#213 D4)로 마스터(brands.json)와 겹치는 표기는 뺐다:
  // K&M→KÖNIG & MEYER, TUTTLE GUITARS→MICHAEL TUTTLE GUITARS, iMAG→IMAG SYSTEMS,
  // Q-SYS→QSC, 브랜드 미확인→기타(브랜드 목록에서 제외).
  brands: [
    'Shure', 'Genelec', 'PRESONUS', 'Allen&Heath', 'Neutrik', 'HK Audio',
    'Martin Audio', 'Clear-Com', 'APOGEE', 'RADIAL', 'KLOTZ',
    'ARTURIA', 'REAN', 'IK MULTIMEDIA', 'VICOUSTIC', 'DYNAUDIO',
    'NATIVE INSTRUMENTS', 'Q Acoustics', 'POSITIVE GRID', 'CLOUD',
    'ROTOSOUND', 'NASH GUITARS', 'COMPLY', 'QED', 'JICO',
    'Fidelice'
  ]
};
