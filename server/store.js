// In-memory operational store for the demo build. The shape mirrors
// db/schema.sql so it can be swapped for a PostgreSQL repository.

import { randomUUID } from 'node:crypto';
import { buildSeed } from '../data/seed.js';
import { mergeRules, runAllMonitors, reconcileQueue } from '../shared/rules.js';
import { AuditLog } from './audit.js';
import { ms, DAY } from '../shared/time.js';

export const DEFAULT_RETENTION = {
  // days; null = keep until the agency deletes it
  handoverNotes: 90,
  aiSummaries: 30,
  resolvedQueueItems: 365,
  visitRecords: 2190,       // 6 years, a common record-keeping horizon — confirm with counsel per state
  auditLog: 2190,
  demoLeads: 730,
};

export function createStore(now = Date.now()) {
  const seed = buildSeed(now);
  const store = {
    ...seed,
    settings: { rules: mergeRules(), retention: { ...DEFAULT_RETENTION } },
    leads: [],
    crmOutbox: [],
    sessions: new Map(),
    audit: new AuditLog(),
    lastSweep: null,
    newId: (prefix = '') => `${prefix}${randomUUID().slice(0, 8).toUpperCase()}`,
  };
  store.audit.append({ action: 'system.seeded', entity: 'agency', entityId: seed.agency.id, detail: { synthetic: true, visits: seed.visits.length } });
  sweep(store, now, null);
  return store;
}

export function rules(store) {
  return store.settings.rules;
}

// The background sweep: run all monitors and reconcile the attention queue.
// In AWS this is the `confirmation-sweep` Lambda on an EventBridge schedule.
export function sweep(store, now = Date.now(), actor = null) {
  const findings = runAllMonitors(store, now, rules(store));
  const result = reconcileQueue(store.queue, findings, now, rules(store), () => store.newId('Q-'));
  store.lastSweep = { at: new Date(now).toISOString(), findings: findings.length, created: result.created.length, cleared: result.cleared.length };
  if (result.created.length || result.cleared.length || actor) {
    store.audit.append({
      actor, action: 'queue.sweep', entity: 'queue',
      detail: { findings: findings.length, created: result.created.map((i) => i.id), cleared: result.cleared.map((i) => i.id) },
    });
  }
  return { ...result, findings };
}

// Retention: purge or minimize records past their configured age.
export function applyRetention(store, { dryRun = true, now = Date.now(), actor = null } = {}) {
  const r = store.settings.retention;
  const older = (t, days) => days != null && ms(t) < now - days * DAY;
  const plan = {
    handoverNotes: store.handovers.filter((n) => older(n.createdAt, r.handoverNotes)).map((n) => n.id),
    aiSummaries: store.summaries.filter((s) => older(s.createdAt, r.aiSummaries)).map((s) => s.id),
    resolvedQueueItems: store.queue.filter((q) => q.status === 'resolved' && older(q.resolvedAt || q.createdAt, r.resolvedQueueItems)).map((q) => q.id),
    visitRecords: store.visits.filter((v) => older(v.end, r.visitRecords)).map((v) => v.id),
    demoLeads: store.leads.filter((l) => older(l.createdAt, r.demoLeads)).map((l) => l.id),
  };
  if (!dryRun) {
    const drop = (list, ids) => list.filter((x) => !ids.includes(x.id));
    store.handovers = drop(store.handovers, plan.handoverNotes);
    store.summaries = drop(store.summaries, plan.aiSummaries);
    store.queue = drop(store.queue, plan.resolvedQueueItems);
    store.visits = drop(store.visits, plan.visitRecords);
    store.leads = drop(store.leads, plan.demoLeads);
  }
  const counts = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
  store.audit.append({ actor, action: dryRun ? 'retention.dry_run' : 'retention.applied', entity: 'retention', detail: { counts, policy: r } });
  return { dryRun, counts, policy: r };
}
