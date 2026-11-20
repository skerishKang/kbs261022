(function () {
  'use strict';
  var header = document.getElementById('siteHeader');
  if (!header) return;
  var toggle = header.querySelector('[data-action="toggle-nav"]');
  var nav = header.querySelector('#siteNav');
  if (!toggle || !nav) return;

  function close() {
    header.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', function () {
    var open = header.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // 머리글 안의 어떤 링크(메뉴·장바구니·로고)를 눌러도, 검색을 실행해도, 화면이 바뀌어도
  // 휴대폰 메뉴는 닫는다. 열린 메뉴가 바뀐 화면을 가리던 문제(명예회원 1회차).
  header.addEventListener('click', function (event) {
    if (event.target.closest('a')) close();
  });
  header.addEventListener('submit', close);
  window.addEventListener('hashchange', close);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 899) close();
  });
})();
