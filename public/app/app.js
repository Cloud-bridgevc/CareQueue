// CareQueue operations dashboard (vanilla JS, no build step).
import { fmtTime, fmtDay, fmtDateTime, relative, ms, DAY, HOUR } from '/shared/time.js';
import { RECORD_FIELDS } from '/shared/rules.js';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { session: null, staff: [], cache: {}, scheduleDay: startOfToday(), queueFilter: { status: 'active', category: '', severity: '' }, reportDays: 7, walk: {} };

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CareQueue': '1' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { state.session = null; renderLogin(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

const can = (p) => !!state.session?.user?.permissions.includes(p);
const staffName = (id) => state.staff.find((u) => u.id === id)?.name || (id === 'system' ? 'System' : id || '—');
const sevPill = (s) => `<span class="pill sev-${s}">${esc(s)}</span>`;
const statusPill = (s) => {
  const map = { open: 'amber', acknowledged: 'teal', resolved: 'green', scheduled: '', in_progress: 'teal', completed: 'green', cancelled: 'gray', reported: 'amber', triaged: 'teal', escalated: 'red', pending_review: 'amber', needs_edit: 'red', approved: 'green', rejected: 'gray' };
  return `<span class="pill ${map[s] ?? ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;
};

function openDrawer(html) {
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  setTimeout(() => $('#drawer-body').querySelector('h2')?.focus?.(), 0);
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-body').innerHTML = ''; }

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const NAV = [
  { group: 'Operations' },
  { id: 'overview', label: 'Overview', perm: 'visits:read' },
  { id: 'my-visits', label: 'My visits', perm: 'visits:read_own' },
  { id: 'schedule', label: 'Visit scheduling', perm: 'visits:read' },
  { id: 'coverage', label: 'Assignment & coverage', perm: 'visits:write' },
  { id: 'confirmations', label: 'Visit confirmations', perm: 'visits:read' },
  { group: 'Care team' },
  { id: 'team', label: 'Care team directory', perm: 'team:read' },
  { id: 'availability', label: 'Caregiver availability', perm: 'team:read' },
  { group: 'Coordination' },
  { id: 'queue', label: 'Supervisor review queue', perm: 'queue:read', count: 'queue' },
  { id: 'handovers', label: 'Handover workspace', perm: 'handover:read' },
  { id: 'incidents', label: 'Incident escalation', perm: 'incidents:read' },
  { group: 'Oversight' },
  { id: 'reports', label: 'Operations reports', perm: 'reports:read' },
  { id: 'audit', label: 'Audit log', perm: 'audit:read' },
  { id: 'settings', label: 'Rules & retention', perm: 'settings:read' },
  { group: 'Demonstration' },
  { id: 'walkthrough', label: 'Missed-confirmation walkthrough', perm: 'demo:run' },
];

function route() {
  const [view, ...rest] = (location.hash.replace(/^#\/?/, '') || '').split('/');
  return { view, arg: rest.join('/') };
}

function defaultView() {
  return NAV.find((n) => n.id && can(n.perm))?.id || 'overview';
}

// ---------------------------------------------------------------------------
// Login (demo personas)
// ---------------------------------------------------------------------------

async function renderLogin() {
  const personas = await api('GET', '/api/personas');
  $('#root').innerHTML = `
  <div class="login">
    <a href="/" class="small">← CareQueue website</a>
    <h1 style="margin-top:16px">Sign in to the demonstration workspace</h1>
    <p class="muted">Choose a fictional staff persona. Each role sees a different slice of the workspace — try a caregiver and an auditor to see access controls in action. Production deployments use SSO with multi-factor authentication.</p>
    <div class="personas">${personas.map((p) => `
      <button class="persona" data-action="login" data-id="${esc(p.id)}">
        <strong>${esc(p.name)}</strong><span class="small muted">${esc(p.title)}</span><br><span class="pill teal" style="margin-top:8px">${esc(p.roleLabel)}</span>
      </button>`).join('')}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

async function render() {
  if (!state.session?.user) return renderLogin();
  let { view, arg } = route();
  const nav = NAV.find((n) => n.id === view);
  if (!nav || !can(nav.perm)) { view = defaultView(); history.replaceState(null, '', `#/${view}`); }
  const u = state.session.user;
  let queueCount = '';
  if (can('queue:read')) {
    try { const q = await api('GET', '/api/queue'); state.cache.queue = q; queueCount = q.filter((i) => i.status !== 'resolved').length; } catch { /* ignore */ }
  }
  $('#root').innerHTML = `
  <div class="shell">
    <nav class="sidebar" id="sidebar" aria-label="Dashboard">
      <div class="brand"><svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2c7f81"/><path d="M9 17.5l4.2 4L23 11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><div>CareQueue<span class="agency">${esc(state.session.agency.name)}</span></div></div>
      ${NAV.map((n, i) => {
        if (n.group) {
          const items = NAV.slice(i + 1, NAV.findIndex((m, j) => j > i && m.group) >>> 0).filter((m) => m.id && can(m.perm));
          return items.length ? `<div class="group">${esc(n.group)}</div>` : '';
        }
        if (!can(n.perm)) return '';
        const count = n.count === 'queue' && queueCount ? `<span class="count">${queueCount}</span>` : '';
        return `<a href="#/${n.id}" class="${n.id === view ? 'active' : ''}">${esc(n.label)}${count}</a>`;
      }).join('')}
    </nav>
    <div class="main">
      <div class="topbar">
        <button class="btn btn-sm menu-btn" data-action="menu" aria-label="Open navigation">☰</button>
        <span class="title">${esc(NAV.find((n) => n.id === view)?.label || '')}</span>
        <span class="spacer"></span>
        ${can('queue:update') ? '<button class="btn btn-sm" data-action="sweep" title="Run conflict and confirmation checks now">Run checks now</button>' : ''}
        <div class="user"><strong>${esc(u.name)}</strong>${esc(u.roleLabel)}</div>
        <button class="btn btn-sm btn-ghost" data-action="logout">Sign out</button>
      </div>
      <div class="content" id="view"><p class="muted">Loading…</p></div>
    </div>
  </div>`;
  try {
    $('#view').innerHTML = await VIEWS[view](arg);
  } catch (err) {
    if (err.message !== 'Signed out') $('#view').innerHTML = `<div class="card"><p>${esc(err.message)}</p></div>`;
  }
}

function pageHead(title, desc, tools = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="toolbar">${tools}</div></div>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const VIEWS = {};

VIEWS.overview = async () => {
  const o = await api('GET', '/api/overview');
  return `${pageHead(`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${state.session.user.name.split(' ')[0]}`, `Last automated check ${o.lastSweep ? relative(o.lastSweep.at) : 'not yet run'} · ${o.lastSweep?.findings ?? 0} active findings`)}
  <div class="stats">
    <div class="stat"><div class="label">Visits today</div><div class="value">${o.today.total}</div><div class="sub">${o.today.inProgress} in progress · ${o.today.confirmed} checked in</div></div>
    <div class="stat ${o.today.unassigned ? 'alert-red' : ''}"><div class="label">Unassigned today</div><div class="value">${o.today.unassigned}</div><div class="sub">needs coverage</div></div>
    <div class="stat ${o.queue.critical ? 'alert-red' : ''}"><div class="label">Open queue items</div><div class="value">${o.queue.open}</div><div class="sub">${o.queue.critical} critical</div></div>
    <div class="stat ${o.queue.overdue ? 'alert-amber' : ''}"><div class="label">Overdue follow-ups</div><div class="value">${o.queue.overdue}</div><div class="sub">past target time</div></div>
    ${o.summariesAwaiting != null ? `<div class="stat"><div class="label">Summaries to review</div><div class="value">${o.summariesAwaiting}</div><div class="sub">AI drafts, not yet shared</div></div>` : ''}
    ${o.incidentsOpen != null ? `<div class="stat"><div class="label">Open incidents</div><div class="value">${o.incidentsOpen}</div><div class="sub">operational</div></div>` : ''}
  </div>
  <div class="cols">
    <div class="card"><h2>Needs attention <a href="#/queue" class="small">Open queue →</a></h2>
      ${o.top.length ? o.top.map(queueRow).join('') : '<div class="empty">Nothing waiting. Nice.</div>'}
    </div>
    <div class="card"><h2>Coming up <a href="#/schedule" class="small">Schedule →</a></h2>
      ${o.upcoming.map((v) => `<div class="list-item clickable" data-action="visit" data-id="${v.id}"><div class="grow"><div class="t">${fmtTime(v.start)} · ${esc(v.client?.label)}</div><div class="d">${v.caregiverName ? esc(v.caregiverName) : '<strong style="color:var(--red)">Unassigned</strong>'} · ${esc(v.client?.zone)} · ${esc(v.serviceType)}</div></div><span class="tiny muted">${relative(v.start)}</span></div>`).join('')}
    </div>
  </div>`;
};

function queueRow(i) {
  return `<div class="list-item clickable" data-action="queue-item" data-id="${i.id}">
    ${sevPill(i.severity)}
    <div class="grow"><div class="t">${esc(i.title)}</div><div class="d">${esc(i.label)} · ${i.overdue ? '<strong style="color:var(--red)">overdue</strong>' : `due ${relative(i.dueAt)}`}${i.assigneeName ? ` · ${esc(i.assigneeName)}` : ''}${!i.conditionActive && i.status !== 'resolved' ? ' · <span class="pill green">condition cleared</span>' : ''}</div></div>
    ${statusPill(i.status)}
  </div>`;
}

// --- Visit scheduling ------------------------------------------------------

VIEWS.schedule = async () => {
  const day = state.scheduleDay;
  const [visits, caregivers, conflicts] = await Promise.all([
    api('GET', `/api/visits?from=${new Date(day).toISOString()}&to=${new Date(day + DAY).toISOString()}`),
    api('GET', '/api/caregivers'),
    api('GET', '/api/conflicts'),
  ]);
  state.cache.visits = visits;
  const flag = new Map();
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const f of conflicts) for (const id of f.refs.visitIds || []) if (!flag.has(id) || rank[f.severity] < rank[flag.get(id)]) flag.set(id, f.severity);

  const H0 = 6, H1 = 22, span = (H1 - H0) * 60;
  const pct = (t) => Math.max(0, Math.min(100, ((new Date(t).getHours() * 60 + new Date(t).getMinutes() - H0 * 60) / span) * 100));
  const weekday = new Date(day).getDay();
  const rows = caregivers.filter((c) => visits.some((v) => v.caregiverId === c.id) || c.availability.some((w) => w.day === weekday));
  const offBlocks = (c) => {
    const w = c.availability.find((x) => x.day === weekday);
    const onLeave = c.timeOff.some((o) => ms(o.start) < day + DAY && ms(o.end) > day);
    if (onLeave) return '<div class="off" style="left:0;width:100%;background:rgba(168,102,26,.10)"></div>';
    if (!w) return '<div class="off" style="left:0;width:100%"></div>';
    const s = ((+w.start.slice(0, 2) * 60 + +w.start.slice(3)) - H0 * 60) / span * 100;
    const e = ((+w.end.slice(0, 2) * 60 + +w.end.slice(3)) - H0 * 60) / span * 100;
    return `<div class="off" style="left:0;width:${Math.max(0, s)}%"></div><div class="off" style="left:${Math.min(100, e)}%;width:${Math.max(0, 100 - e)}%"></div>`;
  };
  const block = (v) => {
    const sev = flag.get(v.id);
    const cls = !v.caregiverId ? 'unassigned' : v.status === 'completed' ? 'done' : '';
    const style = sev && v.caregiverId ? `background:var(--${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'blue'}-soft);color:var(--${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'navy-2'})` : '';
    return `<button class="bv ${cls} ${sev ? `sev-${sev}` : ''}" data-action="visit" data-id="${v.id}" style="left:${pct(v.start)}%;width:${Math.max(pct(v.end) - pct(v.start), 2)}%;${style}" title="${esc(v.client?.label)} ${fmtTime(v.start)}–${fmtTime(v.end)}">${sev ? '⚠ ' : ''}${esc(v.client?.label.replace('Client ', '#'))}</button>`;
  };
  const isToday = day === startOfToday();
  const nowLine = isToday ? `<div class="now-line" style="left:${pct(Date.now())}%"></div>` : '';
  const unassigned = visits.filter((v) => !v.caregiverId && v.status !== 'cancelled');

  return `${pageHead('Visit scheduling', `${fmtDay(day)} · ${visits.filter((v) => v.status !== 'cancelled').length} visits · ${[...flag.keys()].filter((id) => visits.some((v) => v.id === id)).length} flagged`,
    `<button class="btn btn-sm" data-action="day" data-delta="-1">← Prev</button><button class="btn btn-sm" data-action="day" data-delta="0">Today</button><button class="btn btn-sm" data-action="day" data-delta="1">Next →</button>${can('visits:write') ? '<button class="btn btn-sm btn-primary" data-action="new-visit">New visit</button>' : ''}`)}
  <div class="card board"><div class="board-grid">
    <div class="board-hours"><span></span>${Array.from({ length: 16 }, (_, i) => `<span>${String(H0 + i).padStart(2, '0')}:00</span>`).join('')}</div>
    ${unassigned.length ? `<div class="board-row"><div class="board-name">Unassigned<small>${unassigned.length} need coverage</small></div><div class="board-track">${nowLine}${unassigned.map(block).join('')}</div></div>` : ''}
    ${rows.map((c) => `<div class="board-row"><div class="board-name">${esc(c.name)}<small>${esc(c.role)} · ${esc(c.homeZone)}</small></div><div class="board-track">${offBlocks(c)}${nowLine}${visits.filter((v) => v.caregiverId === c.id && v.status !== 'cancelled').map(block).join('')}</div></div>`).join('')}
  </div>
  <div class="legend"><span style="--sw:var(--teal-soft)">Scheduled</span><span style="--sw:var(--green-soft)">Completed</span><span style="--sw:var(--red-soft)">Critical finding</span><span style="--sw:var(--amber-soft)">High finding</span><span style="--sw:var(--blue-soft)">Medium finding</span><span style="--sw:#e9ebee">Outside availability / leave</span></div>
  </div>`;
};

async function visitDrawer(id) {
  const [visits, conflicts] = await Promise.all([api('GET', '/api/visits'), can('visits:read') ? api('GET', '/api/conflicts') : []]);
  const v = visits.find((x) => x.id === id);
  if (!v) return toast('Visit not found', true);
  const related = conflicts.filter((f) => f.refs.visitIds?.includes(id));
  const c = v.confirmation || {};
  const recordDone = Object.keys(RECORD_FIELDS).filter((k) => v.record?.[k]).length;
  const canConfirm = can('confirmations:write') || (can('confirmations:write_own') && v.caregiverId === state.session.user.caregiverId);
  let suggestions = [];
  if (can('visits:write') && v.status !== 'completed' && v.status !== 'cancelled') suggestions = await api('GET', `/api/visits/${id}/suggestions`);
  openDrawer(`
    <h2 id="drawer-title" tabindex="-1">${esc(v.client?.label)} · ${esc(v.serviceType)}</h2>
    <div>${statusPill(v.status)} <span class="pill gray">${esc(v.id)}</span></div>
    <dl class="kv">
      <dt>When</dt><dd>${fmtDay(v.start)}, ${fmtTime(v.start)}–${fmtTime(v.end)}</dd>
      <dt>Caregiver</dt><dd>${v.caregiverName ? esc(v.caregiverName) : '<strong style="color:var(--red)">Unassigned</strong>'}</dd>
      <dt>Zone</dt><dd>${esc(v.client?.zone)}</dd>
      <dt>Requirements</dt><dd>${esc([...(v.client?.requiredCredentials || []), ...(v.requiredCredentials || [])].join(', ') || 'None recorded')}</dd>
      <dt>Language pref.</dt><dd>${esc(v.client?.preferredLanguage || '—')}</dd>
      <dt>Check-in</dt><dd>${c.checkIn ? `${fmtTime(c.checkIn)} · ${esc(c.method || '')}` : '<span class="muted">Not recorded</span>'}</dd>
      <dt>Check-out</dt><dd>${c.checkOut ? `${fmtTime(c.checkOut)} · ${esc(c.method || '')}` : '<span class="muted">Not recorded</span>'}</dd>
      ${c.manualReason ? `<dt>Manual reason</dt><dd>${esc(c.manualReason)}</dd>` : ''}
      <dt>Record</dt><dd>${recordDone}/3 administrative fields complete</dd>
      ${v.note ? `<dt>Note</dt><dd>${esc(v.note)}</dd>` : ''}
    </dl>
    ${related.length ? `<div class="section-label">Findings on this visit</div>${related.map((f) => `<div class="list-item">${sevPill(f.severity)}<div class="grow"><div class="t">${esc(f.title)}</div><div class="d">${esc(f.detail)}</div><div class="tiny muted" style="margin-top:2px">Rule: ${esc(f.basis)}</div></div></div>`).join('')}` : ''}
    ${canConfirm && v.status !== 'cancelled' ? `
      <div class="section-label">Confirmation</div>
      ${can('confirmations:write') ? '<div class="field"><label for="m-reason">Reason for manual entry</label><input id="m-reason" type="text" value="Confirmed by phone with caregiver" maxlength="160"></div>' : ''}
      <div class="actions">
        ${!c.checkIn ? `<button class="btn btn-sm btn-teal" data-action="confirm" data-id="${v.id}" data-type="check_in">Record check-in</button>` : ''}
        ${c.checkIn && !c.checkOut ? `<button class="btn btn-sm btn-teal" data-action="confirm" data-id="${v.id}" data-type="check_out">Record check-out</button>` : ''}
      </div>
      ${c.checkOut ? `<div class="section-label">Administrative record</div>${Object.entries(RECORD_FIELDS).map(([k, label]) => `<label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" data-action="record" data-id="${v.id}" data-field="${k}" ${v.record?.[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}` : ''}` : ''}
    ${can('visits:write') && v.status !== 'completed' && v.status !== 'cancelled' ? `
      <div class="section-label">Assignment</div>
      ${suggestions.length ? `<p class="small muted" style="margin:0 0 6px">Ranked by availability, credentials, zone, language, prior visits and weekly hours. You decide.</p>${suggestions.map((s) => `<div class="list-item"><div class="grow"><div class="t">${esc(s.name)} <span class="tiny muted">score ${s.score}</span></div><div class="d">${s.reasons.map(esc).join(' · ')}</div></div>${s.caregiverId === v.caregiverId ? '<span class="pill green">assigned</span>' : `<button class="btn btn-sm" data-action="assign" data-id="${v.id}" data-cg="${s.caregiverId}">Assign</button>`}</div>`).join('')}` : '<p class="small muted">No eligible caregivers without blocking conflicts.</p>'}
      <div class="actions">${v.caregiverId ? `<button class="btn btn-sm" data-action="assign" data-id="${v.id}" data-cg="">Unassign</button>` : ''}<button class="btn btn-sm" data-action="cancel-visit" data-id="${v.id}">Cancel visit</button></div>` : ''}
    ${can('incidents:create') ? `<div class="actions" style="margin-top:20px"><button class="btn btn-sm btn-ghost" data-action="new-incident" data-visit="${v.id}">Report an operational incident for this visit</button></div>` : ''}
  `);
}

function newVisitDrawer() {
  Promise.all([api('GET', '/api/clients'), api('GET', '/api/caregivers')]).then(([clients, cgs]) => {
    const d = new Date(state.scheduleDay); d.setHours(9, 0, 0, 0);
    const local = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    openDrawer(`<h2 id="drawer-title" tabindex="-1">New visit</h2>
      <form data-form="new-visit">
        <div class="field"><label for="nv-client">Client</label><select id="nv-client" name="clientId" required>${clients.map((c) => `<option value="${c.id}">${esc(c.label)} · ${esc(c.zone)}${c.requiredCredentials.length ? ` · needs ${esc(c.requiredCredentials.join(', '))}` : ''}</option>`).join('')}</select></div>
        <div class="field"><label for="nv-start">Start</label><input id="nv-start" type="datetime-local" name="start" value="${local(d.getTime())}" required></div>
        <div class="field"><label for="nv-end">End</label><input id="nv-end" type="datetime-local" name="end" value="${local(d.getTime() + 2 * HOUR)}" required></div>
        <div class="field"><label for="nv-type">Service type</label><select id="nv-type" name="serviceType"><option>Personal care visit</option><option>Companion visit</option><option>Respite visit</option><option>Homemaker visit</option></select></div>
        <div class="field"><label for="nv-cg">Caregiver</label><select id="nv-cg" name="caregiverId"><option value="">Leave unassigned</option>${cgs.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.homeZone)}</option>`).join('')}</select><div class="hint">The visit is checked for conflicts as soon as it is saved.</div></div>
        <button class="btn btn-primary" type="submit">Create visit</button>
      </form>`);
  });
}

