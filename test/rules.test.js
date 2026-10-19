import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSchedulingConflicts, monitorVisitRecords, monitorFollowUps, reconcileQueue, suggestCoverage, travelMinutes, DEFAULT_RULES } from '../shared/rules.js';
import { buildSeed } from '../data/seed.js';

// Fixed Wednesday 06:00 local
const day = new Date(2026, 9, 21, 0, 0, 0).getTime();
const at = (h, m = 0) => new Date(day + (h * 60 + m) * 60000).toISOString();
const now = at(6);
const wd = new Date(day).getDay();

const cg = (id, extra = {}) => ({ id, name: id, status: 'active', homeZone: 'Old Town', credentials: ['HHA'], availability: [{ day: wd, start: '07:00', end: '19:00' }], timeOff: [], ...extra });
const clients = [
  { id: 'c1', label: 'Client 1', zone: 'Old Town', requiredCredentials: [] },
  { id: 'c2', label: 'Client 2', zone: 'Lakeshore', requiredCredentials: [] },
  { id: 'c3', label: 'Client 3', zone: 'Eastfield', requiredCredentials: ['Hoyer lift'] },
];
const visit = (id, caregiverId, clientId, s, e, extra = {}) => ({ id, caregiverId, clientId, start: s, end: e, status: 'scheduled', confirmation: {}, record: {}, ...extra });
const codes = (fs) => fs.map((f) => f.code).sort();

test('detects overlapping assignments', () => {
  const visits = [visit('v1', 'a', 'c1', at(8), at(10)), visit('v2', 'a', 'c1', at(9), at(11))];
  const f = detectSchedulingConflicts({ visits, caregivers: [cg('a')], clients, now });
  assert.ok(codes(f).includes('double_booked'));
  assert.equal(f.find((x) => x.code === 'double_booked').severity, 'critical');
});

test('clean schedule produces no findings', () => {
  const visits = [visit('v1', 'a', 'c1', at(8), at(10)), visit('v2', 'a', 'c1', at(11), at(13))];
  assert.deepEqual(detectSchedulingConflicts({ visits, caregivers: [cg('a')], clients, now }), []);
});

test('flags time off and outside-availability separately', () => {
  const a = cg('a', { timeOff: [{ start: at(0), end: at(23), reason: 'Leave' }] });
  const b = cg('b');
  const visits = [visit('v1', 'a', 'c1', at(8), at(10)), visit('v2', 'b', 'c1', at(20), at(21))];
  const f = detectSchedulingConflicts({ visits, caregivers: [a, b], clients, now });
  assert.deepEqual(codes(f), ['caregiver_time_off', 'outside_availability']);
});

test('flags travel risk using configured zone estimates', () => {
  // Old Town -> Lakeshore = 2 grid steps = 12 + 18 + 10 buffer = 40 min needed
  assert.equal(travelMinutes('Old Town', 'Lakeshore', DEFAULT_RULES), 30);
  const visits = [visit('v1', 'a', 'c1', at(8), at(10)), visit('v2', 'a', 'c2', at(10, 20), at(11))];
  const f = detectSchedulingConflicts({ visits, caregivers: [cg('a')], clients, now });
  assert.deepEqual(codes(f), ['travel_risk']);
  const ok = [visit('v1', 'a', 'c1', at(8), at(10)), visit('v2', 'a', 'c2', at(10, 45), at(11))];
  assert.deepEqual(detectSchedulingConflicts({ visits: ok, caregivers: [cg('a')], clients, now }), []);
});

test('flags missing credentials and missing coverage by urgency', () => {
  const visits = [visit('v1', 'a', 'c3', at(8), at(9)), visit('v2', null, 'c1', at(10), at(12)), visit('v3', null, 'c1', at(8 + 48), at(10 + 48))];
  const f = detectSchedulingConflicts({ visits, caregivers: [cg('a', { homeZone: 'Eastfield' })], clients, now });
  assert.ok(codes(f).includes('credential_mismatch'));
  const cov = f.filter((x) => x.code === 'missing_coverage');
  assert.equal(cov.find((x) => x.refs.visitIds[0] === 'v2').severity, 'critical');
  assert.equal(cov.find((x) => x.refs.visitIds[0] === 'v3').severity, 'medium');
});

