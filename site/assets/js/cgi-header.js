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

  nav.addEventListener('click', function (event) {
    if (event.target.closest('a')) close();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 899) close();
  });
})();