// --- Coverage ----------------------------------------------------------------

VIEWS.coverage = async () => {
  const now = Date.now();
  const [visits, conflicts] = await Promise.all([
    api('GET', `/api/visits?from=${new Date(now - 2 * HOUR).toISOString()}&to=${new Date(now + 7 * DAY).toISOString()}`),
    api('GET', '/api/conflicts'),
  ]);
  const open = visits.filter((v) => !v.caregiverId && v.status === 'scheduled');
  const byVisit = new Map(visits.map((v) => [v.id, v]));
  const scheduling = conflicts.filter((f) => f.code !== 'missing_coverage');
  return `${pageHead('Assignment & coverage', 'Uncovered visits for the next 7 days and scheduling conflicts across all upcoming assignments.')}
  <div class="cols-2">
    <div class="card"><h2>Uncovered visits <span class="pill ${open.length ? 'red' : 'green'}">${open.length}</span></h2>
      ${open.length ? open.map((v) => `<div class="list-item"><div class="grow"><div class="t">${fmtDay(v.start)} ${fmtTime(v.start)}–${fmtTime(v.end)}</div><div class="d">${esc(v.client?.label)} · ${esc(v.client?.zone)}${v.client?.requiredCredentials?.length ? ` · needs ${esc(v.client.requiredCredentials.join(', '))}` : ''}${v.note ? ` · ${esc(v.note)}` : ''}</div></div><button class="btn btn-sm btn-teal" data-action="visit" data-id="${v.id}">Find coverage</button></div>`).join('') : '<div class="empty">Every visit in the next 7 days has a caregiver.</div>'}
    </div>
    <div class="card"><h2>Scheduling conflicts <span class="pill">${scheduling.length}</span></h2>
      ${scheduling.length ? scheduling.map((f) => `<div class="list-item clickable" data-action="visit" data-id="${f.refs.visitIds?.[0] || ''}">${sevPill(f.severity)}<div class="grow"><div class="t">${esc(f.title)}</div><div class="d">${esc(f.detail)}${f.refs.visitIds?.[0] && byVisit.get(f.refs.visitIds[0]) ? ` · ${fmtDay(byVisit.get(f.refs.visitIds[0]).start)}` : ''}</div></div></div>`).join('') : '<div class="empty">No conflicts detected.</div>'}
    </div>
  </div>`;
};

