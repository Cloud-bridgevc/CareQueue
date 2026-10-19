// CareQueue rules engine.
//
// Detection is deterministic and explainable: every finding names the rule
// that produced it and the recorded data it relied on. Nothing here assesses
// clinical condition or patient safety — findings are about schedules and
// administrative records only. The same module runs on the server, in the
// background Lambda sweep, and in the browser (public scheduling demo).

import { ms, iso, overlaps, parseHM, minutesOfDay, sameLocalDay, startOfWeek, durationHours, MINUTE, HOUR, DAY } from './time.js';

export const DEFAULT_RULES = {
  confirmationGraceMinutes: 30,      // check-in / check-out may lag the schedule by this much
  recordCompletionHours: 24,         // timesheet + visit documentation due after check-out
  coverageHorizonHours: 72,          // unassigned visits inside this window are flagged
  travelBufferMinutes: 10,           // added to estimated travel between consecutive visits
  travelBaseMinutes: 12,             // estimated travel within the same zone
  travelPerZoneStepMinutes: 9,       // added per grid step between zones
  defaultMaxWeeklyHours: 40,
  summaryReviewHours: 8,             // AI drafts awaiting review longer than this are surfaced
  followUpSlaHours: { critical: 2, high: 8, medium: 24, low: 72 },
  // Service zones on a coarse grid; travel time is an estimate, not routing.
  zones: {
    Northgate: [1, 0], Riverside: [0, 1], 'Old Town': [1, 1], Eastfield: [2, 1], Southbend: [1, 2], Lakeshore: [0, 2],
  },
};

export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export const FINDING_CODES = {
  double_booked: { label: 'Overlapping assignments', category: 'scheduling' },
  caregiver_time_off: { label: 'Assigned during time off', category: 'scheduling' },
  outside_availability: { label: 'Outside recorded availability', category: 'scheduling' },
  credential_mismatch: { label: 'Credential requirement not met', category: 'scheduling' },
  missing_coverage: { label: 'Visit has no caregiver', category: 'coverage' },
  travel_risk: { label: 'Tight travel between visits', category: 'scheduling' },
  weekly_hours_exceeded: { label: 'Weekly hours above limit', category: 'scheduling' },
  late_check_in: { label: 'No check-in recorded', category: 'confirmation' },
  visit_unconfirmed: { label: 'Visit not confirmed', category: 'confirmation' },
  missing_check_out: { label: 'No check-out recorded', category: 'confirmation' },
  incomplete_record: { label: 'Incomplete visit record', category: 'records' },
  incident_follow_up_overdue: { label: 'Incident follow-up overdue', category: 'follow_up' },
  summary_review_pending: { label: 'Summary awaiting review', category: 'follow_up' },
};

const ACTIVE = new Set(['scheduled', 'in_progress']);

export function mergeRules(overrides = {}) {
  return {
    ...DEFAULT_RULES,
    ...overrides,
    followUpSlaHours: { ...DEFAULT_RULES.followUpSlaHours, ...(overrides.followUpSlaHours || {}) },
    zones: { ...DEFAULT_RULES.zones, ...(overrides.zones || {}) },
  };
}

export function travelMinutes(fromZone, toZone, rules = DEFAULT_RULES) {
  const a = rules.zones[fromZone];
  const b = rules.zones[toZone];
  if (!a || !b) return rules.travelBaseMinutes + 3 * rules.travelPerZoneStepMinutes; // unknown zone: assume far
  const steps = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  return rules.travelBaseMinutes + steps * rules.travelPerZoneStepMinutes;
}

export function withinAvailability(caregiver, visit) {
  if (!sameLocalDay(visit.start, ms(visit.end) - 1)) return false;
  const day = new Date(ms(visit.start)).getDay();
  const s = minutesOfDay(visit.start);
  const e = minutesOfDay(ms(visit.end) - 1) + 1;
  return (caregiver.availability || []).some((w) => w.day === day && parseHM(w.start) <= s && e <= parseHM(w.end));
}

function finding(code, severity, fields) {
  const meta = FINDING_CODES[code];
  return { code, category: meta.category, label: meta.label, severity, ...fields };
}

function index(list) {
  return new Map(list.map((x) => [x.id, x]));
}

