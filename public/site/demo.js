import { detectSchedulingConflicts, DEFAULT_RULES } from '/shared/rules.js';
import { fmtTime } from '/shared/time.js';

// A fictional day for five caregivers, 07:00–19:00, starting tomorrow.
const day = new Date(); day.setDate(day.getDate() + 1); day.setHours(0, 0, 0, 0);
const DAY_START = 7, DAY_END = 19;
const t = (h, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60000).toISOString();
const now = new Date(day.getTime() + 6 * 3600000).toISOString();
const wd = day.getDay();
const avail = (s, e) => [{ day: wd, start: s, end: e }];

const caregivers = [
  { id: 'a', name: 'Amara O.', role: 'HHA', status: 'active', homeZone: 'Old Town', credentials: ['HHA', 'CPR'], availability: avail('07:00', '16:00'), timeOff: [] },
  { id: 'b', name: 'Ben K.', role: 'CNA', status: 'active', homeZone: 'Northgate', credentials: ['CNA', 'CPR', 'Hoyer lift'], availability: avail('07:00', '16:00'), timeOff: [] },
  { id: 'c', name: 'Lucía F.', role: 'HHA', status: 'active', homeZone: 'Riverside', credentials: ['HHA', 'CPR'], availability: avail('10:00', '19:00'), timeOff: [] },
  { id: 'd', name: 'Kenji W.', role: 'Companion', status: 'active', homeZone: 'Eastfield', credentials: ['CPR'], availability: avail('10:00', '19:00'), timeOff: [] },
  { id: 'e', name: 'Mei-Ling C.', role: 'CNA', status: 'active', homeZone: 'Lakeshore', credentials: ['CNA', 'CPR'], availability: avail('07:00', '16:00'), timeOff: [] },
];
const clients = [
  { id: 'c1', label: 'Client 1001', zone: 'Old Town', requiredCredentials: [] },
  { id: 'c2', label: 'Client 1002', zone: 'Old Town', requiredCredentials: ['Hoyer lift'] },
  { id: 'c3', label: 'Client 1003', zone: 'Northgate', requiredCredentials: [] },
  { id: 'c4', label: 'Client 1005', zone: 'Riverside', requiredCredentials: [] },
  { id: 'c5', label: 'Client 1007', zone: 'Eastfield', requiredCredentials: [] },
  { id: 'c6', label: 'Client 1011', zone: 'Lakeshore', requiredCredentials: [] },
  { id: 'c7', label: 'Client 1008', zone: 'Eastfield', requiredCredentials: [] },
];
const base = () => [
  ['v1', 'a', 'c1', 8, 0, 10, 0], ['v2', 'a', 'c1', 11, 0, 13, 0], ['v3', 'a', 'c4', 14, 0, 16, 0],
  ['v4', 'b', 'c3', 7, 30, 9, 30], ['v5', 'b', 'c2', 10, 30, 12, 30], ['v6', 'b', 'c3', 13, 30, 15, 30],
  ['v7', 'c', 'c4', 10, 0, 12, 0], ['v8', 'c', 'c4', 13, 0, 15, 0], ['v9', 'c', 'c1', 16, 0, 18, 0],
  ['v10', 'd', 'c5', 10, 30, 12, 30], ['v11', 'd', 'c7', 13, 30, 15, 30],
  ['v12', 'e', 'c6', 7, 0, 9, 0], ['v13', 'e', 'c6', 10, 0, 12, 0], ['v14', 'e', 'c4', 13, 0, 15, 0],
].map(([id, caregiverId, clientId, sh, sm, eh, em]) => ({ id, caregiverId, clientId, start: t(sh, sm), end: t(eh, em), status: 'scheduled' }));

let visits = base();
let applied = new Set();

const SCENARIOS = {
  callout: () => { visits.filter((v) => v.caregiverId === 'c').forEach((v) => { v.caregiverId = null; }); },
  overlap: () => { visits.push({ id: 'v15', caregiverId: 'a', clientId: 'c1', start: t(11, 30), end: t(12, 45), status: 'scheduled' }); },
  leave: () => { caregivers[3].timeOff = [{ start: t(0), end: t(23, 59), reason: 'Approved leave' }]; },
  travel: () => { visits.push({ id: 'v16', caregiverId: 'e', clientId: 'c7', start: t(12, 10), end: t(12, 55), status: 'scheduled' }); },
  credential: () => { visits.push({ id: 'v17', caregiverId: 'd', clientId: 'c2', start: t(16, 15), end: t(17, 15), status: 'scheduled' }); },
};

