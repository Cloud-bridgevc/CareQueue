// JSON API. Each route declares a permission; the router enforces it and
// audit-logs every write and every read of sensitive resources.

import { can, canSeeHandover, permissionsFor, ROLES } from './rbac.js';
import { sweep, applyRetention, createStore } from './store.js';
import { draftSummary, reviewSummary, httpError } from './summaries.js';
import { demoRequestToCrm, syncToHubSpot, AGENCY_SIZE_BANDS } from '../integrations/hubspot.js';
import { detectSchedulingConflicts, suggestCoverage, sortQueue, isOverdue, mergeRules, RECORD_FIELDS } from '../shared/rules.js';
import { computeOperationsReport, narrateReport } from '../shared/reports.js';
import { ms, iso, HOUR, MINUTE, DAY } from '../shared/time.js';

const routes = [];
const route = (method, path, permission, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, permission, handler, ...opts });
};

export function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function authorize(r, user) {
  if (r.permission === 'public') return;
  if (!user) throw httpError(401, 'Sign in required.');
  const perms = Array.isArray(r.permission) ? r.permission : [r.permission];
  if (!perms.some((p) => can(user, p))) throw httpError(403, 'Your role does not have access to this.');
}

// ---------------------------------------------------------------------------
// Views (data minimization)
// ---------------------------------------------------------------------------

const staffName = (s, id) => s.staff.find((u) => u.id === id)?.name || (id === 'system' ? 'System' : id);

function clientView(c) {
  return c && { id: c.id, label: c.label, zone: c.zone, requiredCredentials: c.requiredCredentials, preferredLanguage: c.preferredLanguage, synthetic: true };
}

function visitView(s, v) {
  return {
    ...v,
    client: clientView(s.clients.find((c) => c.id === v.clientId)),
    caregiverName: s.caregivers.find((c) => c.id === v.caregiverId)?.name || null,
  };
}

function queueView(s, i, now) {
  return { ...i, overdue: isOverdue(i, now), assigneeName: i.assigneeId ? staffName(s, i.assigneeId) : null };
}

function visibleVisits(s, user) {
  if (can(user, 'visits:read')) return s.visits;
  if (can(user, 'visits:read_own')) return s.visits.filter((v) => v.caregiverId === user.caregiverId);
  return [];
}

function findOr404(list, id, what) {
  const x = list.find((i) => i.id === id);
  if (!x) throw httpError(404, `${what} not found.`);
  return x;
}

