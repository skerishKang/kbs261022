/*
 * config.js — CGI 입찰정보 연결 설정 (이슈 #188)
 *
 * 기본값은 배치 A(같은 배포 루트에 site/·website/·bid/가 나란히 있음)다.
 * 홈페이지·쇼핑몰이 별도 Pages 프로젝트(cgihomepage·cgishop)로 서빙되므로
 * 교차 링크는 각 프로젝트의 canonical 주소를 쓴다(website/assets/config.js, site/config.js와 같은 원칙).
 */
window.CGI_BID_CONFIG = {
  homepageUrl: 'https://cgihomepage.pages.dev/',
  mallUrl: 'https://cgishop.pages.dev/',
  termsUrl: '../site/terms.html',
  privacyUrl: '../site/privacy.html',
  // 회원·요금 준비 중에는 견적 접수 API로 사전 신청을 받는다(빈 값이면 메일 안내만 표시).
  signupApiUrl: '',
  contactEmail: 'cgiinc@naver.com'
};