function reset() {
  visits = base();
  caregivers.forEach((c) => { c.timeOff = []; });
  applied = new Set();
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  const findings = detectSchedulingConflicts({ visits, caregivers, clients, now, rules: DEFAULT_RULES })
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const flagFor = new Map();
  for (const f of findings) for (const id of f.refs.visitIds || []) {
    const cur = flagFor.get(id);
    if (!cur || SEV_ORDER[f.severity] < SEV_ORDER[cur]) flagFor.set(id, f.severity);
  }
  const span = (DAY_END - DAY_START) * 60;
  const pos = (iso) => ((new Date(iso).getHours() * 60 + new Date(iso).getMinutes() - DAY_START * 60) / span) * 100;
  const clientOf = (id) => clients.find((c) => c.id === id);

  const rows = [...caregivers.map((c) => ({ key: c.id, name: c.name, sub: `${c.role} · ${c.homeZone}${c.timeOff.length ? ' · on leave' : ''}` })), { key: null, name: 'Unassigned', sub: 'Needs coverage' }];
  document.getElementById('board').innerHTML = `
    <div class="tl-hours"><span></span>${Array.from({ length: 12 }, (_, i) => `<span>${String(DAY_START + i).padStart(2, '0')}:00</span>`).join('')}</div>
    ${rows.map((r) => `<div class="tl-row"><div class="tl-name">${esc(r.name)}<small>${esc(r.sub)}</small></div><div class="tl-track">
      ${visits.filter((v) => v.caregiverId === r.key).map((v) => {
        const flag = flagFor.get(v.id);
        const cls = r.key === null ? 'unassigned' : flag ? `flag-${flag}` : '';
        return `<button class="tl-visit ${cls}" data-visit="${v.id}" style="left:${pos(v.start)}%;width:${pos(v.end) - pos(v.start)}%" title="${esc(clientOf(v.clientId).label)} ${fmtTime(v.start)}–${fmtTime(v.end)}">${esc(clientOf(v.clientId).label.replace('Client ', '#'))} · ${esc(clientOf(v.clientId).zone)}</button>`;
      }).join('')}</div></div>`).join('')}`;

  document.getElementById('count').textContent = findings.length;
  document.getElementById('findings').innerHTML = findings.length
    ? findings.map((f) => `<div class="finding"><span class="pill sev-${f.severity}">${f.severity}</span> <span class="tiny muted">${esc(f.label)}</span><h5>${esc(f.title)}</h5><p>${esc(f.detail)}</p><p class="tiny" style="margin-top:4px"><em>Rule:</em> ${esc(f.basis)}</p></div>`).join('')
    : '<p class="small muted">No conflicts. Try one of the scenarios above.</p>';

  document.querySelectorAll('[data-scenario]').forEach((b) => { b.disabled = applied.has(b.dataset.scenario); });
}

document.addEventListener('click', (e) => {
  const sc = e.target.closest('[data-scenario]');
  if (sc) {
    const key = sc.dataset.scenario;
    if (key === 'reset') reset();
    else if (!applied.has(key)) { SCENARIOS[key](); applied.add(key); }
    document.getElementById('detail').innerHTML = '';
    render();
    return;
  }
  const vb = e.target.closest('[data-visit]');
  if (vb) {
    const v = visits.find((x) => x.id === vb.dataset.visit);
    const c = clients.find((x) => x.id === v.clientId);
    const cg = caregivers.find((x) => x.id === v.caregiverId);
    document.getElementById('detail').innerHTML = `<div class="card" style="padding:12px;box-shadow:none;background:var(--bg)"><strong>${esc(c.label)}</strong> · ${esc(c.zone)}<br>${fmtTime(v.start)}–${fmtTime(v.end)}<br>Caregiver: ${cg ? esc(cg.name) : '<em>unassigned</em>'}${c.requiredCredentials.length ? `<br>Requires: ${esc(c.requiredCredentials.join(', '))}` : ''}</div>`;
  }
});

render();
