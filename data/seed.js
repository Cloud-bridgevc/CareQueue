// Synthetic demonstration data for a FICTIONAL agency.
// Every person, client and note below is invented. No real care information.
// Data is generated relative to `now` so the demo always looks current, and a
// fixed PRNG seed keeps it reproducible.

import { iso, ms, DAY, HOUR, MINUTE, startOfDay, parseHM, startOfWeek } from '../shared/time.js';

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const AGENCY = { id: 'ag-harborview', name: 'Harborview Home Care', synthetic: true, timezone: 'local' };

export const STAFF = [
  { id: 'u-admin', name: 'Dana Whitfield', role: 'admin', title: 'Operations Director' },
  { id: 'u-sched', name: 'Marco Alvarez', role: 'scheduler', title: 'Scheduling Coordinator' },
  { id: 'u-sup', name: 'Priya Raman', role: 'supervisor', title: 'Care Coordination Supervisor' },
  { id: 'u-sup2', name: 'Tomás Herrera', role: 'supervisor', title: 'Field Supervisor' },
  { id: 'u-aud', name: 'Grace Liu', role: 'auditor', title: 'Compliance Officer' },
  { id: 'u-cg01', name: 'Amara Okafor', role: 'caregiver', title: 'Home Health Aide', caregiverId: 'cg-01' },
];

const CAREGIVER_DEFS = [
  ['cg-01', 'Amara Okafor', 'HHA', 'Old Town', ['HHA', 'CPR'], ['English', 'Igbo'], 'full'],
  ['cg-02', 'Ben Kowalski', 'CNA', 'Northgate', ['CNA', 'CPR', 'Hoyer lift'], ['English', 'Polish'], 'full'],
  ['cg-03', 'Lucía Fernández', 'HHA', 'Riverside', ['HHA', 'CPR'], ['English', 'Spanish'], 'full'],
  ['cg-04', 'Kenji Watanabe', 'Companion', 'Eastfield', ['CPR'], ['English', 'Japanese'], 'part'],
  ['cg-05', 'Fatima Haddad', 'CNA', 'Southbend', ['CNA', 'CPR', 'Dementia care'], ['English', 'Arabic'], 'full'],
  ['cg-06', 'Jordan Ellis', 'HHA', 'Old Town', ['HHA', 'CPR', 'Hoyer lift'], ['English'], 'full'],
  ['cg-07', 'Mei-Ling Chen', 'CNA', 'Lakeshore', ['CNA', 'CPR'], ['English', 'Mandarin'], 'full'],
  ['cg-08', 'Samuel Mensah', 'Companion', 'Riverside', ['CPR'], ['English', 'Twi'], 'part'],
  ['cg-09', 'Olivia Brennan', 'HHA', 'Northgate', ['HHA', 'CPR', 'Dementia care'], ['English'], 'full'],
  ['cg-10', 'Ravi Patel', 'CNA', 'Eastfield', ['CNA', 'CPR'], ['English', 'Gujarati'], 'full'],
  ['cg-11', 'Hannah Schmidt', 'HHA', 'Southbend', ['HHA', 'CPR'], ['English', 'German'], 'full'],
  ['cg-12', 'Diego Morales', 'Companion', 'Lakeshore', ['CPR'], ['English', 'Spanish'], 'part'],
];

const CLIENT_DEFS = [
  ['cl-1001', 'Old Town', [], 'English'], ['cl-1002', 'Old Town', ['Hoyer lift'], 'English'],
  ['cl-1003', 'Northgate', [], 'Polish'], ['cl-1004', 'Northgate', ['Dementia care'], 'English'],
  ['cl-1005', 'Riverside', [], 'Spanish'], ['cl-1006', 'Riverside', [], 'English'],
  ['cl-1007', 'Eastfield', [], 'Japanese'], ['cl-1008', 'Eastfield', [], 'English'],
  ['cl-1009', 'Southbend', ['Dementia care'], 'Arabic'], ['cl-1010', 'Southbend', [], 'English'],
  ['cl-1011', 'Lakeshore', [], 'Mandarin'], ['cl-1012', 'Lakeshore', [], 'English'],
  ['cl-1013', 'Old Town', [], 'English'], ['cl-1014', 'Northgate', [], 'English'],
  ['cl-1015', 'Riverside', [], 'English'], ['cl-1016', 'Eastfield', [], 'Gujarati'],
  ['cl-1017', 'Southbend', [], 'German'], ['cl-1018', 'Lakeshore', [], 'Spanish'],
];
const INITIALS = ['R.M.', 'E.T.', 'W.K.', 'J.D.', 'A.G.', 'H.B.', 'S.N.', 'L.P.', 'Z.A.', 'M.C.', 'Y.W.', 'P.O.', 'G.F.', 'T.R.', 'N.V.', 'K.S.', 'I.L.', 'C.Q.'];

