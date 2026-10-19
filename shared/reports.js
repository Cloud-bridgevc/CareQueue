// Operations reporting: visit completion records, staffing coverage and
// recurring coordination problems. Pure functions over operational records.

import { ms, DAY, durationHours } from './time.js';
import { FINDING_CODES } from './rules.js';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function computeOperationsReport({ visits, caregivers, clients, queue, incidents, now, days = 7 }) {
  const to = ms(now);
  const from = to - days * DAY;
  const cg = new Map(caregivers.map((c) => [c.id, c]));
  const cl = new Map(clients.map((c) => [c.id, c]));

  const past = visits.filter((v) => ms(v.end) <= to && ms(v.start) >= from && v.status !== 'cancelled');
  const confirmed = past.filter((v) => v.confirmation?.checkIn && v.confirmation?.checkOut);
  const recordsComplete = confirmed.filter((v) => v.record && Object.values(v.record).every(Boolean));
  const unconfirmed = past.filter((v) => !v.confirmation?.checkIn && !v.confirmation?.checkOut);
  const cancelled = visits.filter((v) => v.status === 'cancelled' && ms(v.start) >= from && ms(v.start) <= to);

  const nextWeek = visits.filter((v) => ms(v.start) > to && ms(v.start) <= to + 7 * DAY && v.status !== 'cancelled');
  const assigned = nextWeek.filter((v) => v.caregiverId);
  const scheduledHours = nextWeek.reduce((s, v) => s + durationHours(v), 0);

  const windowItems = queue.filter((i) => ms(i.createdAt) >= from);
  const byCode = {};
  for (const i of windowItems) byCode[i.code] = (byCode[i.code] || 0) + 1;

  // Recurring problems: the same rule firing ≥2 times for the same caregiver, client or zone.
  const recurringMap = new Map();
  for (const i of windowItems) {
    const keys = [];
    if (i.refs?.caregiverId) keys.push(['caregiver', i.refs.caregiverId, cg.get(i.refs.caregiverId)?.name]);
    if (i.refs?.clientId) {
      const c = cl.get(i.refs.clientId);
      keys.push(['client', i.refs.clientId, c?.label]);
      if (c?.zone) keys.push(['zone', c.zone, c.zone]);
    }
    for (const [kind, id, name] of keys) {
      const k = `${i.code}|${kind}|${id}`;
      const r = recurringMap.get(k) || { code: i.code, label: FINDING_CODES[i.code]?.label || i.code, kind, id, name: name || id, count: 0 };
      r.count++;
      recurringMap.set(k, r);
    }
  }
  const recurring = [...recurringMap.values()].filter((r) => r.count >= 2).sort((a, b) => b.count - a.count).slice(0, 8);

  const openItems = queue.filter((i) => i.status !== 'resolved');
  const resolvedInWindow = queue.filter((i) => i.status === 'resolved' && i.resolvedAt && ms(i.resolvedAt) >= from);
  const avgResolutionHours = resolvedInWindow.length
    ? Math.round((resolvedInWindow.reduce((s, i) => s + (ms(i.resolvedAt) - ms(i.createdAt)), 0) / resolvedInWindow.length / 3_600_000) * 10) / 10
    : null;

  // Daily series for the completion chart
  const daily = [];
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = new Date(to - d * DAY); dayStart.setHours(0, 0, 0, 0);
    const s = dayStart.getTime(); const e = s + DAY;
    const dv = past.filter((v) => ms(v.start) >= s && ms(v.start) < e);
    daily.push({ date: new Date(s).toISOString().slice(0, 10), scheduled: dv.length, confirmed: dv.filter((v) => v.confirmation?.checkIn && v.confirmation?.checkOut).length });
  }

  return {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days },
    completion: {
      scheduled: past.length,
      confirmed: confirmed.length,
      confirmedPct: pct(confirmed.length, past.length),
      recordsComplete: recordsComplete.length,
      recordsCompletePct: pct(recordsComplete.length, confirmed.length),
      unconfirmed: unconfirmed.length,
      cancelled: cancelled.length,
    },
    coverage: {
      upcomingVisits: nextWeek.length,
      assigned: assigned.length,
      coveragePct: pct(assigned.length, nextWeek.length),
      scheduledHours: Math.round(scheduledHours),
      activeCaregivers: caregivers.filter((c) => c.status === 'active').length,
    },
    issues: {
      raised: windowItems.length,
      open: openItems.length,
      overdue: openItems.filter((i) => ms(i.dueAt) < to).length,
      avgResolutionHours,
      byCode: Object.entries(byCode).map(([code, count]) => ({ code, label: FINDING_CODES[code]?.label || code, count })).sort((a, b) => b.count - a.count),
    },
    incidents: {
      opened: incidents.filter((i) => ms(i.reportedAt) >= from).length,
      open: incidents.filter((i) => i.status !== 'resolved').length,
    },
    recurring,
    daily,
  };
}

// Deterministic narrative used when Bedrock is not configured; it is also
// the factual skeleton handed to the model, so numbers never come from the LLM.
export function narrateReport(r) {
  const lines = [];
  lines.push(`Over the last ${r.period.days} days, ${r.completion.confirmed} of ${r.completion.scheduled} completed-time visits (${r.completion.confirmedPct}%) have both check-in and check-out recorded; ${r.completion.unconfirmed} have no confirmation at all.`);
  lines.push(`${r.completion.recordsComplete} confirmed visits (${r.completion.recordsCompletePct}%) have complete administrative records (timesheet, task checklist, mileage).`);
  lines.push(`Next 7 days: ${r.coverage.assigned} of ${r.coverage.upcomingVisits} visits are assigned (${r.coverage.coveragePct}% coverage), ${r.coverage.scheduledHours} scheduled hours across ${r.coverage.activeCaregivers} active caregivers.`);
  lines.push(`${r.issues.raised} coordination issues were raised; ${r.issues.open} remain open and ${r.issues.overdue} are past their follow-up target.${r.issues.avgResolutionHours != null ? ` Average time to resolve: ${r.issues.avgResolutionHours} h.` : ''}`);
  if (r.recurring.length) {
    const top = r.recurring.slice(0, 3).map((x) => `${x.label.toLowerCase()} (${x.kind} ${x.name}, ${x.count}×)`).join('; ');
    lines.push(`Recurring patterns worth a scheduling review: ${top}.`);
  }
  return lines;
}