// --- Confirmations -----------------------------------------------------------

VIEWS.confirmations = async () => {
  const now = Date.now();
  const visits = await api('GET', `/api/visits?from=${new Date(now - 3 * DAY).toISOString()}&to=${new Date(now + HOUR).toISOString()}`);
  const relevant = visits.filter((v) => v.status !== 'cancelled' && ms(v.start) < now).reverse();
  const queue = can('queue:read') ? (state.cache.queue || await api('GET', '/api/queue')) : [];
  const attention = queue.filter((i) => ['confirmation', 'records'].includes(i.category) && i.status !== 'resolved');
  const cell = (t) => (t ? fmtTime(t) : '<span class="pill amber">missing</span>');
  return `${pageHead('Visit confirmation records', 'Check-in/check-out confirmations and administrative record completeness for the last 72 hours.')}
  ${attention.length ? `<div class="card" style="margin-bottom:20px"><h2>Flagged for supervisor review <span class="pill red">${attention.length}</span></h2>${attention.map(queueRow).join('')}</div>` : ''}
  <div class="card table-wrap"><table>
    <thead><tr><th>Visit</th><th>Caregiver</th><th>Scheduled</th><th>Check-in</th><th>Check-out</th><th>Method</th><th>Record</th></tr></thead>
    <tbody>${relevant.map((v) => {
      const done = Object.keys(RECORD_FIELDS).filter((k) => v.record?.[k]).length;
      const ended = ms(v.end) < now;
      return `<tr class="clickable" data-action="visit" data-id="${v.id}">
        <td><strong>${esc(v.client?.label)}</strong><div class="tiny muted">${esc(v.id)}</div></td>
        <td>${esc(v.caregiverName || 'Unassigned')}</td>
        <td>${fmtDay(v.start)}<div class="tiny muted">${fmtTime(v.start)}–${fmtTime(v.end)}</div></td>
        <td>${cell(v.confirmation?.checkIn)}</td>
        <td>${ended || v.confirmation?.checkOut ? cell(v.confirmation?.checkOut) : '<span class="muted small">in progress</span>'}</td>
        <td class="small">${esc(v.confirmation?.method || '—')}</td>
        <td>${v.confirmation?.checkOut ? `<span class="pill ${done === 3 ? 'green' : 'amber'}">${done}/3</span>` : '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
};

// --- Caregiver self-service --------------------------------------------------

VIEWS['my-visits'] = async () => {
  const now = Date.now();
  const visits = await api('GET', `/api/visits?from=${new Date(now - 2 * DAY).toISOString()}&to=${new Date(now + 3 * DAY).toISOString()}`);
  const list = visits.filter((v) => v.status !== 'cancelled');
  return `${pageHead('My visits', 'Your schedule for the next few days. Check in when you arrive and check out when you leave.')}
  <div class="card">${list.length ? list.map((v) => `<div class="list-item clickable" data-action="visit" data-id="${v.id}"><div class="grow"><div class="t">${fmtDay(v.start)} · ${fmtTime(v.start)}–${fmtTime(v.end)}</div><div class="d">${esc(v.client?.label)} · ${esc(v.client?.zone)} · ${esc(v.serviceType)}</div></div>${v.confirmation?.checkOut ? '<span class="pill green">confirmed</span>' : v.confirmation?.checkIn ? '<span class="pill teal">checked in</span>' : ms(v.start) < now ? '<span class="pill amber">needs check-in</span>' : statusPill(v.status)}</div>`).join('') : '<div class="empty">No visits scheduled.</div>'}</div>
  <p class="small muted" style="margin-top:12px">Something went wrong on a visit (no access, schedule problem)? Open the visit and report an operational incident. For emergencies call 911, then the on-call supervisor.</p>`;
};

// --- Team & availability -----------------------------------------------------

VIEWS.team = async () => {
  const cgs = await api('GET', '/api/caregivers');
  state.cache.caregivers = cgs;
  return `${pageHead('Care team directory', `${cgs.length} caregivers · contact details are masked; full records live in your HR system.`)}
  <div class="card table-wrap"><table>
    <thead><tr><th>Name</th><th>Role</th><th>Home zone</th><th>Credentials</th><th>Languages</th><th>This week</th><th>Contact</th></tr></thead>
    <tbody>${cgs.map((c) => `<tr class="clickable" data-action="caregiver" data-id="${c.id}">
      <td><strong>${esc(c.name)}</strong><div class="tiny muted">${esc(c.employment)} · since ${esc(c.hireDate)}</div></td>
      <td>${esc(c.role)}</td><td>${esc(c.homeZone)}</td>
      <td>${c.credentials.map((x) => `<span class="pill" style="margin:1px">${esc(x)}</span>`).join('')}</td>
      <td class="small">${esc(c.languages.join(', '))}</td>
      <td><span class="pill ${c.weekHours > c.maxWeeklyHours ? 'red' : 'gray'}">${c.weekHours} / ${c.maxWeeklyHours} h</span></td>
      <td class="small mono">${esc(c.phoneMasked)}</td></tr>`).join('')}</tbody></table></div>`;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

VIEWS.availability = async () => {
  const cgs = await api('GET', '/api/caregivers');
  state.cache.caregivers = cgs;
  const week0 = startOfToday();
  const dates = Array.from({ length: 7 }, (_, i) => week0 + i * DAY);
  return `${pageHead('Caregiver availability', 'Recurring weekly windows and recorded time off for the next 7 days.')}
  <div class="card board"><div class="avail-grid">
    <div></div>${dates.map((d) => `<div class="h">${fmtDay(d)}</div>`).join('')}
    ${cgs.map((c) => `<div class="board-name clickable" data-action="caregiver" data-id="${c.id}">${esc(c.name)}<small>${esc(c.role)} · ${esc(c.homeZone)}</small></div>${dates.map((d) => {
      const leave = c.timeOff.find((o) => ms(o.start) < d + DAY && ms(o.end) > d);
      const w = c.availability.find((x) => x.day === new Date(d).getDay());
      return leave ? `<div class="avail-cell leave">Leave</div>` : w ? `<div class="avail-cell on">${w.start}–${w.end}</div>` : '<div class="avail-cell">—</div>';
    }).join('')}`).join('')}
  </div></div>
  <p class="small muted" style="margin-top:10px">${can('availability:write') ? 'Select a caregiver to edit availability or add time off.' : 'View only for your role.'}</p>`;
};

async function caregiverDrawer(id) {
  const cgs = state.cache.caregivers || await api('GET', '/api/caregivers');
  const c = cgs.find((x) => x.id === id);
  const edit = can('availability:write');
  openDrawer(`<h2 id="drawer-title" tabindex="-1">${esc(c.name)}</h2>
    <div><span class="pill teal">${esc(c.role)}</span> <span class="pill gray">${esc(c.employment)}</span></div>
    <dl class="kv"><dt>Home zone</dt><dd>${esc(c.homeZone)}</dd><dt>Credentials</dt><dd>${esc(c.credentials.join(', '))}</dd><dt>Languages</dt><dd>${esc(c.languages.join(', '))}</dd><dt>Weekly limit</dt><dd>${c.maxWeeklyHours} h (scheduled ${c.weekHours} h)</dd><dt>Contact</dt><dd class="mono">${esc(c.phoneMasked)}</dd></dl>
    <div class="section-label">Weekly availability</div>
    <form data-form="availability" data-id="${c.id}">
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => { const w = c.availability.find((x) => x.day === d); return `<div style="display:grid;grid-template-columns:70px 1fr 1fr;gap:8px;align-items:center;margin-bottom:6px"><label style="margin:0;font-weight:500;display:flex;gap:6px;align-items:center"><input type="checkbox" name="on-${d}" ${w ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${DAYS[d]}</label><input type="time" name="start-${d}" value="${w?.start || '09:00'}" ${edit ? '' : 'disabled'} aria-label="${DAYS[d]} start"><input type="time" name="end-${d}" value="${w?.end || '17:00'}" ${edit ? '' : 'disabled'} aria-label="${DAYS[d]} end"></div>`; }).join('')}
      ${edit ? '<button class="btn btn-sm btn-primary" type="submit">Save availability</button>' : ''}
    </form>
    <div class="section-label">Time off</div>
    ${c.timeOff.length ? c.timeOff.map((o) => `<div class="list-item"><div class="grow"><div class="t">${fmtDateTime(o.start)} → ${fmtDateTime(o.end)}</div><div class="d">${esc(o.reason)}</div></div></div>`).join('') : '<p class="small muted">None recorded.</p>'}
    ${edit ? `<form data-form="time-off" data-id="${c.id}" style="margin-top:8px"><div class="cols-2" style="gap:8px"><div class="field"><label for="to-s">From</label><input id="to-s" type="datetime-local" name="start" required></div><div class="field"><label for="to-e">To</label><input id="to-e" type="datetime-local" name="end" required></div></div><div class="field"><label for="to-r">Reason (brief, non-medical)</label><input id="to-r" type="text" name="reason" maxlength="80" placeholder="e.g. Approved leave"></div><button class="btn btn-sm" type="submit">Add time off</button></form>` : ''}`);
}

// --- Queue -------------------------------------------------------------------

VIEWS.queue = async () => {
  const q = await api('GET', '/api/queue');
  state.cache.queue = q;
  const f = state.queueFilter;
  const items = q.filter((i) => (f.status === 'all' || (f.status === 'active' ? i.status !== 'resolved' : i.status === f.status)) && (!f.category || i.category === f.category) && (!f.severity || i.severity === f.severity));
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  return `${pageHead('Supervisor review queue', 'Overdue follow-ups, unresolved scheduling issues and incomplete visit records. Items are never closed automatically — a person resolves each one with a note.',
    `<select data-filter="status" aria-label="Status">${opt('active', f.status, 'Open & acknowledged')}${opt('open', f.status, 'Open')}${opt('acknowledged', f.status, 'Acknowledged')}${opt('resolved', f.status, 'Resolved')}${opt('all', f.status, 'All')}</select>
     <select data-filter="category" aria-label="Category">${opt('', f.category, 'All categories')}${opt('confirmation', f.category, 'Confirmations')}${opt('records', f.category, 'Records')}${opt('scheduling', f.category, 'Scheduling')}${opt('coverage', f.category, 'Coverage')}${opt('follow_up', f.category, 'Follow-ups')}</select>
     <select data-filter="severity" aria-label="Severity">${opt('', f.severity, 'All severities')}${opt('critical', f.severity, 'Critical')}${opt('high', f.severity, 'High')}${opt('medium', f.severity, 'Medium')}${opt('low', f.severity, 'Low')}</select>`)}
  <div class="card table-wrap">${items.length ? `<table><thead><tr><th>Severity</th><th>Item</th><th>Category</th><th>Due</th><th>Owner</th><th>Status</th></tr></thead><tbody>
    ${items.map((i) => `<tr class="clickable" data-action="queue-item" data-id="${i.id}">
      <td>${sevPill(i.severity)}</td>
      <td><strong>${esc(i.title)}</strong><div class="tiny muted">${esc(i.label)} · raised ${relative(i.createdAt)}${!i.conditionActive && i.status !== 'resolved' ? ' · <span class="pill green">condition cleared</span>' : ''}</div></td>
      <td class="small">${esc(i.category.replace('_', ' '))}</td>
      <td class="small">${i.status === 'resolved' ? `resolved ${relative(i.resolvedAt)}` : i.overdue ? `<strong style="color:var(--red)">overdue ${relative(i.dueAt)}</strong>` : relative(i.dueAt)}</td>
      <td class="small">${esc(i.assigneeName || '—')}</td>
      <td>${statusPill(i.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No items match these filters.</div>'}</div>`;
};

async function queueDrawer(id) {
  const q = await api('GET', '/api/queue');
  state.cache.queue = q;
  const i = q.find((x) => x.id === id);
  if (!i) return toast('Item not found', true);
  const upd = can('queue:update');
  const office = state.staff.filter((u) => ['supervisor', 'scheduler', 'admin'].includes(u.role));
  openDrawer(`<h2 id="drawer-title" tabindex="-1">${esc(i.title)}</h2>
    <div>${sevPill(i.severity)} ${statusPill(i.status)} <span class="pill gray">${esc(i.label)}</span> ${i.overdue ? '<span class="pill red">overdue</span>' : ''}</div>
    <dl class="kv">
      <dt>Detail</dt><dd>${esc(i.detail)}</dd>
      <dt>Raised</dt><dd>${fmtDateTime(i.createdAt)} (${relative(i.createdAt)})</dd>
      <dt>Follow-up target</dt><dd>${fmtDateTime(i.dueAt)}</dd>
      <dt>Owner</dt><dd>${esc(i.assigneeName || 'Unassigned')}</dd>
      <dt>Condition</dt><dd>${i.conditionActive ? 'Still present in records' : '<span class="pill green">No longer detected</span> — confirm and resolve'}</dd>
      ${i.refs?.visitIds?.length ? `<dt>Visits</dt><dd>${i.refs.visitIds.map((v) => `<button class="btn btn-sm" data-action="visit" data-id="${v}">${esc(v)}</button>`).join(' ')}</dd>` : ''}
      ${i.refs?.incidentId ? `<dt>Incident</dt><dd><a href="#/incidents" data-close>${esc(i.refs.incidentId)}</a></dd>` : ''}
      ${i.resolution ? `<dt>Resolution</dt><dd>${esc(i.resolution)}</dd>` : ''}
    </dl>
    <div class="section-label">Why this was raised</div>
    <div class="basis">${esc(i.basis)}</div>
    ${upd ? `<div class="section-label">Actions</div>
      <div class="field"><label for="q-note">Note</label><textarea id="q-note" placeholder="What did you do or find out? Required to resolve." maxlength="500"></textarea></div>
      <div class="actions">
        ${i.status === 'open' ? `<button class="btn btn-sm" data-action="queue-act" data-id="${i.id}" data-act="acknowledge">Acknowledge</button>` : ''}
        ${i.status !== 'resolved' ? `<select id="q-assignee" style="width:auto" aria-label="Assign to">${office.map((u) => `<option value="${u.id}" ${u.id === (i.assigneeId || state.session.user.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select><button class="btn btn-sm" data-action="queue-act" data-id="${i.id}" data-act="assign">Assign</button>` : ''}
        <button class="btn btn-sm" data-action="queue-act" data-id="${i.id}" data-act="comment">Add note</button>
        ${i.status !== 'resolved' ? `<button class="btn btn-sm btn-primary" data-action="queue-act" data-id="${i.id}" data-act="resolve">Resolve</button>` : `<button class="btn btn-sm" data-action="queue-act" data-id="${i.id}" data-act="reopen">Reopen</button>`}
      </div>` : ''}
    <div class="section-label">History</div>
    <div class="history">${i.history.slice().reverse().map((h) => `<div><strong>${esc(h.action.replace(/_/g, ' '))}</strong> · ${esc(staffName(h.by))} · <span class="muted">${fmtDateTime(h.at)}</span>${h.note ? `<div class="small muted">${esc(h.note)}</div>` : ''}</div>`).join('')}</div>`);
}

// --- Handover workspace ------------------------------------------------------

const CATS = { scheduling: 'Scheduling', staffing: 'Staffing', access: 'Home access', documentation: 'Documentation', follow_up: 'Follow-up', logistics: 'Logistics', family_request: 'Family request', care_observation: 'Care observation (restricted)' };

VIEWS.handovers = async () => {
  const [notes, summaries] = await Promise.all([api('GET', '/api/handovers'), api('GET', '/api/summaries')]);
  state.cache.summaries = summaries;
  const reviewer = can('summary:approve') || can('summary:generate');
  return `${pageHead('Administrative handover workspace', 'Shift notes for office staff. Administrative content only — clinical observations belong in the clinical record.')}
  <div class="cols">
    <div>
      ${can('handover:write') ? `<div class="card" style="margin-bottom:20px"><h2>Add a handover note</h2>
        <form data-form="handover">
          <div class="cols-2" style="gap:12px"><div class="field"><label for="hn-cat">Category</label><select id="hn-cat" name="category">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div class="field"><label>Audience</label><div style="display:flex;gap:12px;flex-wrap:wrap;padding-top:6px">${['scheduler', 'supervisor', 'caregiver'].map((r) => `<label style="font-weight:400;display:flex;gap:4px;align-items:center;margin:0"><input type="checkbox" name="aud-${r}" ${r !== 'caregiver' ? 'checked' : ''}>${r}</label>`).join('')}</div></div></div>
          <div class="field"><label for="hn-text">Note</label><textarea id="hn-text" name="text" required maxlength="2000" placeholder="e.g. Family asked to move Thursday visit to 2 PM from next week."></textarea><div class="hint">Avoid health details, codes and phone numbers. Care observations are restricted and never summarized.</div></div>
          <label style="font-weight:400;display:flex;gap:6px;align-items:center"><input type="checkbox" name="requiresFollowUp"> Needs follow-up</label>
          <button class="btn btn-primary btn-sm" type="submit" style="margin-top:10px">Add note</button>
        </form></div>` : ''}
      <div class="card"><h2>Recent notes <span class="pill">${notes.length}</span></h2>
        ${notes.map((n) => `<div class="list-item"><div class="grow"><div class="d" style="margin-bottom:2px"><span class="pill ${n.restricted ? 'red' : 'teal'}">${esc(CATS[n.category] || n.category)}</span> ${n.requiresFollowUp ? '<span class="pill amber">follow-up</span>' : ''} <span class="tiny muted">${esc(n.id)} · ${esc(n.authorName)} · ${relative(n.createdAt)} · to ${esc(n.audience.join(', '))}</span></div><div class="small">${esc(n.text)}</div></div></div>`).join('')}
      </div>
    </div>
    <div class="card" style="align-self:start"><h2>Handover summaries</h2>
      ${can('summary:generate') ? `<p class="small muted">Organizes the last 24 hours of administrative notes you are authorized to read into a short brief. Drafts stay hidden until a different authorized supervisor approves them.</p><button class="btn btn-teal btn-sm" data-action="gen-summary">Draft summary from last 24 h</button>` : ''}
      <div style="margin-top:12px">${summaries.length ? summaries.map((s) => `<div class="list-item clickable" data-action="summary" data-id="${s.id}"><div class="grow"><div class="t">${esc(s.id)} ${reviewer ? `· ${s.sourceNoteIds?.length ?? 0} notes` : ''}</div><div class="d">${relative(s.createdAt)}${s.requestedByName ? ` · drafted for ${esc(s.requestedByName)}` : ''}${s.reviewerName ? ` · reviewed by ${esc(s.reviewerName)}` : ''}</div></div>${statusPill(s.status)}</div>`).join('') : '<div class="empty">No summaries yet.</div>'}</div>
    </div>
  </div>`;
};

function summaryDrawer(id) {
  const s = state.cache.summaries.find((x) => x.id === id);
  const approver = can('summary:approve');
  const editable = ['pending_review', 'needs_edit'].includes(s.status) && (approver || can('summary:generate'));
  openDrawer(`<h2 id="drawer-title" tabindex="-1">Handover summary ${esc(s.id)}</h2>
    <div>${statusPill(s.status)} ${s.provider ? `<span class="pill gray">${esc(s.provider)}</span>` : ''}</div>
    ${s.status === 'approved' ? `<div class="approved-banner" style="margin-top:12px">Approved by ${esc(s.reviewerName)} · ${fmtDateTime(s.review.at)}</div><div class="summary-text">${esc(s.finalText)}</div>` : `
      <div class="draft-banner" style="margin-top:12px">DRAFT — AI-assisted administrative summary. Not shared with staff until approved.</div>
      ${s.flags?.length ? `<div class="alert err" style="background:var(--red-soft);color:var(--red);padding:10px;border-radius:8px;font-size:.85rem">Possible non-administrative language: <strong>${s.flags.map(esc).join(', ')}</strong>. Edit it out before approval.</div>` : ''}
      ${editable ? `<textarea id="sum-text" style="min-height:260px;font-size:.9rem">${esc(s.draft)}</textarea>` : `<div class="summary-text">${esc(s.draft)}</div>`}`}
    ${s.sourceNoteIds ? `<div class="section-label">Sources</div><p class="small">${s.sourceNoteIds.map((n) => `<span class="pill gray" style="margin:1px">${esc(n)}</span>`).join('')}</p>` : ''}
    ${s.excludedNotes?.length ? `<div class="section-label">Excluded from AI</div>${s.excludedNotes.map((e) => `<div class="small"><span class="pill red">${esc(e.id)}</span> ${esc(e.reason)}</div>`).join('')}` : ''}
    ${s.providerNote ? `<p class="tiny muted">${esc(s.providerNote)}</p>` : ''}
    ${s.disclaimer ? `<p class="tiny muted" style="margin-top:12px">${esc(s.disclaimer)}</p>` : ''}
    ${editable ? `<div class="actions">
      <button class="btn btn-sm" data-action="sum-act" data-id="${s.id}" data-act="edit">Save edits</button>
      ${approver ? `<button class="btn btn-sm btn-primary" data-action="sum-act" data-id="${s.id}" data-act="approve">Approve & share</button><button class="btn btn-sm" data-action="sum-act" data-id="${s.id}" data-act="reject">Reject</button>` : '<span class="small muted">A supervisor must approve this draft.</span>'}
    </div>${approver && s.requestedBy === state.session.user.id ? '<p class="tiny muted">You drafted this one, so a different reviewer must approve it.</p>' : ''}` : ''}`);
}

// --- Incidents ---------------------------------------------------------------

VIEWS.incidents = async () => {
  const list = await api('GET', '/api/incidents');
  state.cache.incidents = list;
  return `${pageHead('Incident escalation', 'Operational incidents: missed visits, access problems, property and conduct reports. Report → triage → escalate → resolve.', can('incidents:create') ? '<button class="btn btn-primary btn-sm" data-action="new-incident">Report incident</button>' : '')}
  <div class="note-box small" style="margin-bottom:16px"><strong>Emergencies:</strong> call 911 first, then the on-call clinical lead. CareQueue tracks the administrative follow-up; it does not assess clinical risk or safety.</div>
  <div class="card">${list.map((i) => `<div class="list-item clickable" data-action="incident" data-id="${i.id}">
    ${sevPill(i.severity)}<div class="grow"><div class="t">${esc(i.title)}</div><div class="d">${esc(i.id)} · ${esc(i.category.replace(/_/g, ' '))} · reported ${relative(i.reportedAt)}${i.ownerName ? ` · owner ${esc(i.ownerName)}` : ''}${i.status !== 'resolved' ? ` · follow-up ${ms(i.followUpDueAt) < Date.now() ? '<strong style="color:var(--red)">overdue</strong>' : relative(i.followUpDueAt)}` : ''}${i.escalationLevel ? ` · level ${i.escalationLevel}` : ''}</div></div>${statusPill(i.status)}</div>`).join('')}</div>`;
};

function incidentDrawer(id) {
  const i = state.cache.incidents.find((x) => x.id === id);
  const manage = can('incidents:manage');
  const office = state.staff.filter((u) => ['supervisor', 'admin'].includes(u.role));
  const next = { reported: ['triaged', 'escalated', 'resolved'], triaged: ['escalated', 'resolved'], escalated: ['escalated', 'resolved'], resolved: ['reopened'] }[i.status];
  const label = { triaged: 'Mark triaged', escalated: 'Escalate', resolved: 'Resolve', reopened: 'Reopen' };
  openDrawer(`<h2 id="drawer-title" tabindex="-1">${esc(i.title)}</h2>
    <div>${sevPill(i.severity)} ${statusPill(i.status)} <span class="pill gray">${esc(i.id)}</span>${i.escalationLevel ? ` <span class="pill red">Escalation level ${i.escalationLevel}</span>` : ''}</div>
    <dl class="kv"><dt>Category</dt><dd>${esc(i.category.replace(/_/g, ' '))}</dd><dt>Reported</dt><dd>${fmtDateTime(i.reportedAt)} by ${esc(staffName(i.reportedBy))}</dd><dt>Owner</dt><dd>${esc(i.ownerName || 'Unassigned')}</dd>${i.status !== 'resolved' ? `<dt>Follow-up due</dt><dd>${fmtDateTime(i.followUpDueAt)}</dd>` : ''}<dt>Description</dt><dd>${esc(i.description)}</dd></dl>
    ${manage ? `<div class="section-label">Next step</div>
      <div class="field"><label for="inc-note">Note</label><textarea id="inc-note" maxlength="1000" placeholder="Required to escalate or resolve."></textarea></div>
      <div class="field"><label for="inc-owner">Owner</label><select id="inc-owner">${office.map((u) => `<option value="${u.id}" ${u.id === (i.ownerId || state.session.user.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
      <div class="actions">${next.map((a) => `<button class="btn btn-sm ${a === 'resolved' ? 'btn-primary' : ''}" data-action="inc-act" data-id="${i.id}" data-act="${a}">${label[a]}</button>`).join('')}</div>` : ''}
    <div class="section-label">Timeline</div>
    <div class="history">${i.timeline.slice().reverse().map((t) => `<div><strong>${esc(t.action)}</strong> · ${esc(t.byName)} · <span class="muted">${fmtDateTime(t.at)}</span>${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ''}</div>`).join('')}</div>`);
}

function newIncidentDrawer(visitId) {
  openDrawer(`<h2 id="drawer-title" tabindex="-1">Report an operational incident</h2>
    <p class="small muted">For administrative follow-up (missed visits, access, property, conduct, scheduling). Describe what happened factually — no diagnoses or health assessments. For emergencies call 911.</p>
    <form data-form="incident" data-visit="${esc(visitId || '')}">
      <div class="field"><label for="in-title">Title</label><input id="in-title" type="text" name="title" required maxlength="120"></div>
      <div class="cols-2" style="gap:12px"><div class="field"><label for="in-cat">Category</label><select id="in-cat" name="category"><option value="missed_visit">Missed visit</option><option value="access_issue">Access issue</option><option value="scheduling">Scheduling</option><option value="property">Property</option><option value="conduct">Conduct</option><option value="other">Other</option></select></div>
      <div class="field"><label for="in-sev">Severity</label><select id="in-sev" name="severity"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></div></div>
      <div class="field"><label for="in-desc">What happened</label><textarea id="in-desc" name="description" required maxlength="2000"></textarea></div>
      ${visitId ? `<p class="small muted">Linked to visit ${esc(visitId)}.</p>` : ''}
      <button class="btn btn-primary" type="submit">Submit report</button>
    </form>`);
}

// --- Reports -----------------------------------------------------------------

VIEWS.reports = async () => {
  const r = await api('GET', `/api/reports/operations?days=${state.reportDays}`);
  const max = Math.max(1, ...r.daily.map((d) => d.scheduled));
  const maxCode = Math.max(1, ...r.issues.byCode.map((x) => x.count));
  return `${pageHead('Operations reporting', `${fmtDay(r.period.from)} – ${fmtDay(r.period.to)}`,
    `<select data-filter="reportDays" aria-label="Period">${[7, 14, 30].map((d) => `<option value="${d}" ${d === state.reportDays ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>`)}
  <div class="stats">
    <div class="stat"><div class="label">Visits confirmed</div><div class="value">${r.completion.confirmedPct}%</div><div class="sub">${r.completion.confirmed} of ${r.completion.scheduled}</div></div>
    <div class="stat"><div class="label">Records complete</div><div class="value">${r.completion.recordsCompletePct}%</div><div class="sub">of confirmed visits</div></div>
    <div class="stat ${r.completion.unconfirmed ? 'alert-red' : ''}"><div class="label">Unconfirmed visits</div><div class="value">${r.completion.unconfirmed}</div><div class="sub">no check-in or out</div></div>
    <div class="stat"><div class="label">Coverage, next 7 days</div><div class="value">${r.coverage.coveragePct}%</div><div class="sub">${r.coverage.assigned} of ${r.coverage.upcomingVisits} assigned · ${r.coverage.scheduledHours} h</div></div>
    <div class="stat"><div class="label">Issues raised</div><div class="value">${r.issues.raised}</div><div class="sub">${r.issues.open} open · ${r.issues.overdue} overdue</div></div>
    <div class="stat"><div class="label">Avg. time to resolve</div><div class="value">${r.issues.avgResolutionHours ?? '—'}${r.issues.avgResolutionHours != null ? '<small style="font-size:.9rem"> h</small>' : ''}</div><div class="sub">resolved in period</div></div>
  </div>
  <div class="cols-2">
    <div class="card"><h2>Daily visit confirmation</h2>
      <div class="bar-chart" role="img" aria-label="Daily scheduled vs confirmed visits">${r.daily.map((d) => `<div class="bar-col" title="${d.date}: ${d.confirmed}/${d.scheduled} confirmed"><div class="bar-stack" style="height:${(d.scheduled / max) * 100}%"><div class="ok" style="flex:${d.confirmed}"></div><div class="gap" style="flex:${d.scheduled - d.confirmed}"></div></div><small>${new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'narrow' })}</small></div>`).join('')}</div>
      <div class="legend"><span style="--sw:var(--teal)">Confirmed</span><span style="--sw:#e6b9b1">Not fully confirmed</span></div>
    </div>
    <div class="card"><h2>Issues by type</h2>
      ${r.issues.byCode.length ? r.issues.byCode.map((x) => `<div class="hbar"><span>${esc(x.label)}</span><div class="track"><div class="fill" style="width:${(x.count / maxCode) * 100}%"></div></div><strong>${x.count}</strong></div>`).join('') : '<div class="empty">No issues in this period.</div>'}
    </div>
  </div>
  <div class="cols-2" style="margin-top:20px">
    <div class="card"><h2>Recurring coordination problems</h2>
      ${r.recurring.length ? `<table><thead><tr><th>Pattern</th><th>Where</th><th>Count</th></tr></thead><tbody>${r.recurring.map((x) => `<tr><td>${esc(x.label)}</td><td class="small">${esc(x.kind)}: ${esc(x.name)}</td><td><strong>${x.count}</strong></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No recurring patterns.</div>'}
    </div>
    <div class="card"><h2>Summary</h2>
      <div class="draft-banner">${esc(r.narrativeStatus)}</div>
      ${r.narrative.map((l) => `<p class="small">${esc(l)}</p>`).join('')}
    </div>
  </div>`;
};

// --- Audit -------------------------------------------------------------------

VIEWS.audit = async () => {
  const [entries, verify] = await Promise.all([api('GET', '/api/audit'), api('GET', '/api/audit/verify')]);
  return `${pageHead('Audit log', 'Append-only record of sign-ins, changes, denied requests and sensitive views. Each entry is hash-chained to the previous one.',
    `<span class="pill ${verify.ok ? 'green' : 'red'}">${verify.ok ? `Chain verified · ${verify.entries} entries` : `Chain broken at entry ${verify.brokenAt}`}</span>`)}
  <div class="card table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Outcome</th><th>Hash</th></tr></thead><tbody>
    ${entries.map((e) => `<tr><td class="small">${fmtDateTime(e.at)}</td><td class="small"><strong>${esc(e.actorName)}</strong><div class="tiny muted">${esc(e.actorRole)}</div></td><td class="mono">${esc(e.action)}</td><td class="small">${esc(e.entity)}${e.entityId ? ` <span class="mono">${esc(e.entityId)}</span>` : ''}</td><td>${e.outcome === 'success' ? '<span class="pill green">ok</span>' : `<span class="pill red">${esc(e.outcome)}</span>`}</td><td class="mono tiny muted" title="${esc(e.hash)}">${esc(e.hash.slice(0, 10))}…</td></tr>`).join('')}
  </tbody></table></div>`;
};

// --- Settings ----------------------------------------------------------------

const RULE_FIELDS = [
  ['confirmationGraceMinutes', 'Confirmation grace period', 'minutes after scheduled start/end before a missing check-in/out is flagged'],
  ['recordCompletionHours', 'Record completion window', 'hours after check-out to complete timesheet, checklist and mileage'],
  ['coverageHorizonHours', 'Coverage horizon', 'hours ahead to flag unassigned visits'],
  ['travelBaseMinutes', 'Travel estimate, same zone', 'minutes'],
  ['travelPerZoneStepMinutes', 'Travel per zone step', 'minutes added per zone between visits'],
  ['travelBufferMinutes', 'Travel buffer', 'minutes added to every travel estimate'],
  ['defaultMaxWeeklyHours', 'Default weekly hour limit', 'used when a caregiver has no individual limit'],
  ['summaryReviewHours', 'Summary review target', 'hours before an unreviewed AI draft is surfaced'],
];
const RETENTION_FIELDS = [['handoverNotes', 'Handover notes'], ['aiSummaries', 'AI summary drafts'], ['resolvedQueueItems', 'Resolved queue items'], ['visitRecords', 'Visit records'], ['demoLeads', 'Website demo requests']];

VIEWS.settings = async () => {
  const s = await api('GET', '/api/settings');
  const edit = can('settings:write');
  const crm = can('crm:read') ? await api('GET', '/api/crm/outbox') : null;
  return `${pageHead('Rules & retention', 'Configure the thresholds the monitors use and how long each record type is kept.')}
  <div class="cols-2">
    <div class="card"><h2>Detection rules</h2>
      <form data-form="rules">${RULE_FIELDS.map(([k, label, hint]) => `<div class="field"><label for="r-${k}">${esc(label)}</label><input id="r-${k}" type="number" min="0" name="${k}" value="${s.rules[k]}" ${edit ? '' : 'disabled'}><div class="hint">${esc(hint)}</div></div>`).join('')}
        <div class="field"><label>Follow-up targets by severity</label><div class="small muted">${Object.entries(s.rules.followUpSlaHours).map(([k, v]) => `${k}: ${v} h`).join(' · ')}</div></div>
        ${edit ? '<button class="btn btn-primary btn-sm" type="submit">Save rules</button>' : ''}
      </form>
    </div>
    <div>
      <div class="card"><h2>Retention</h2>
        <form data-form="retention">${RETENTION_FIELDS.map(([k, label]) => `<div class="field"><label for="ret-${k}">${esc(label)}</label><input id="ret-${k}" type="number" min="1" name="${k}" value="${s.retention[k] ?? ''}" placeholder="Keep indefinitely" ${edit ? '' : 'disabled'}><div class="hint">days</div></div>`).join('')}
          <p class="tiny muted">Audit log retention (${s.retention.auditLog} days) is fixed by policy. Confirm record-keeping periods with counsel for each state you operate in.</p>
          ${edit ? '<div class="actions"><button class="btn btn-primary btn-sm" type="submit">Save retention</button><button class="btn btn-sm" type="button" data-action="retention" data-dry="1">Dry run</button><button class="btn btn-sm" type="button" data-action="retention" data-dry="0">Apply now</button></div><div id="retention-result" class="small" style="margin-top:10px"></div>' : ''}
        </form>
      </div>
      ${crm ? `<div class="card" style="margin-top:20px"><h2>HubSpot sync outbox</h2>
        <p class="small muted">Website demo requests become HubSpot contacts, companies and deals using an allowlist of business fields. Messages typed into the form stay here. ${crm.outbox.length ? '' : 'Submit the demo form on the website to see a payload.'}</p>
        ${crm.outbox.slice(-3).reverse().map((o) => `<div class="section-label">${esc(o.leadId)} · ${esc(o.mode)}</div><pre class="mono summary-text" style="max-height:220px;overflow:auto">${esc(JSON.stringify(o.payload || o.error, null, 2))}</pre>`).join('')}
      </div>` : ''}
    </div>
  </div>
  ${can('demo:run') ? `<div class="card" style="margin-top:20px"><h2>Demonstration data</h2><p class="small muted">Regenerate the synthetic agency relative to the current time. The audit log is kept.</p><button class="btn btn-sm" data-action="reset-demo">Reset demo data</button></div>` : ''}`;
};

// --- Walkthrough -------------------------------------------------------------

VIEWS.walkthrough = async () => {
  const w = state.walk;
  const settings = await api('GET', '/api/settings');
  const grace = settings.rules.confirmationGraceMinutes;
  const step = (n, title, body, status) => `<div class="num ${status}">${status === 'done' ? '✓' : n}</div><div class="body"><h3>${title}</h3>${body}</div>`;
  const s1 = w.visit ? 'done' : 'cur';
  const s2 = w.visit ? 'done' : '';
  const s3 = w.item ? (w.resolved ? 'done' : 'cur') : '';
  return `${pageHead('Missed-confirmation walkthrough', 'Follow one visit from a missing confirmation to a resolved supervisor review item. Uses synthetic data.')}
  <div class="cols">
    <div class="card"><div class="walk">
      ${step(1, 'A visit ends without confirmation', `<p class="small muted">We'll add a 2-hour visit that ended ${grace + 5} minutes ago. The caregiver's app sent no check-in and no check-out.</p>${w.visit ? `<div class="basis"><strong>${esc(w.visit.client.label)}</strong> with ${esc(w.visit.caregiverName)} · ${fmtTime(w.visit.start)}–${fmtTime(w.visit.end)} · <span class="mono">${esc(w.visit.id)}</span></div>` : '<button class="btn btn-teal btn-sm" data-action="walk-start">Create the visit and run the monitor</button>'}`, s1)}
      ${step(2, 'The confirmation monitor runs', `<p class="small muted">Every minute (an EventBridge-scheduled Lambda in production), CareQueue compares visit records to the rules. The grace period is ${grace} minutes — configurable under Rules & retention.</p>${w.item ? `<div class="basis">Rule matched: <strong>${esc(w.item.label)}</strong><br>${esc(w.item.basis)}</div>` : ''}`, s2)}
      ${step(3, 'A supervisor review item is created', w.item ? `<div class="list-item clickable" data-action="queue-item" data-id="${w.item.id}">${sevPill(w.item.severity)}<div class="grow"><div class="t">${esc(w.item.title)}</div><div class="d">${esc(w.item.detail)} · follow-up target ${fmtTime(w.item.dueAt)}</div></div></div><p class="small muted">Supervisors get a notification that says only "1 new critical item in CareQueue" — no client details leave the system.</p>` : '<p class="small muted">Appears in the Supervisor review queue with severity, follow-up target and the rule that raised it.</p>', s3)}
      ${step(4, 'The supervisor follows up and resolves', w.item ? (w.resolved ? '<p class="small">Manual confirmation recorded with a reason, and the item resolved with a note. The condition is cleared and every step is in the audit log.</p><div class="actions"><a class="btn btn-sm" href="#/audit">View audit log</a><button class="btn btn-sm btn-ghost" data-action="walk-reset">Run again</button></div>' : `<p class="small muted">Typically: call the caregiver, confirm the visit took place, record a manual check-in and check-out with a reason, then resolve the item.</p>${can('confirmations:write') && can('queue:update') ? '<button class="btn btn-primary btn-sm" data-action="walk-resolve">Record manual confirmation and resolve</button>' : '<p class="small">Sign in as a supervisor to complete this step.</p>'}`) : '<p class="small muted">Resolution requires a note. Items are never closed automatically.</p>', w.resolved ? 'done' : '')}
    </div></div>
    <div class="card" style="align-self:start"><h2>What is and isn't automated</h2>
      <ul class="small" style="padding-left:1.1em">
        <li><strong>Automated:</strong> detecting the missing record, creating the queue item, setting a follow-up target, notifying supervisors without details.</li>
        <li><strong>Human:</strong> contacting the caregiver, deciding what happened, recording a manual confirmation with a reason, resolving the item.</li>
        <li>A missing confirmation means the <em>record</em> is missing. CareQueue does not conclude that care was missed or that anyone is unsafe.</li>
      </ul>
    </div>
  </div>`;
};

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function refresh() { closeDrawer(); await render(); }

const ACTIONS = {
  async login(el) { await api('POST', '/api/session', { userId: el.dataset.id }); await boot(); },
  async logout() { await api('DELETE', '/api/session'); state.session = null; location.hash = ''; renderLogin(); },
  menu() { $('#sidebar').classList.toggle('open'); },
  async sweep() { const r = await api('POST', '/api/sweep'); toast(`Checks complete · ${r.findings} findings · ${r.created.length} new item(s)`); await render(); },
  async day(el) { const d = +el.dataset.delta; state.scheduleDay = d === 0 ? startOfToday() : state.scheduleDay + d * DAY; await render(); },
  visit(el) { if (el.dataset.id) return visitDrawer(el.dataset.id); },
  'new-visit': () => newVisitDrawer(),
  caregiver(el) { return caregiverDrawer(el.dataset.id); },
  'queue-item': (el) => queueDrawer(el.dataset.id),
  summary: (el) => summaryDrawer(el.dataset.id),
  incident: (el) => incidentDrawer(el.dataset.id),
  'new-incident': (el) => newIncidentDrawer(el.dataset.visit),
  async confirm(el) {
    await api('POST', `/api/visits/${el.dataset.id}/confirm`, { type: el.dataset.type, reason: $('#m-reason')?.value });
    toast(el.dataset.type === 'check_in' ? 'Check-in recorded' : 'Check-out recorded');
    await render(); await visitDrawer(el.dataset.id);
  },
  async record(el) { await api('PATCH', `/api/visits/${el.dataset.id}/record`, { [el.dataset.field]: el.checked }); toast('Record updated'); },
  async assign(el) {
    const r = await api('PATCH', `/api/visits/${el.dataset.id}`, { caregiverId: el.dataset.cg || null });
    toast(r.conflicts.length ? `Saved with ${r.conflicts.length} finding(s): ${r.conflicts[0].label}` : el.dataset.cg ? 'Caregiver assigned' : 'Caregiver removed', r.conflicts.length > 0);
    await render(); await visitDrawer(el.dataset.id);
  },
  async 'cancel-visit'(el) {
    const reason = prompt('Reason for cancelling (administrative, e.g. "Family request"):');
    if (!reason) return;
    await api('PATCH', `/api/visits/${el.dataset.id}`, { status: 'cancelled', reason });
    toast('Visit cancelled'); await refresh();
  },
  async 'queue-act'(el) {
    const body = { action: el.dataset.act, note: $('#q-note')?.value.trim() || undefined };
    if (body.action === 'assign') body.assigneeId = $('#q-assignee').value;
    await api('PATCH', `/api/queue/${el.dataset.id}`, body);
    toast({ acknowledge: 'Item acknowledged', assign: 'Item assigned', comment: 'Note added', resolve: 'Item resolved', reopen: 'Item reopened' }[body.action]);
    await render(); await queueDrawer(el.dataset.id);
  },
  async 'gen-summary'(el) {
    el.disabled = true;
    try { const s = await api('POST', '/api/summaries', { hours: 24 }); toast(`Draft ${s.id} created — awaiting review`); await render(); state.cache.summaries = await api('GET', '/api/summaries'); summaryDrawer(s.id); }
    finally { el.disabled = false; }
  },
  async 'sum-act'(el) {
    const act = el.dataset.act;
    const body = { action: act, text: $('#sum-text')?.value };
    if (act === 'reject') { body.reason = prompt('Reason for rejecting (optional):') || undefined; delete body.text; }
    await api('PATCH', `/api/summaries/${el.dataset.id}`, body);
    toast({ edit: 'Edits saved', approve: 'Summary approved and shared', reject: 'Summary rejected' }[act]);
    await render(); state.cache.summaries = await api('GET', '/api/summaries'); summaryDrawer(el.dataset.id);
  },
  async 'inc-act'(el) {
    await api('PATCH', `/api/incidents/${el.dataset.id}`, { action: el.dataset.act, note: $('#inc-note').value.trim(), ownerId: $('#inc-owner').value });
    toast('Incident updated'); await render(); incidentDrawer(el.dataset.id);
  },
  async retention(el) {
    const r = await api('POST', '/api/retention/run', { dryRun: el.dataset.dry === '1' });
    $('#retention-result').innerHTML = `<div class="basis">${r.dryRun ? 'Dry run — nothing deleted.' : 'Retention applied.'} ${Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>`;
  },
  async 'reset-demo'() { if (!confirm('Regenerate all synthetic demo data?')) return; await api('POST', '/api/demo/reset'); state.walk = {}; toast('Demo data regenerated'); await render(); },
  async 'walk-start'() { const r = await api('POST', '/api/demo/missed-confirmation'); state.walk = { visit: r.visit, item: r.queueItem }; toast('Visit created — monitor raised a critical item'); await render(); },
  async 'walk-resolve'() {
    const { visit, item } = state.walk;
    const reason = 'Caregiver confirmed by phone; app was offline';
    await api('POST', `/api/visits/${visit.id}/confirm`, { type: 'check_in', at: visit.start, reason });
    await api('POST', `/api/visits/${visit.id}/confirm`, { type: 'check_out', at: visit.end, reason });
    await api('PATCH', `/api/queue/${item.id}`, { action: 'resolve', note: `${reason}. Manual check-in/out recorded. Asked caregiver to update the app.` });
    state.walk.resolved = true; toast('Resolved'); await render();
  },
  'walk-reset'() { state.walk = {}; render(); },
};

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) { closeDrawer(); if (e.target.closest('a')) return; e.preventDefault(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox' && e.type === 'click') { /* handled on change */ }
  const fn = ACTIONS[el.dataset.action];
  if (!fn || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  e.preventDefault();
  try { await fn(el); } catch (err) { if (err.message !== 'Signed out') toast(err.message, true); }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-action]')) {
    try { await ACTIONS[el.dataset.action](el); } catch (err) { toast(err.message, true); el.checked = !el.checked; }
    return;
  }
  if (el.dataset.filter) {
    if (el.dataset.filter === 'reportDays') state.reportDays = +el.value;
    else state.queueFilter[el.dataset.filter] = el.value;
    await render();
  }
});

const toIso = (local) => new Date(local).toISOString();

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  try {
    switch (form.dataset.form) {
      case 'new-visit': {
        const r = await api('POST', '/api/visits', { ...fd, start: toIso(fd.start), end: toIso(fd.end), caregiverId: fd.caregiverId || null });
        toast(r.conflicts.length ? `Visit created with ${r.conflicts.length} finding(s): ${r.conflicts.map((c) => c.label).join(', ')}` : 'Visit created — no conflicts', r.conflicts.length > 0);
        state.scheduleDay = new Date(r.visit.start).setHours(0, 0, 0, 0);
        await refresh(); break;
      }
      case 'availability': {
        const availability = [0, 1, 2, 3, 4, 5, 6].filter((d) => fd[`on-${d}`]).map((d) => ({ day: d, start: fd[`start-${d}`], end: fd[`end-${d}`] }));
        await api('PUT', `/api/caregivers/${form.dataset.id}/availability`, { availability });
        toast('Availability saved'); await refresh(); break;
      }
      case 'time-off':
        await api('POST', `/api/caregivers/${form.dataset.id}/time-off`, { start: toIso(fd.start), end: toIso(fd.end), reason: fd.reason });
        toast('Time off added — conflicts re-checked'); await api('POST', '/api/sweep').catch(() => {}); await refresh(); break;
      case 'handover': {
        const audience = ['scheduler', 'supervisor', 'caregiver'].filter((r) => fd[`aud-${r}`]);
        await api('POST', '/api/handovers', { category: fd.category, text: fd.text, audience, requiresFollowUp: !!fd.requiresFollowUp });
        toast('Note added'); await render(); break;
      }
      case 'incident':
        await api('POST', '/api/incidents', { ...fd, visitId: form.dataset.visit || undefined });
        toast('Incident reported'); closeDrawer(); if (can('incidents:read')) location.hash = '#/incidents'; await render(); break;
      case 'rules':
        await api('PATCH', '/api/settings', { rules: fd }); toast('Rules saved — checks re-run'); await render(); break;
      case 'retention':
        await api('PATCH', '/api/settings', { retention: Object.fromEntries(Object.entries(fd).map(([k, v]) => [k, v === '' ? null : Number(v)])) }); toast('Retention saved'); await render(); break;
    }
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
window.addEventListener('hashchange', () => { closeDrawer(); $('#sidebar')?.classList.remove('open'); render(); });

async function boot() {
  const s = await api('GET', '/api/session');
  state.session = s;
  state.staff = await api('GET', '/api/personas');
  await render();
}

boot().catch((err) => { $('#root').innerHTML = `<p style="padding:40px">${esc(err.message)}</p>`; });
