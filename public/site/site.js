// Shared header/footer for the public website (keeps pages free of inline script, per CSP).
const LOGO = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#13294b"/><path d="M9 17.5l4.2 4L23 11" fill="none" stroke="#7cc8c4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PAGES = [['/', 'Product'], ['/use-cases', 'Use cases'], ['/demo', 'Scheduling demo'], ['/pricing', 'Pricing'], ['/security', 'Security']];

const here = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
const header = document.querySelector('[data-site-header]');
if (header) {
  header.outerHTML = `
  <div class="synthetic-banner">Demonstration site. All schedules, people and records shown are fictional.</div>
  <header class="site-header"><div class="wrap">
    <a class="logo" href="/">${LOGO} CareQueue</a>
    <button class="btn btn-sm menu-toggle" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav class="nav" id="site-nav" aria-label="Main">
      ${PAGES.map(([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      <a href="/app/" class="btn btn-sm">Sign in</a>
      <a href="/request-demo" class="btn btn-primary btn-sm">Request a demo</a>
    </nav>
  </div></header>`;
  const toggle = document.querySelector('.menu-toggle');
  toggle.addEventListener('click', () => {
    const nav = document.getElementById('site-nav');
    nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', nav.classList.contains('open'));
  });
}

const footer = document.querySelector('[data-site-footer]');
if (footer) {
  footer.outerHTML = `
  <footer class="site-footer"><div class="wrap">
    <div><a class="logo" href="/" style="color:#fff">${LOGO} CareQueue</a><p style="margin-top:10px;max-width:28em">Scheduling and coordination for home-care agencies. Administrative support only — CareQueue does not provide clinical advice or assessments.</p></div>
    <div class="links">${PAGES.map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}<a href="/request-demo">Request a demo</a></div>
  </div></footer>`;
}