function required(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw httpError(400, `Missing: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Session (demo personas — production uses Cognito/SAML SSO with MFA)
// ---------------------------------------------------------------------------

route('GET', '/api/personas', 'public', ({ s }) => s.staff.map((u) => ({ id: u.id, name: u.name, role: u.role, roleLabel: ROLES[u.role], title: u.title })));

route('GET', '/api/session', 'public', ({ s, user }) => ({
  user: user ? { ...user, roleLabel: ROLES[user.role], permissions: permissionsFor(user.role) } : null,
  agency: s.agency,
  lastSweep: s.lastSweep,
}));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

route('GET', '/api/overview', ['visits:read', 'visits:read_own'], ({ s, user, now }) => {
  const visits = visibleVisits(s, user);
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const today = visits.filter((v) => ms(v.start) >= todayStart.getTime() && ms(v.start) < todayStart.getTime() + DAY && v.status !== 'cancelled');
  const open = can(user, 'queue:read') ? s.queue.filter((i) => i.status !== 'resolved') : [];
  return {
    today: { total: today.length, inProgress: today.filter((v) => v.status === 'in_progress').length, unassigned: today.filter((v) => !v.caregiverId).length, confirmed: today.filter((v) => v.confirmation?.checkIn).length },
    queue: { open: open.length, overdue: open.filter((i) => isOverdue(i, now)).length, critical: open.filter((i) => i.severity === 'critical').length },
    caregiversActive: s.caregivers.filter((c) => c.status === 'active').length,
    summariesAwaiting: can(user, 'summary:approve') ? s.summaries.filter((x) => ['pending_review', 'needs_edit'].includes(x.status)).length : null,
    incidentsOpen: can(user, 'incidents:read') ? s.incidents.filter((i) => i.status !== 'resolved').length : null,
    top: sortQueue(open, now).slice(0, 5).map((i) => queueView(s, i, now)),
    upcoming: visits.filter((v) => ms(v.start) > ms(now) && v.status !== 'cancelled').slice(0, 8).map((v) => visitView(s, v)),
    lastSweep: s.lastSweep,
  };
});

// ---------------------------------------------------------------------------
// Care team & availability
// ---------------------------------------------------------------------------

route('GET', '/api/caregivers', 'team:read', ({ s, now }) => s.caregivers.map((c) => {
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const hours = s.visits.filter((v) => v.caregiverId === c.id && v.status !== 'cancelled' && ms(v.start) >= weekStart.getTime() && ms(v.start) < weekStart.getTime() + 7 * DAY)
    .reduce((h, v) => h + (ms(v.end) - ms(v.start)) / HOUR, 0);
  return { ...c, weekHours: Math.round(hours * 10) / 10 };
}));

route('GET', '/api/clients', 'team:read', ({ s }) => s.clients.map(clientView));

route('PUT', '/api/caregivers/:id/availability', 'availability:write', ({ s, params, body, audit }) => {
  const c = findOr404(s.caregivers, params.id, 'Caregiver');
  if (!Array.isArray(body.availability)) throw httpError(400, 'availability must be a list.');
  for (const w of body.availability) {
    if (!(w.day >= 0 && w.day <= 6) || !/^\d\d:\d\d$/.test(w.start) || !/^\d\d:\d\d$/.test(w.end) || w.start >= w.end) throw httpError(400, 'Invalid availability window.');
  }
  const before = c.availability;
  c.availability = body.availability.map(({ day, start, end }) => ({ day: Number(day), start, end }));
  audit('caregiver.availability_updated', 'caregiver', c.id, { before: before.length, after: c.availability.length });
  return c;
});

route('POST', '/api/caregivers/:id/time-off', 'availability:write', ({ s, params, body, audit }) => {
  const c = findOr404(s.caregivers, params.id, 'Caregiver');
  required(body, ['start', 'end']);
  if (ms(body.end) <= ms(body.start)) throw httpError(400, 'End must be after start.');
  const entry = { start: iso(ms(body.start)), end: iso(ms(body.end)), reason: String(body.reason || 'Time off').slice(0, 80) };
  c.timeOff.push(entry);
  audit('caregiver.time_off_added', 'caregiver', c.id, entry);
  return c;
});

// ---------------------------------------------------------------------------
// Visits, assignments, coverage
// ---------------------------------------------------------------------------

route('GET', '/api/visits', ['visits:read', 'visits:read_own'], ({ s, user, query }) => {
  const from = query.get('from') ? ms(query.get('from')) : -Infinity;
  const to = query.get('to') ? ms(query.get('to')) : Infinity;
  return visibleVisits(s, user).filter((v) => ms(v.start) >= from && ms(v.start) < to).map((v) => visitView(s, v));
});

route('POST', '/api/visits', 'visits:write', ({ s, body, audit, now }) => {
  required(body, ['clientId', 'start', 'end']);
  findOr404(s.clients, body.clientId, 'Client');
  if (body.caregiverId) findOr404(s.caregivers, body.caregiverId, 'Caregiver');
  if (ms(body.end) <= ms(body.start)) throw httpError(400, 'End must be after start.');
  const v = {
    id: s.newId('V-'), clientId: body.clientId, caregiverId: body.caregiverId || null, start: iso(ms(body.start)), end: iso(ms(body.end)),
    serviceType: body.serviceType || 'Personal care visit', status: 'scheduled', confirmation: {}, record: {}, requiredCredentials: [], synthetic: true,
  };
  s.visits.push(v);
  s.visits.sort((a, b) => ms(a.start) - ms(b.start));
  audit('visit.created', 'visit', v.id, { caregiverId: v.caregiverId, start: v.start });
  const conflicts = detectSchedulingConflicts({ visits: s.visits, caregivers: s.caregivers, clients: s.clients, now, rules: s.settings.rules }).filter((f) => f.refs.visitIds?.includes(v.id));
  sweep(s, now);
  return { visit: visitView(s, v), conflicts };
});

route('PATCH', '/api/visits/:id', 'visits:write', ({ s, params, body, audit, now }) => {
  const v = findOr404(s.visits, params.id, 'Visit');
  const changes = {};
  if ('caregiverId' in body) {
    if (body.caregiverId) findOr404(s.caregivers, body.caregiverId, 'Caregiver');
    changes.caregiverId = [v.caregiverId, body.caregiverId || null];
    v.caregiverId = body.caregiverId || null;
  }
  if (body.status && ['scheduled', 'cancelled'].includes(body.status)) {
    changes.status = [v.status, body.status];
    v.status = body.status;
    if (body.status === 'cancelled') v.cancelReason = String(body.reason || 'Cancelled').slice(0, 120);
  }
  if (body.start && body.end) {
    if (ms(body.end) <= ms(body.start)) throw httpError(400, 'End must be after start.');
    changes.time = [v.start, body.start];
    v.start = iso(ms(body.start)); v.end = iso(ms(body.end));
  }
  audit('visit.updated', 'visit', v.id, changes);
  const conflicts = detectSchedulingConflicts({ visits: s.visits, caregivers: s.caregivers, clients: s.clients, now, rules: s.settings.rules }).filter((f) => f.refs.visitIds?.includes(v.id));
  sweep(s, now);
  return { visit: visitView(s, v), conflicts };
});

route('GET', '/api/visits/:id/suggestions', 'visits:write', ({ s, params, now }) => {
  const v = findOr404(s.visits, params.id, 'Visit');
  return suggestCoverage({ visit: v, visits: s.visits, caregivers: s.caregivers, clients: s.clients, now, rules: s.settings.rules });
});

route('GET', '/api/conflicts', 'visits:read', ({ s, now }) =>
  detectSchedulingConflicts({ visits: s.visits, caregivers: s.caregivers, clients: s.clients, now, rules: s.settings.rules }));

// Confirmations (EVV-style check-in / check-out) and administrative record fields
route('POST', '/api/visits/:id/confirm', ['confirmations:write', 'confirmations:write_own'], ({ s, user, params, body, audit, now }) => {
  const v = findOr404(s.visits, params.id, 'Visit');
  if (!can(user, 'confirmations:write') && v.caregiverId !== user.caregiverId) throw httpError(403, 'You can only confirm your own visits.');
  if (!['check_in', 'check_out'].includes(body.type)) throw httpError(400, 'type must be check_in or check_out.');
  const at = body.at ? iso(ms(body.at)) : iso(ms(now));
  const method = user.role === 'caregiver' ? 'EVV mobile' : 'Office (manual)';
  if (body.type === 'check_in') { v.confirmation.checkIn = at; v.status = 'in_progress'; }
  else {
    if (!v.confirmation.checkIn) throw httpError(409, 'Record a check-in first.');
    v.confirmation.checkOut = at; v.status = 'completed';
    v.record = { timesheetSigned: false, tasksDocumented: false, mileageLogged: false, ...v.record };
  }
  v.confirmation.method = method;
  if (method.startsWith('Office')) v.confirmation.manualReason = String(body.reason || 'Confirmed by phone with caregiver').slice(0, 160);
  v.confirmation.confirmedBy = user.id;
  audit(`visit.${body.type}`, 'visit', v.id, { at, method });
  sweep(s, now);
  return visitView(s, v);
});

route('PATCH', '/api/visits/:id/record', ['confirmations:write', 'confirmations:write_own'], ({ s, user, params, body, audit, now }) => {
  const v = findOr404(s.visits, params.id, 'Visit');
  if (!can(user, 'confirmations:write') && v.caregiverId !== user.caregiverId) throw httpError(403, 'You can only update your own visits.');
  for (const k of Object.keys(RECORD_FIELDS)) if (typeof body[k] === 'boolean') v.record[k] = body[k];
  audit('visit.record_updated', 'visit', v.id, v.record);
  sweep(s, now);
  return visitView(s, v);
});

// ---------------------------------------------------------------------------
// Supervisor attention queue
// ---------------------------------------------------------------------------

route('GET', '/api/queue', 'queue:read', ({ s, now }) => sortQueue(s.queue, now).map((i) => queueView(s, i, now)));

route('PATCH', '/api/queue/:id', 'queue:update', ({ s, user, params, body, audit, now }) => {
  const i = findOr404(s.queue, params.id, 'Queue item');
  const at = iso(ms(now));
  const note = body.note ? String(body.note).slice(0, 500) : undefined;
  switch (body.action) {
    case 'acknowledge': i.status = 'acknowledged'; break;
    case 'assign':
      if (body.assigneeId && !s.staff.some((u) => u.id === body.assigneeId && ['supervisor', 'scheduler', 'admin'].includes(u.role))) throw httpError(400, 'Assignee must be office staff.');
      i.assigneeId = body.assigneeId || user.id; if (i.status === 'open') i.status = 'acknowledged'; break;
    case 'resolve':
      if (!note) throw httpError(400, 'A resolution note is required.');
      i.status = 'resolved'; i.resolvedAt = at; i.resolvedBy = user.id; i.resolution = note; break;
    case 'reopen': i.status = 'open'; delete i.resolvedAt; break;
    case 'comment': if (!note) throw httpError(400, 'Comment text required.'); break;
    default: throw httpError(400, 'Unknown action.');
  }
  i.history.push({ at, by: user.id, action: body.action, note, assigneeId: body.action === 'assign' ? i.assigneeId : undefined });
  audit(`queue.${body.action}`, 'queue_item', i.id, { code: i.code, note: note ? '[text]' : undefined });
  return queueView(s, i, now);
});

route('POST', '/api/sweep', 'queue:update', ({ s, user, now }) => {
  const r = sweep(s, now, user);
  return { created: r.created.map((i) => queueView(s, i, now)), cleared: r.cleared.map((i) => i.id), findings: r.findings.length, lastSweep: s.lastSweep };
});

// ---------------------------------------------------------------------------
// Handover workspace & AI summaries
// ---------------------------------------------------------------------------

route('GET', '/api/handovers', 'handover:read', ({ s, user, audit }) => {
  const notes = s.handovers.filter((n) => canSeeHandover(user, n)).map((n) => ({ ...n, authorName: staffName(s, n.authorId) }));
  audit('handover.list_viewed', 'handover', null, { count: notes.length });
  return notes.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
});

route('POST', '/api/handovers', 'handover:write', ({ s, user, body, audit, now }) => {
  required(body, ['text', 'category']);
  const categories = ['scheduling', 'staffing', 'access', 'documentation', 'follow_up', 'logistics', 'family_request', 'care_observation'];
  if (!categories.includes(body.category)) throw httpError(400, 'Unknown category.');
  const audience = (Array.isArray(body.audience) && body.audience.length ? body.audience : ['scheduler', 'supervisor']).filter((r) => ['scheduler', 'supervisor', 'caregiver'].includes(r));
  const note = {
    id: s.newId('HN-'), createdAt: iso(ms(now)), authorId: user.id, category: body.category, audience,
    text: String(body.text).slice(0, 2000), requiresFollowUp: !!body.requiresFollowUp, restricted: body.category === 'care_observation', synthetic: true,
  };
  s.handovers.push(note);
  audit('handover.created', 'handover', note.id, { category: note.category, audience });
  return { ...note, authorName: user.name };
});

route('GET', '/api/summaries', ['summary:generate', 'summary:approve', 'handover:read'], ({ s, user }) => {
  const reviewer = can(user, 'summary:approve') || can(user, 'summary:generate');
  return s.summaries
    .filter((x) => reviewer || (x.status === 'approved'))
    .map((x) => ({ ...x, requestedByName: staffName(s, x.requestedBy), reviewerName: x.review ? staffName(s, x.review.by) : null }))
    .map((x) => (reviewer ? x : { id: x.id, createdAt: x.createdAt, status: x.status, finalText: x.finalText, reviewerName: x.reviewerName }))
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
});

route('POST', '/api/summaries', 'summary:generate', async ({ s, user, body, audit, now }) => {
  const hours = Math.min(Number(body.hours) || 24, 72);
  const ids = Array.isArray(body.noteIds) && body.noteIds.length ? new Set(body.noteIds) : null;
  const notes = s.handovers.filter((n) => canSeeHandover(user, n) && (ids ? ids.has(n.id) : ms(n.createdAt) >= ms(now) - hours * HOUR));
  if (!notes.length) throw httpError(400, 'No authorized notes in that window.');
  const summary = await draftSummary({ notes, staffName: (id) => staffName(s, id), requestedBy: user.id, newId: () => s.newId('SUM-'), now: new Date(now) });
  s.summaries.push(summary);
  audit('summary.drafted', 'summary', summary.id, { provider: summary.provider, sourceNoteIds: summary.sourceNoteIds, excluded: summary.excludedNotes.length, flags: summary.flags.length });
  return { ...summary, requestedByName: user.name };
});

route('PATCH', '/api/summaries/:id', ['summary:approve', 'summary:generate'], ({ s, user, params, body, audit }) => {
  const x = findOr404(s.summaries, params.id, 'Summary');
  if (body.action !== 'edit' && !can(user, 'summary:approve')) throw httpError(403, 'Only authorized reviewers can approve or reject.');
  reviewSummary(x, { action: body.action, text: body.text, reviewer: user, reason: body.reason });
  audit(`summary.${body.action}`, 'summary', x.id, { status: x.status });
  return { ...x, requestedByName: staffName(s, x.requestedBy), reviewerName: x.review ? staffName(s, x.review.by) : null };
});

// ---------------------------------------------------------------------------
// Incident escalation
// ---------------------------------------------------------------------------

const INCIDENT_FLOW = { reported: ['triaged', 'escalated', 'resolved'], triaged: ['escalated', 'resolved'], escalated: ['escalated', 'resolved'], resolved: ['reopened'] };
const INCIDENT_FOLLOW_UP_H = { high: 4, medium: 24, low: 72 };

route('GET', '/api/incidents', 'incidents:read', ({ s }) =>
  s.incidents.map((i) => ({ ...i, ownerName: i.ownerId ? staffName(s, i.ownerId) : null, timeline: i.timeline.map((t) => ({ ...t, byName: staffName(s, t.by) })) }))
    .sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || ms(b.reportedAt) - ms(a.reportedAt)));

route('POST', '/api/incidents', 'incidents:create', ({ s, user, body, audit, now }) => {
  required(body, ['title', 'category', 'severity', 'description']);
  if (!['high', 'medium', 'low'].includes(body.severity)) throw httpError(400, 'Invalid severity.');
  const inc = {
    id: s.newId('INC-'), title: String(body.title).slice(0, 120), category: body.category, severity: body.severity, status: 'reported', escalationLevel: 0,
    reportedAt: iso(ms(now)), reportedBy: user.id, ownerId: null, followUpDueAt: iso(ms(now) + INCIDENT_FOLLOW_UP_H[body.severity] * HOUR),
    description: String(body.description).slice(0, 2000), refs: { visitId: body.visitId || undefined }, synthetic: true,
    timeline: [{ at: iso(ms(now)), by: user.id, action: 'reported' }],
  };
  s.incidents.push(inc);
  audit('incident.reported', 'incident', inc.id, { category: inc.category, severity: inc.severity });
  return inc;
});

route('PATCH', '/api/incidents/:id', 'incidents:manage', ({ s, user, params, body, audit, now }) => {
  const inc = findOr404(s.incidents, params.id, 'Incident');
  const action = body.action;
  const allowed = INCIDENT_FLOW[inc.status] || [];
  if (!allowed.includes(action)) throw httpError(409, `Cannot ${action} an incident that is ${inc.status}.`);
  const note = String(body.note || '').slice(0, 1000);
  if (['escalated', 'resolved'].includes(action) && !note) throw httpError(400, 'A note is required to escalate or resolve.');
  if (action === 'escalated') inc.escalationLevel = Math.min((inc.escalationLevel || 0) + 1, 3);
  if (action === 'resolved') inc.resolvedAt = iso(ms(now));
  inc.status = action === 'reopened' ? 'triaged' : action;
  inc.ownerId = body.ownerId || inc.ownerId || user.id;
  if (action !== 'resolved') inc.followUpDueAt = iso(ms(now) + INCIDENT_FOLLOW_UP_H[inc.severity] * HOUR);
  inc.timeline.push({ at: iso(ms(now)), by: user.id, action, note });
  audit(`incident.${action}`, 'incident', inc.id, { level: inc.escalationLevel });
  sweep(s, now);
  return inc;
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

route('GET', '/api/reports/operations', 'reports:read', ({ s, query, now }) => {
  const days = Math.min(Math.max(Number(query.get('days')) || 7, 1), 30);
  const report = computeOperationsReport({ visits: s.visits, caregivers: s.caregivers, clients: s.clients, queue: s.queue, incidents: s.incidents, now, days });
  return { ...report, narrative: narrateReport(report), narrativeStatus: 'draft — figures computed from records; wording requires reviewer sign-off before distribution' };
});

// ---------------------------------------------------------------------------
// Audit, settings, retention
// ---------------------------------------------------------------------------

route('GET', '/api/audit', 'audit:read', ({ s, query, audit }) => {
  audit('audit.viewed', 'audit', null, {});
  return s.audit.query({ actorId: query.get('actor') || undefined, entity: query.get('entity') || undefined, limit: 300 })
    .map((e) => ({ ...e, actorName: staffName(s, e.actorId) }));
});

route('GET', '/api/audit/verify', 'audit:read', ({ s }) => s.audit.verify());

route('GET', '/api/settings', 'settings:read', ({ s }) => s.settings);

route('PATCH', '/api/settings', 'settings:write', ({ s, body, audit, now }) => {
  if (body.rules) {
    const numeric = ['confirmationGraceMinutes', 'recordCompletionHours', 'coverageHorizonHours', 'travelBufferMinutes', 'travelBaseMinutes', 'travelPerZoneStepMinutes', 'defaultMaxWeeklyHours', 'summaryReviewHours'];
    const patch = {};
    for (const k of numeric) if (body.rules[k] !== undefined) {
      const n = Number(body.rules[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw httpError(400, `Invalid ${k}.`);
      patch[k] = n;
    }
    s.settings.rules = mergeRules({ ...s.settings.rules, ...patch });
  }
  if (body.retention) {
    for (const [k, v] of Object.entries(body.retention)) {
      if (!(k in s.settings.retention)) continue;
      const n = v === null || v === '' ? null : Number(v);
      if (n !== null && (!Number.isInteger(n) || n < 1)) throw httpError(400, `Invalid retention for ${k}.`);
      s.settings.retention[k] = n;
    }
  }
  audit('settings.updated', 'settings', null, { rules: Object.keys(body.rules || {}), retention: Object.keys(body.retention || {}) });
  sweep(s, now);
  return s.settings;
});

route('POST', '/api/retention/run', 'retention:run', ({ s, user, body, now }) => applyRetention(s, { dryRun: body.dryRun !== false, now: ms(now), actor: user }));

route('GET', '/api/crm/outbox', 'crm:read', ({ s }) => ({ leads: s.leads.map(({ message, ...l }) => ({ ...l, hasMessage: !!message })), outbox: s.crmOutbox }));

// ---------------------------------------------------------------------------
// Demonstration controls
// ---------------------------------------------------------------------------

// Walkthrough: a visit ends with no confirmation → monitor flags it → queue item.
route('POST', '/api/demo/missed-confirmation', 'demo:run', ({ s, user, audit, now }) => {
  const rules = s.settings.rules;
  const caregiver = s.caregivers[Math.floor(Math.random() * s.caregivers.length)];
  const client = s.clients.find((c) => c.requiredCredentials.every((r) => caregiver.credentials.includes(r)) && c.zone === caregiver.homeZone) || s.clients[0];
  const end = ms(now) - (rules.confirmationGraceMinutes + 5) * MINUTE;
  const v = {
    id: s.newId('V-'), clientId: client.id, caregiverId: caregiver.id, start: iso(end - 2 * HOUR), end: iso(end), serviceType: 'Personal care visit',
    status: 'scheduled', confirmation: {}, record: {}, requiredCredentials: [], synthetic: true, scenario: 'demo_walkthrough',
  };
  s.visits.push(v);
  s.visits.sort((a, b) => ms(a.start) - ms(b.start));
  audit('demo.visit_without_confirmation', 'visit', v.id, { synthetic: true });
  const r = sweep(s, now, user);
  const item = r.created.find((i) => i.refs?.visitIds?.includes(v.id));
  return { visit: visitView(s, v), queueItem: item && queueView(s, item, now), rule: { graceMinutes: rules.confirmationGraceMinutes } };
});

route('POST', '/api/demo/reset', 'demo:run', ({ s, user }) => {
  const fresh = createStore();
  for (const k of ['caregivers', 'clients', 'visits', 'handovers', 'summaries', 'incidents', 'queue', 'settings', 'lastSweep']) s[k] = fresh[k];
  s.audit.append({ actor: user, action: 'demo.reset', entity: 'agency', entityId: s.agency.id, detail: { synthetic: true } });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Public website
// ---------------------------------------------------------------------------

route('POST', '/api/public/demo-request', 'public', async ({ s, body, now }) => {
  required(body, ['name', 'email', 'agency', 'sizeBand', 'state', 'role']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) throw httpError(400, 'Enter a valid work email.');
  if (!AGENCY_SIZE_BANDS.includes(body.sizeBand)) throw httpError(400, 'Choose an agency size.');
  if (body.website) return { ok: true }; // honeypot
  const clean = (v, n) => String(v).trim().slice(0, n);
  const lead = {
    id: s.newId('LEAD-'), createdAt: iso(ms(now)),
    name: clean(body.name, 80), email: clean(body.email, 120).toLowerCase(), agency: clean(body.agency, 120), sizeBand: body.sizeBand,
    state: clean(body.state, 40), role: clean(body.role, 80), message: body.message ? clean(body.message, 1000) : null,
    consent: !!body.consent,
  };
  s.leads.push(lead);
  let crm;
  try {
    const bundle = demoRequestToCrm(lead); // message is deliberately not part of the CRM payload
    crm = await syncToHubSpot(bundle);
    s.crmOutbox.push({ leadId: lead.id, at: lead.createdAt, mode: crm.mode, payload: bundle });
  } catch (err) {
    s.crmOutbox.push({ leadId: lead.id, at: lead.createdAt, mode: 'blocked', error: err.message });
  }
  s.audit.append({ action: 'lead.created', entity: 'lead', entityId: lead.id, detail: { crm: crm?.mode || 'blocked' } });
  return { ok: true, reference: lead.id };
});
