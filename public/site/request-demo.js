const form = document.getElementById('demo-form');
const alertBox = document.getElementById('form-alert');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.consent = !!data.consent;
  const missing = ['name', 'email', 'agency', 'role', 'sizeBand', 'state'].filter((k) => !String(data[k] || '').trim());
  if (missing.length) {
    alertBox.innerHTML = '<div class="alert err">Please complete all required fields.</div>';
    form.querySelector(`[name=${missing[0]}]`).focus();
    return;
  }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/public/demo-request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CareQueue': '1' }, body: JSON.stringify(data) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    form.reset();
    alertBox.innerHTML = `<div class="alert ok">Thanks — we'll be in touch within one business day. Reference: <span class="mono">${body.reference || 'received'}</span></div>`;
  } catch (err) {
    alertBox.innerHTML = `<div class="alert err"></div>`;
    alertBox.firstChild.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
