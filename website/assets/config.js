/*
 * config.js — CGI 홈페이지 설정 (대표/관리자가 여기만 고치면 됩니다)
 *
 * 1) 쇼핑몰(PR #15) 주소
 *    - website/ 와 site/ 가 같은 배포 루트에 있을 때의 기본값: ../site/index.html
 *    - 실제 도메인을 쓰게 되면 여기 한 줄만 바꾸면 됩니다.
 *    - URL 파라미터로도 덮어쓸 수 있습니다:  index.html?mall=https://example.com/site/
 * 2) 취급 브랜드 목록
 *    - 삼아사운드/삼아스토어 공개 페이지를 실측해 확정한 목록 (31개)
 *    - 각 항목은 쇼핑몰의 브랜드 필터로 연결됩니다.
 */
window.CGI_CONFIG = {
  siteName: '(주)시지아이 CGI',
  // ── 쇼핑몰(PR #15) 연결 주소 ──────────────────────────────
  mallUrl: '../site/index.html',
  mallLabel: 'CGI 상품 쇼핑몰',

  // ── 취급 브랜드 (실측: samasound.co.kr 31개) ───────────────
  brands: [
    'Shure', 'Genelec', 'PRESONUS', 'Allen&Heath', 'Neutrik', 'HK Audio',
    'K&M', 'Martin Audio', 'Clear-Com', 'APOGEE', 'RADIAL', 'KLOTZ',
    'ARTURIA', 'NNNN', 'REAN', 'IK MULTIMEDIA', 'VICOUSTIC', 'DYNAUDIO',
    'NATIVE INSTRUMENTS', 'iMAG', 'Q Acoustics', 'POSITIVE GRID', 'CLOUD',
    'ROTOSOUND', 'NASH GUITARS', 'TUTTLE GUITARS', 'COMPLY', 'QED', 'JICO',
    'Fidelice', 'Q-SYS'
  ]
};