// ---------------------------------------------------------------------------
// 1. Scheduling conflict detection
// ---------------------------------------------------------------------------

export function detectSchedulingConflicts({ visits, caregivers, clients, now, rules = DEFAULT_RULES }) {
  const findings = [];
  const cg = index(caregivers);
  const cl = index(clients);
  const nowMs = ms(now);
  const upcoming = visits.filter((v) => ACTIVE.has(v.status) && ms(v.end) > nowMs);

  // Per-caregiver checks
  const byCaregiver = new Map();
  for (const v of upcoming) {
    if (!v.caregiverId) continue;
    if (!byCaregiver.has(v.caregiverId)) byCaregiver.set(v.caregiverId, []);
    byCaregiver.get(v.caregiverId).push(v);
  }

  for (const [caregiverId, list] of byCaregiver) {
    const c = cg.get(caregiverId);
    if (!c) continue;
    list.sort((a, b) => ms(a.start) - ms(b.start));

    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const client = cl.get(v.clientId);

      // Overlaps (any later visit that starts before this one ends)
      for (let j = i + 1; j < list.length && ms(list[j].start) < ms(v.end); j++) {
        const w = list[j];
        if (!overlaps(v, w)) continue;
        findings.push(finding('double_booked', 'critical', {
          dedupKey: `double_booked:${[v.id, w.id].sort().join('+')}`,
          title: `${c.name} is booked on two visits at once`,
          detail: `Visits ${v.id} and ${w.id} overlap by ${Math.round((Math.min(ms(v.end), ms(w.end)) - ms(w.start)) / MINUTE)} minutes.`,
          basis: 'Recorded visit start/end times for the same caregiver overlap.',
          refs: { caregiverId, visitIds: [v.id, w.id] },
          at: v.start,
        }));
      }

      // Travel time to the next non-overlapping visit on the same day
      const next = list[i + 1];
      if (next && !overlaps(v, next) && sameLocalDay(v.end, next.start)) {
        const nextClient = cl.get(next.clientId);
        const need = travelMinutes(client?.zone, nextClient?.zone, rules) + rules.travelBufferMinutes;
        const gap = (ms(next.start) - ms(v.end)) / MINUTE;
        if (gap < need) {
          findings.push(finding('travel_risk', gap < need / 2 ? 'high' : 'medium', {
            dedupKey: `travel_risk:${v.id}->${next.id}`,
            title: `${c.name} may not reach the next visit on time`,
            detail: `${Math.round(gap)} min between ${client?.zone || 'unknown zone'} and ${nextClient?.zone || 'unknown zone'}; estimated ${need} min needed incl. buffer.`,
            basis: `Configured zone travel estimate (${rules.travelBaseMinutes} min base + ${rules.travelPerZoneStepMinutes} min per zone step) plus ${rules.travelBufferMinutes} min buffer. Estimates, not live routing.`,
            refs: { caregiverId, visitIds: [v.id, next.id] },
            at: next.start,
          }));
        }
      }

      // Time off
      const off = (c.timeOff || []).find((o) => overlaps(o, v));
      if (off) {
        findings.push(finding('caregiver_time_off', 'high', {
          dedupKey: `caregiver_time_off:${v.id}`,
          title: `${c.name} is assigned during recorded time off`,
          detail: `Visit ${v.id} falls within time off (${off.reason || 'unspecified'}).`,
          basis: 'Visit time overlaps a time-off entry on the caregiver record.',
          refs: { caregiverId, visitIds: [v.id], clientId: v.clientId },
          at: v.start,
        }));
      } else if (!withinAvailability(c, v)) {
        findings.push(finding('outside_availability', 'medium', {
          dedupKey: `outside_availability:${v.id}`,
          title: `${c.name} is assigned outside recorded availability`,
          detail: `Visit ${v.id} is not inside any availability window for that weekday.`,
          basis: 'Compared to the caregiver’s weekly availability windows.',
          refs: { caregiverId, visitIds: [v.id], clientId: v.clientId },
          at: v.start,
        }));
      }

      // Credentials required by the visit / client service plan (administrative requirement list)
      const required = [...new Set([...(client?.requiredCredentials || []), ...(v.requiredCredentials || [])])];
      const missing = required.filter((r) => !(c.credentials || []).includes(r));
      if (missing.length) {
        findings.push(finding('credential_mismatch', 'high', {
          dedupKey: `credential_mismatch:${v.id}`,
          title: `${c.name} lacks a required credential`,
          detail: `Visit ${v.id} requires: ${missing.join(', ')}.`,
          basis: 'Visit/service requirements compared with credentials on the caregiver record.',
          refs: { caregiverId, visitIds: [v.id], clientId: v.clientId },
          at: v.start,
        }));
      }
    }

    // Weekly hours (current week)
    const weekStart = startOfWeek(nowMs);
    const weekEnd = weekStart + 7 * DAY;
    const hours = visits
      .filter((v) => v.caregiverId === caregiverId && v.status !== 'cancelled' && ms(v.start) >= weekStart && ms(v.start) < weekEnd)
      .reduce((sum, v) => sum + durationHours(v), 0);
    const limit = c.maxWeeklyHours ?? rules.defaultMaxWeeklyHours;
    if (hours > limit) {
      findings.push(finding('weekly_hours_exceeded', 'medium', {
        dedupKey: `weekly_hours_exceeded:${caregiverId}:${iso(weekStart).slice(0, 10)}`,
        title: `${c.name} is scheduled ${hours.toFixed(1)} h this week`,
        detail: `Configured limit is ${limit} h.`,
        basis: 'Sum of scheduled visit durations for the current week vs. caregiver limit.',
        refs: { caregiverId },
        at: iso(weekStart),
      }));
    }
  }

  // Missing coverage
  const horizon = nowMs + rules.coverageHorizonHours * HOUR;
  for (const v of upcoming) {
    if (v.caregiverId || ms(v.start) > horizon) continue;
    const hoursAway = (ms(v.start) - nowMs) / HOUR;
    const severity = hoursAway < 12 ? 'critical' : hoursAway < 24 ? 'high' : 'medium';
    findings.push(finding('missing_coverage', severity, {
      dedupKey: `missing_coverage:${v.id}`,
      title: `Visit for ${cl.get(v.clientId)?.label || v.clientId} has no caregiver`,
      detail: `Starts ${hoursAway < 0 ? 'now' : `in ${hoursAway.toFixed(1)} h`}.`,
      basis: `Unassigned visit within the ${rules.coverageHorizonHours} h coverage horizon.`,
      refs: { visitIds: [v.id], clientId: v.clientId },
      at: v.start,
    }));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 2. Visit confirmation monitoring
// ---------------------------------------------------------------------------

export const RECORD_FIELDS = {
  timesheetSigned: 'Timesheet signature',
  tasksDocumented: 'Visit task checklist',
  mileageLogged: 'Mileage entry',
};

export function monitorVisitRecords({ visits, caregivers = [], clients = [], now, rules = DEFAULT_RULES }) {
  const findings = [];
  const nowMs = ms(now);
  const grace = rules.confirmationGraceMinutes * MINUTE;
  const cg = index(caregivers);
  const cl = index(clients);

  for (const v of visits) {
    if (v.status === 'cancelled') continue;
    const c = v.confirmation || {};
    const who = cg.get(v.caregiverId)?.name || 'Unassigned';
    const client = cl.get(v.clientId)?.label || v.clientId;
    const refs = { visitIds: [v.id], caregiverId: v.caregiverId || undefined, clientId: v.clientId };
    const start = ms(v.start);
    const end = ms(v.end);

    if (nowMs > end + grace && !c.checkIn && !c.checkOut) {
      findings.push(finding('visit_unconfirmed', 'critical', {
        dedupKey: `visit_unconfirmed:${v.id}`,
        title: `No confirmation for ${who}’s visit with ${client}`,
        detail: `Scheduled to end ${Math.round((nowMs - end) / MINUTE)} min ago. Neither check-in nor check-out was recorded.`,
        basis: `No EVV/manual confirmation more than ${rules.confirmationGraceMinutes} min after scheduled end. The visit may have happened; the record is what is missing.`,
        refs, at: v.end, since: iso(end + grace),
      }));
    } else if (nowMs > start + grace && nowMs <= end + grace && !c.checkIn) {
      findings.push(finding('late_check_in', 'high', {
        dedupKey: `late_check_in:${v.id}`,
        title: `${who} has not checked in with ${client}`,
        detail: `Visit started ${Math.round((nowMs - start) / MINUTE)} min ago.`,
        basis: `No check-in recorded ${rules.confirmationGraceMinutes} min after scheduled start.`,
        refs, at: v.start, since: iso(start + grace),
      }));
    } else if (nowMs > end + grace && c.checkIn && !c.checkOut) {
      findings.push(finding('missing_check_out', 'high', {
        dedupKey: `missing_check_out:${v.id}`,
        title: `${who} has no check-out for ${client}`,
        detail: `Checked in, but no check-out ${Math.round((nowMs - end) / MINUTE)} min after scheduled end.`,
        basis: `Check-out missing more than ${rules.confirmationGraceMinutes} min after scheduled end.`,
        refs, at: v.end, since: iso(end + grace),
      }));
    }

    if (c.checkOut && nowMs > ms(c.checkOut) + rules.recordCompletionHours * HOUR) {
      const record = v.record || {};
      const missing = Object.keys(RECORD_FIELDS).filter((k) => record[k] === false);
      if (missing.length) {
        findings.push(finding('incomplete_record', 'medium', {
          dedupKey: `incomplete_record:${v.id}`,
          title: `Visit record incomplete (${who}, ${client})`,
          detail: `Missing: ${missing.map((k) => RECORD_FIELDS[k]).join(', ')}.`,
          basis: `Administrative fields still open ${rules.recordCompletionHours} h after check-out.`,
          refs, at: v.end, since: iso(ms(c.checkOut) + rules.recordCompletionHours * HOUR),
        }));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 3. Follow-ups (incidents, AI drafts awaiting human review)
// ---------------------------------------------------------------------------

export function monitorFollowUps({ incidents = [], summaries = [], now, rules = DEFAULT_RULES }) {
  const findings = [];
  const nowMs = ms(now);
  for (const inc of incidents) {
    if (inc.status === 'resolved' || !inc.followUpDueAt || ms(inc.followUpDueAt) > nowMs) continue;
    findings.push(finding('incident_follow_up_overdue', inc.severity === 'high' ? 'high' : 'medium', {
      dedupKey: `incident_follow_up_overdue:${inc.id}`,
      title: `Follow-up overdue: ${inc.title}`,
      detail: `Incident ${inc.id} is "${inc.status}"; follow-up was due ${Math.round((nowMs - ms(inc.followUpDueAt)) / HOUR)} h ago.`,
      basis: 'Incident follow-up due date has passed without resolution.',
      refs: { incidentId: inc.id },
      at: inc.followUpDueAt, since: inc.followUpDueAt,
    }));
  }
  for (const s of summaries) {
    if (!['pending_review', 'needs_edit'].includes(s.status)) continue;
    if (nowMs - ms(s.createdAt) < rules.summaryReviewHours * HOUR) continue;
    findings.push(finding('summary_review_pending', 'low', {
      dedupKey: `summary_review_pending:${s.id}`,
      title: 'AI-drafted handover summary awaiting review',
      detail: `Draft ${s.id} has not been reviewed for ${Math.round((nowMs - ms(s.createdAt)) / HOUR)} h. It is not visible to staff until approved.`,
      basis: `Unreviewed AI draft older than ${rules.summaryReviewHours} h.`,
      refs: { summaryId: s.id },
      at: s.createdAt, since: iso(ms(s.createdAt) + rules.summaryReviewHours * HOUR),
    }));
  }
  return findings;
}

export function runAllMonitors(state, now, rules = DEFAULT_RULES) {
  return [
    ...detectSchedulingConflicts({ ...state, now, rules }),
    ...monitorVisitRecords({ ...state, now, rules }),
    ...monitorFollowUps({ ...state, now, rules }),
  ];
}

// ---------------------------------------------------------------------------
// 4. Supervisor attention queue
// ---------------------------------------------------------------------------

// Upsert findings into queue items. Items are never auto-resolved: when the
// underlying condition clears, the item is marked so a person can close it.
export function reconcileQueue(items, findings, now, rules = DEFAULT_RULES, newId = () => crypto.randomUUID()) {
  const nowIso = iso(ms(now));
  const open = new Map(items.filter((i) => i.status !== 'resolved').map((i) => [i.dedupKey, i]));
  const seen = new Set();
  const created = [];
  const cleared = [];

  for (const f of findings) {
    seen.add(f.dedupKey);
    const existing = open.get(f.dedupKey);
    if (existing) {
      existing.lastSeenAt = nowIso;
      existing.detail = f.detail;
      if (!existing.conditionActive) {
        existing.conditionActive = true;
        existing.history.push({ at: nowIso, by: 'system', action: 'condition_returned' });
      }
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
        existing.history.push({ at: nowIso, by: 'system', action: 'severity_raised', note: `${existing.severity} → ${f.severity}` });
        existing.severity = f.severity;
      }
      continue;
    }
    // Items date from when the condition began (a continuously running monitor would have raised it then).
    const raisedAt = f.since && ms(f.since) < ms(now) ? f.since : nowIso;
    const item = {
      id: newId(),
      dedupKey: f.dedupKey,
      code: f.code,
      category: f.category,
      label: f.label,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      basis: f.basis,
      refs: f.refs,
      source: 'rules',
      status: 'open',
      assigneeId: null,
      conditionActive: true,
      createdAt: raisedAt,
      lastSeenAt: nowIso,
      dueAt: iso(ms(raisedAt) + (rules.followUpSlaHours[f.severity] ?? 24) * HOUR),
      history: [{ at: raisedAt, by: 'system', action: 'created', note: f.basis }],
    };
    items.push(item);
    created.push(item);
  }

  for (const item of open.values()) {
    if (item.source !== 'rules' || seen.has(item.dedupKey) || !item.conditionActive) continue;
    item.conditionActive = false;
    item.history.push({ at: nowIso, by: 'system', action: 'condition_cleared', note: 'Underlying record no longer matches the rule. Review and resolve.' });
    cleared.push(item);
  }

  return { items, created, cleared };
}

export function isOverdue(item, now) {
  return item.status !== 'resolved' && ms(item.dueAt) < ms(now);
}

export function sortQueue(items, now) {
  return [...items].sort((a, b) =>
    (a.status === 'resolved') - (b.status === 'resolved') ||
    isOverdue(b, now) - isOverdue(a, now) ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    ms(a.dueAt) - ms(b.dueAt));
}

// ---------------------------------------------------------------------------
// 5. Coverage suggestions (ranked candidates for an open visit)
// ---------------------------------------------------------------------------

export function suggestCoverage({ visit, visits, caregivers, clients, now, rules = DEFAULT_RULES, limit = 5 }) {
  const client = clients.find((c) => c.id === visit.clientId);
  const required = [...new Set([...(client?.requiredCredentials || []), ...(visit.requiredCredentials || [])])];
  const candidates = [];

  for (const c of caregivers) {
    if (c.status !== 'active') continue;
    const trial = { ...visit, caregiverId: c.id };
    const others = visits.filter((v) => v.id !== visit.id);
    const result = detectSchedulingConflicts({ visits: [...others, trial], caregivers: [c], clients, now, rules })
      .filter((f) => f.refs.visitIds?.includes(visit.id) || f.code === 'weekly_hours_exceeded');
    const blocking = result.filter((f) => ['double_booked', 'caregiver_time_off', 'credential_mismatch'].includes(f.code));
    if (blocking.length) continue;
    const reasons = [];
    let score = 100;
    if (client?.zone === c.homeZone) { reasons.push('Home zone matches'); score += 10; }
    else score -= travelMinutes(c.homeZone, client?.zone, rules) / 3;
    if (client?.preferredLanguage && (c.languages || []).includes(client.preferredLanguage)) { reasons.push(`Speaks ${client.preferredLanguage}`); score += 8; }
    if ((c.priorClientIds || []).includes(visit.clientId)) { reasons.push('Has visited this client before'); score += 12; }
    if (required.length) reasons.push(`Holds ${required.join(', ')}`);
    for (const f of result) { reasons.push(`⚠ ${f.label}`); score -= SEVERITY_RANK[f.severity] === 1 ? 30 : 15; }
    candidates.push({ caregiverId: c.id, name: c.name, score: Math.round(score), reasons, warnings: result.map((f) => f.code) });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