const SERVICE_TYPES = ['Personal care visit', 'Companion visit', 'Respite visit', 'Homemaker visit'];

function at(dayMs, hm) {
  return dayMs + parseHM(hm) * MINUTE;
}

export function buildSeed(now = Date.now()) {
  const rnd = prng(20261018);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const today = startOfDay(now);
  const nowMs = ms(now);

  const caregivers = CAREGIVER_DEFS.map(([id, name, role, homeZone, credentials, languages, type], i) => {
    // Full-time: 5 days with two rotating days off so all 7 days are covered.
    const days = type === 'part' ? [1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== i % 7 && d !== (i + 1) % 7);
    const early = i % 2 === 0;
    return {
      id, name, role, homeZone, credentials, languages, synthetic: true,
      employment: type === 'part' ? 'Part-time' : 'Full-time',
      status: 'active',
      maxWeeklyHours: type === 'part' ? 20 : 40,
      phoneMasked: `(555) 01${String(i).padStart(2, '0')}-••••`,
      availability: days.map((day) => ({ day, start: early ? '07:00' : '10:00', end: early ? '16:00' : '19:00' })),
      timeOff: [],
      priorClientIds: [],
      hireDate: iso(today - (200 + i * 61) * DAY).slice(0, 10),
    };
  });

  const clients = CLIENT_DEFS.map(([id, zone, requiredCredentials, preferredLanguage], i) => ({
    id, label: `Client ${id.slice(3)} (${INITIALS[i]})`, zone, requiredCredentials, preferredLanguage,
    synthetic: true, serviceStart: iso(today - (90 + i * 13) * DAY).slice(0, 10), status: 'active',
  }));
  const clientsByZone = (z) => clients.filter((c) => c.zone === z);

  // Zones adjacent on the grid (≤1 step) keep generated travel realistic.
  const NEAR = {
    'Old Town': ['Old Town', 'Northgate', 'Riverside', 'Eastfield', 'Southbend'],
    Northgate: ['Northgate', 'Old Town'], Riverside: ['Riverside', 'Old Town', 'Lakeshore'],
    Eastfield: ['Eastfield', 'Old Town'], Southbend: ['Southbend', 'Old Town', 'Lakeshore'],
    Lakeshore: ['Lakeshore', 'Riverside', 'Southbend'],
  };

  const visits = [];
  let seq = 4000;
  const addVisit = (v) => { const visit = { id: `V-${++seq}`, serviceType: pick(SERVICE_TYPES), status: 'scheduled', confirmation: {}, record: {}, requiredCredentials: [], synthetic: true, ...v }; visits.push(visit); return visit; };

  // Routine schedule: 3 visits/day, 2 h each, 45 min apart, clients near home zone.
  for (let d = -7; d <= 7; d++) {
    const dayMs = today + d * DAY;
    const weekday = new Date(dayMs).getDay();
    for (const c of caregivers) {
      const win = c.availability.find((w) => w.day === weekday);
      if (!win) continue;
      const pool = NEAR[c.homeZone].flatMap(clientsByZone).filter((cl) => cl.requiredCredentials.every((r) => c.credentials.includes(r)));
      const slots = c.maxWeeklyHours <= 20 ? 2 : 3;
      for (let s = 0; s < slots; s++) {
        const start = at(dayMs, win.start) + s * 165 * MINUTE;
        const client = pool[(s + d + 14 + caregivers.indexOf(c)) % pool.length];
        if (!c.priorClientIds.includes(client.id)) c.priorClientIds.push(client.id);
        addVisit({ clientId: client.id, caregiverId: c.id, start: iso(start), end: iso(start + 2 * HOUR) });
      }
    }
  }

  // Past visits get confirmations and (mostly) complete records.
  for (const v of visits) {
    if (ms(v.end) <= nowMs - 2 * HOUR) {
      v.status = 'completed';
      v.confirmation = {
        checkIn: iso(ms(v.start) + Math.round((rnd() * 14 - 4)) * MINUTE),
        checkOut: iso(ms(v.end) + Math.round(rnd() * 10) * MINUTE),
        method: rnd() < 0.85 ? 'EVV mobile' : 'Telephony',
      };
      v.record = { timesheetSigned: true, tasksDocumented: true, mileageLogged: true };
    } else if (ms(v.start) <= nowMs && ms(v.end) > nowMs - 2 * HOUR) {
      v.status = ms(v.end) <= nowMs ? 'completed' : 'in_progress';
      v.confirmation = { checkIn: iso(ms(v.start) + 3 * MINUTE), method: 'EVV mobile' };
      if (ms(v.end) <= nowMs) v.confirmation.checkOut = iso(ms(v.end) + 2 * MINUTE);
      v.record = { timesheetSigned: false, tasksDocumented: false, mileageLogged: false };
    }
  }

  // A handful of historical gaps so reports show recurring patterns.
  const pastDone = visits.filter((v) => v.status === 'completed' && ms(v.end) < nowMs - 30 * HOUR);
  const byCg = (id) => pastDone.filter((v) => v.caregiverId === id);
  for (const v of byCg('cg-06').slice(0, 3)) v.record.timesheetSigned = false;
  for (const v of byCg('cg-10').slice(1, 3)) v.record.mileageLogged = false;
  const cancelled = pastDone.filter((v) => v.clientId === 'cl-1009').slice(0, 2);
  for (const v of cancelled) { v.status = 'cancelled'; v.cancelReason = 'Client family request'; v.confirmation = {}; }

  // ---- Deliberate demo scenarios -----------------------------------------
  const tomorrow = today + DAY;
  const worksOn = (cgId, dayMs) => caregivers.find((c) => c.id === cgId).availability.some((w) => w.day === new Date(dayMs).getDay());
  const nextWorkday = (cgId, fromOffset) => {
    let t = today + fromOffset * DAY;
    while (!worksOn(cgId, t)) t += DAY;
    return t;
  };
  const routineOn = (cgId, dayMs) => visits.filter((v) => v.caregiverId === cgId && startOfDay(v.start) === dayMs).sort((a, b) => ms(a.start) - ms(b.start));
  // Live scenarios replace any routine visit they would collide with, so each shows one clear issue.
  const addLive = (v) => {
    for (let i = visits.length - 1; i >= 0; i--) {
      const r = visits[i];
      if (r.caregiverId === v.caregiverId && ms(r.start) < ms(v.end) + HOUR && ms(v.start) - HOUR < ms(r.end)) visits.splice(i, 1);
    }
    return addVisit(v);
  };

  // 1) Missing confirmation: visit ended ~55 min ago, nothing recorded.
  const s1 = nowMs - 3 * HOUR - 55 * MINUTE;
  const demoMissed = addLive({ clientId: 'cl-1006', caregiverId: 'cg-08', start: iso(s1), end: iso(s1 + 3 * HOUR), status: 'scheduled', serviceType: 'Companion visit', scenario: 'missing_confirmation' });
  // 2) Checked in but no check-out.
  const s2 = nowMs - 2 * HOUR - 50 * MINUTE;
  addLive({ clientId: 'cl-1012', caregiverId: 'cg-12', start: iso(s2), end: iso(s2 + 2 * HOUR), status: 'in_progress', confirmation: { checkIn: iso(s2 + 4 * MINUTE), method: 'EVV mobile' }, record: { timesheetSigned: false, tasksDocumented: false, mileageLogged: false }, scenario: 'missing_check_out' });
  // 3) Started 50 min ago, no check-in yet.
  const s3 = nowMs - 50 * MINUTE;
  addLive({ clientId: 'cl-1015', caregiverId: 'cg-03', start: iso(s3), end: iso(s3 + 2 * HOUR), scenario: 'late_check_in' });

  // 4) Double booking: Ben Kowalski gets a second visit overlapping a routine one.
  const benDay = nextWorkday('cg-02', 1);
  const benFirst = routineOn('cg-02', benDay)[0];
  addVisit({ clientId: 'cl-1014', caregiverId: 'cg-02', start: iso(ms(benFirst.start) + 30 * MINUTE), end: benFirst.end, scenario: 'double_booked' });

  // 5) Time off: Jordan Ellis has approved leave but visits were not reassigned.
  const offDay = nextWorkday('cg-06', 2);
  caregivers.find((c) => c.id === 'cg-06').timeOff.push({ start: iso(offDay), end: iso(offDay + DAY), reason: 'Approved personal leave' });

  // 6) Travel risk: Mei-Ling Chen Lakeshore → Eastfield with a 15 min gap.
  const meiDay = nextWorkday('cg-07', 1);
  const meiLast = routineOn('cg-07', meiDay).at(-1);
  addVisit({ clientId: 'cl-1008', caregiverId: 'cg-07', start: iso(ms(meiLast.end) + 15 * MINUTE), end: iso(ms(meiLast.end) + 75 * MINUTE), serviceType: 'Homemaker visit', scenario: 'travel_risk' });

  // 7) Credential mismatch: companion assigned to a client whose plan requires lift training.
  const kenjiDay = nextWorkday('cg-04', 2);
  addVisit({ clientId: 'cl-1002', caregiverId: 'cg-04', start: iso(at(kenjiDay, '18:00')), end: iso(at(kenjiDay, '19:00')), scenario: 'credential_mismatch' });

  // 8) Open coverage: three unassigned visits soon.
  addVisit({ clientId: 'cl-1004', caregiverId: null, start: iso(nowMs + 6 * HOUR), end: iso(nowMs + 8 * HOUR), serviceType: 'Personal care visit', scenario: 'missing_coverage', note: 'Original caregiver called out' });
  addVisit({ clientId: 'cl-1011', caregiverId: null, start: iso(at(tomorrow, '13:00')), end: iso(at(tomorrow, '15:00')), scenario: 'missing_coverage' });
  addVisit({ clientId: 'cl-1017', caregiverId: null, start: iso(at(today + 2 * DAY, '09:00')), end: iso(at(today + 2 * DAY, '11:00')), scenario: 'missing_coverage' });

  // 9) Extra evening visits push part-timer Kenji past 20 h this week.
  const wk = startOfWeek(nowMs);
  for (let i = 0; i < 4; i++) {
    const day = wk + i * DAY;
    if (!worksOn('cg-04', day)) continue;
    const done = at(day, '17:00') < nowMs;
    addVisit({ clientId: 'cl-1007', caregiverId: 'cg-04', start: iso(at(day, '15:30')), end: iso(at(day, '17:00')), serviceType: 'Companion visit', scenario: 'weekly_hours',
      status: done ? 'completed' : 'scheduled',
      confirmation: done ? { checkIn: iso(at(day, '15:31')), checkOut: iso(at(day, '17:02')), method: 'EVV mobile' } : {},
      record: done ? { timesheetSigned: true, tasksDocumented: true, mileageLogged: true } : {} });
  }

  visits.sort((a, b) => ms(a.start) - ms(b.start));

  // ---- Administrative handover notes --------------------------------------
  const n = (hAgo, authorId, category, audience, text, extra = {}) => ({
    id: `HN-${String(handovers.length + 1).padStart(3, '0')}`, createdAt: iso(nowMs - hAgo * HOUR), authorId, category, audience, text, synthetic: true, requiresFollowUp: false, ...extra,
  });
  const handovers = [];
  handovers.push(n(14, 'u-sched', 'staffing', ['scheduler', 'supervisor'], 'Olivia Brennan called out for Thursday afternoon. Two visits need cover in Northgate. Ben Kowalski offered one slot; second still open.', { requiresFollowUp: true }));
  handovers.push(n(13, 'u-sched', 'scheduling', ['scheduler', 'supervisor'], 'Family of Client 1005 asked to move Tuesday visits to the afternoon starting next week. Waiting on confirmation from Lucía Fernández before changing the recurrence.', { requiresFollowUp: true, refs: { clientId: 'cl-1005' } }));
  handovers.push(n(12, 'u-sup', 'access', ['scheduler', 'supervisor', 'caregiver'], 'Client 1013: driveway being repaved this week. Caregivers should park on the street and use the side gate. Lockbox code changed — new code is stored in the secure access record, not in notes.'));
  handovers.push(n(11, 'u-sched', 'documentation', ['supervisor'], 'Timesheets for three Jordan Ellis visits last week are still unsigned. Jordan says the client’s son will sign on Friday. Call back at 555-0147 if not done.', { requiresFollowUp: true }));
  handovers.push(n(10, 'u-sup2', 'follow_up', ['supervisor'], 'Orientation shadow visit for new caregiver Diego Morales with Client 1018 still not scheduled. Needs to happen before he is assigned solo.', { requiresFollowUp: true }));
  handovers.push(n(9, 'u-sched', 'logistics', ['scheduler', 'supervisor'], 'Eastfield bridge closure on weekday mornings adds roughly 15 minutes from Old Town. Consider widening gaps for Ravi Patel and Kenji Watanabe.'));
  handovers.push(n(8, 'u-sup', 'care_observation', ['supervisor'], 'Caregiver mentioned Client 1009 seemed more tired than usual during the visit. Passed to the clinical lead per policy; no scheduling change requested.', { restricted: true }));
  handovers.push(n(6, 'u-sched', 'family_request', ['scheduler', 'supervisor'], 'Client 1011 daughter (contact on file) requested a Mandarin-speaking caregiver for the Saturday visit when possible.', { refs: { clientId: 'cl-1011' } }));
  handovers.push(n(3, 'u-sched', 'staffing', ['scheduler', 'supervisor'], 'Fatima Haddad picked up the Southbend open shift for Wednesday. Coverage board updated. Still need cover for Client 1004 this evening — original caregiver called out.', { requiresFollowUp: true, refs: { clientId: 'cl-1004' } }));

  // ---- Incidents (administrative escalation records) ----------------------
  const incidents = [
    {
      id: 'INC-201', title: 'Caregiver no-show reported by family', category: 'missed_visit', severity: 'high', status: 'escalated', escalationLevel: 2,
      reportedAt: iso(nowMs - 30 * HOUR), reportedBy: 'u-sched', ownerId: 'u-sup', followUpDueAt: iso(nowMs - 6 * HOUR),
      description: 'Family of Client 1010 called to report that the scheduled morning visit did not take place. Replacement visit arranged for the afternoon.',
      refs: { clientId: 'cl-1010' }, synthetic: true,
      timeline: [
        { at: iso(nowMs - 30 * HOUR), by: 'u-sched', action: 'reported', note: 'Call received from family.' },
        { at: iso(nowMs - 29 * HOUR), by: 'u-sup', action: 'triaged', note: 'Replacement visit arranged; caregiver contacted.' },
        { at: iso(nowMs - 20 * HOUR), by: 'u-sup', action: 'escalated', note: 'Escalated to Operations Director for staffing review.' },
      ],
    },
    {
      id: 'INC-202', title: 'Unable to access home at visit start', category: 'access_issue', severity: 'medium', status: 'triaged', escalationLevel: 1,
      reportedAt: iso(nowMs - 5 * HOUR), reportedBy: 'u-cg01', ownerId: 'u-sup2', followUpDueAt: iso(nowMs + 3 * HOUR),
      description: 'Caregiver arrived at Client 1013; side gate locked due to driveway work. Contacted office; family opened gate 20 minutes later.',
      refs: { clientId: 'cl-1013', caregiverId: 'cg-01' }, synthetic: true,
      timeline: [
        { at: iso(nowMs - 5 * HOUR), by: 'u-cg01', action: 'reported', note: 'Reported via caregiver app.' },
        { at: iso(nowMs - 4.5 * HOUR), by: 'u-sup2', action: 'triaged', note: 'Access note updated; family reminded about gate.' },
      ],
    },
    {
      id: 'INC-203', title: 'Minor vehicle damage in client driveway', category: 'property', severity: 'low', status: 'resolved', escalationLevel: 1,
      reportedAt: iso(nowMs - 4 * DAY), reportedBy: 'u-sched', ownerId: 'u-sup', followUpDueAt: iso(nowMs - 2 * DAY), resolvedAt: iso(nowMs - 3 * DAY),
      description: 'Caregiver reported scraping a mailbox post while reversing. Owner notified; insurance form filed.', refs: {}, synthetic: true,
      timeline: [
        { at: iso(nowMs - 4 * DAY), by: 'u-sched', action: 'reported' },
        { at: iso(nowMs - 3 * DAY), by: 'u-sup', action: 'resolved', note: 'Insurance form filed; owner satisfied.' },
      ],
    },
  ];

  // ---- Historical queue items (resolved) to give the reports some history --
  const queue = [];
  const hist = (code, label, category, severity, hoursAgo, resolveAfterH, refs, title) => queue.push({
    id: `Q-H${queue.length + 1}`, dedupKey: `hist:${queue.length + 1}`, code, label, category, severity, title, detail: 'Historical item (synthetic).', basis: 'Historical', refs, source: 'rules',
    status: 'resolved', assigneeId: 'u-sup', conditionActive: false, createdAt: iso(nowMs - hoursAgo * HOUR), lastSeenAt: iso(nowMs - hoursAgo * HOUR), dueAt: iso(nowMs - (hoursAgo - 8) * HOUR),
    resolvedAt: iso(nowMs - (hoursAgo - resolveAfterH) * HOUR), resolution: 'Confirmed with caregiver; record corrected.',
    history: [{ at: iso(nowMs - hoursAgo * HOUR), by: 'system', action: 'created' }, { at: iso(nowMs - (hoursAgo - resolveAfterH) * HOUR), by: 'u-sup', action: 'resolved' }],
  });
  hist('visit_unconfirmed', 'Visit not confirmed', 'confirmation', 'critical', 120, 3, { caregiverId: 'cg-08', clientId: 'cl-1006' }, 'No confirmation for Samuel Mensah’s visit');
  hist('visit_unconfirmed', 'Visit not confirmed', 'confirmation', 'critical', 72, 2, { caregiverId: 'cg-08', clientId: 'cl-1015' }, 'No confirmation for Samuel Mensah’s visit');
  hist('incomplete_record', 'Incomplete visit record', 'records', 'medium', 100, 30, { caregiverId: 'cg-06', clientId: 'cl-1002' }, 'Visit record incomplete (Jordan Ellis)');
  hist('incomplete_record', 'Incomplete visit record', 'records', 'medium', 60, 26, { caregiverId: 'cg-06', clientId: 'cl-1013' }, 'Visit record incomplete (Jordan Ellis)');
  hist('travel_risk', 'Tight travel between visits', 'scheduling', 'medium', 90, 5, { caregiverId: 'cg-10', clientId: 'cl-1008' }, 'Ravi Patel may not reach the next visit on time');
  hist('travel_risk', 'Tight travel between visits', 'scheduling', 'medium', 40, 4, { caregiverId: 'cg-10', clientId: 'cl-1016' }, 'Ravi Patel may not reach the next visit on time');
  hist('missing_coverage', 'Visit has no caregiver', 'coverage', 'high', 50, 6, { clientId: 'cl-1004' }, 'Visit for Client 1004 has no caregiver');

  return { agency: AGENCY, staff: STAFF, caregivers, clients, visits, handovers, summaries: [], incidents, queue, demoMissedVisitId: demoMissed.id };
}