test('confirmation monitor: unconfirmed, late check-in, missing check-out, incomplete record', () => {
  const t = at(14);
  const visits = [
    visit('u', 'a', 'c1', at(11), at(13)),                                                   // ended 60 min ago, nothing
    visit('l', 'a', 'c1', at(13, 15), at(15)),                                               // started 45 min ago, no check-in
    visit('o', 'a', 'c1', at(10), at(13), { confirmation: { checkIn: at(10) } }),            // no check-out
    visit('r', 'a', 'c1', at(-30), at(-28), { confirmation: { checkIn: at(-30), checkOut: at(-28) }, record: { timesheetSigned: false, tasksDocumented: true, mileageLogged: true } }),
    visit('g', 'a', 'c1', at(13, 45), at(15)),                                               // started 15 min ago: within grace
  ];
  const f = monitorVisitRecords({ visits, now: t });
  const byVisit = Object.fromEntries(f.map((x) => [x.refs.visitIds[0], x.code]));
  assert.deepEqual(byVisit, { u: 'visit_unconfirmed', l: 'late_check_in', o: 'missing_check_out', r: 'incomplete_record' });
});

test('follow-up monitor flags overdue incidents and stale AI drafts', () => {
  const f = monitorFollowUps({
    incidents: [{ id: 'i1', title: 'x', status: 'triaged', severity: 'high', followUpDueAt: at(4) }, { id: 'i2', title: 'y', status: 'resolved', followUpDueAt: at(1) }],
    summaries: [{ id: 's1', status: 'pending_review', createdAt: at(-10) }],
    now,
  });
  assert.deepEqual(codes(f), ['incident_follow_up_overdue', 'summary_review_pending']);
});

test('queue: dedupes, never auto-resolves, marks cleared conditions', () => {
  const findings = monitorVisitRecords({ visits: [visit('u', 'a', 'c1', at(11), at(13))], now: at(14) });
  const items = [];
  let n = 0;
  const id = () => `Q${++n}`;
  reconcileQueue(items, findings, at(14), DEFAULT_RULES, id);
  reconcileQueue(items, findings, at(14, 1), DEFAULT_RULES, id);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].createdAt, at(13, 30), 'item dates from when the condition began');
  const r = reconcileQueue(items, [], at(14, 2), DEFAULT_RULES, id);
  assert.equal(r.cleared.length, 1);
  assert.equal(items[0].status, 'open', 'a person must resolve it');
  assert.equal(items[0].conditionActive, false);
});

test('coverage suggestions exclude blocked caregivers and rank by fit', () => {
  const v = visit('open', null, 'c1', at(9), at(11));
  const busy = visit('b1', 'busy', 'c1', at(9), at(11));
  const out = suggestCoverage({ visit: v, visits: [v, busy], caregivers: [cg('busy'), cg('near'), cg('far', { homeZone: 'Lakeshore' })], clients, now });
  assert.deepEqual(out.map((s) => s.caregiverId), ['near', 'far']);
});

test('seed data is synthetic and exercises every scheduling and confirmation rule', () => {
  const s = buildSeed(new Date(2026, 9, 21, 14, 0).getTime());
  assert.ok(s.caregivers.every((c) => c.synthetic) && s.visits.every((v) => v.synthetic) && s.handovers.every((h) => h.synthetic));
  const all = [...detectSchedulingConflicts({ ...s, now: new Date(2026, 9, 21, 14, 0).toISOString() }), ...monitorVisitRecords({ ...s, now: new Date(2026, 9, 21, 14, 0).toISOString() })];
  for (const code of ['double_booked', 'caregiver_time_off', 'credential_mismatch', 'missing_coverage', 'travel_risk', 'weekly_hours_exceeded', 'visit_unconfirmed', 'late_check_in', 'missing_check_out', 'incomplete_record']) {
    assert.ok(all.some((f) => f.code === code), `expected ${code}`);
  }
});
