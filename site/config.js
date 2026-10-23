/*
 * config.js — CGI 상품 쇼핑몰 ↔ 회사 홈페이지 연결 설정
 *
 * 배포 경로에 따라 여기 한 줄만 바꾸면 됩니다.
 *  - 기본값(로컬/저장소 루트 배포): ../website/index.html
 *  - 서브경로 배포(예: /catalog/):      ../index.html
 *  - 도메인 배포(예: https://cgi.co.kr/catalog/): https://cgi.co.kr/
 *
 * homepageUrl 을 지정하면 쇼핑몰의 모든 "회사 홈페이지" 링크가 이 값으로 적용됩니다.
 * (site/index.html 에는 기본값이 그대로 들어가 있어 JS 없이도 동작합니다)
 */
window.CGI_SITE_CONFIG = {
  // ── 회사 홈페이지 복귀 경로 ────────────────────────────────
  homepageUrl: '../website/index.html',
  // 견적 API (Cloudflare Worker). 비어 있으면 localStorage 정적 시연 모드.
  quoteApiUrl: 'https://cgi-quote-api.charliekant.workers.dev',
  homepageLabel: '회사 홈페이지',

  // ── 상품 데이터 경로 (이슈 #19 전체 마스터 반영 지점) ────────
  // 기본값은 data/products.js. ?data=<경로> 로 다른 JSON 을 지정할 수도 있습니다.
  //   예) site/index.html?data=data/products.json
  // #19 산출물이 오면 site/data/products.json / products.js 를 교체하면 됩니다.
  dataFile: 'data/products.js'
};
