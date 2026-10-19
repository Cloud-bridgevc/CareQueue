import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, clinicalFlags, selectNotes, draftSummary, reviewSummary } from '../server/summaries.js';
import { buildPayload, demoRequestToCrm } from '../integrations/hubspot.js';
import { can, canSeeHandover } from '../server/rbac.js';
import { AuditLog } from '../server/audit.js';

const note = (id, category, text, extra = {}) => ({ id, category, text, authorId: 'u-sched', createdAt: '2026-10-21T10:00:00Z', audience: ['scheduler', 'supervisor'], requiresFollowUp: false, ...extra });

test('redacts phone numbers, emails and access codes', () => {
  const out = redact('Call 555-0147 or (555) 201-3344, email jo@example.org, lockbox code 4821.');
  assert.ok(!/0147|3344|jo@example|4821/.test(out), out);
});

test('care observations and restricted notes are excluded from AI summaries', () => {
  const { included, excluded } = selectNotes([note('a', 'staffing', 'x'), note('b', 'care_observation', 'y', { restricted: true }), note('c', 'scheduling', 'z', { restricted: true })]);
  assert.deepEqual(included.map((n) => n.id), ['a']);
  assert.deepEqual(excluded.map((n) => n.id), ['b', 'c']);
});

test('drafts are pending review, cite sources and never include excluded notes', async () => {
  let i = 0;
  const s = await draftSummary({
    notes: [note('HN-1', 'staffing', 'Ben called out Thursday. Need cover.', { requiresFollowUp: true }), note('HN-2', 'care_observation', 'Client seemed tired.', { restricted: true })],
    staffName: () => 'Marco', requestedBy: 'u-sched', newId: () => `S${++i}`,
  });
  assert.equal(s.status, 'pending_review');
  assert.match(s.draft, /\[HN-1\]/);
  assert.doesNotMatch(s.draft, /tired|HN-2/);
  assert.equal(s.finalText, null);
});

test('clinical language blocks approval until edited; requester cannot self-approve', () => {
  assert.ok(clinicalFlags('Client should take medication earlier').length >= 1);
  const s = { id: 'S1', status: 'needs_edit', requestedBy: 'u-sched', draft: 'Discuss medication dose change.', flags: ['medication'] };
  assert.throws(() => reviewSummary(s, { action: 'approve', reviewer: { id: 'u-sup' } }), /non-administrative/);
  reviewSummary(s, { action: 'edit', text: 'Coordinate visit time change with family.', reviewer: { id: 'u-sup' } });
  assert.equal(s.status, 'pending_review');
  assert.throws(() => reviewSummary(s, { action: 'approve', reviewer: { id: 'u-sched' } }), /different authorized reviewer/);
  reviewSummary(s, { action: 'approve', reviewer: { id: 'u-sup' } });
  assert.equal(s.status, 'approved');
  assert.equal(s.finalText, 'Coordinate visit time change with family.');
});

test('HubSpot payloads reject care data and non-allowlisted fields', () => {
  assert.throws(() => buildPayload('contact', { email: 'a@b.co', client_name: 'X' }), /not allowed/);
  assert.throws(() => buildPayload('deal', { dealname: 'X', dealstage: 'demo_requested', carequeue_onboarding_stage: 'patient diagnosis review' }), /care information/);
  const bundle = demoRequestToCrm({ name: 'Jo Smith', email: 'jo@agency.example', agency: 'Agency', sizeBand: '26-100 caregivers', state: 'OH', role: 'Director', message: 'Our client Mrs X has dementia' });
  assert.doesNotMatch(JSON.stringify(bundle), /dementia|Mrs X/);
  assert.equal(bundle.deal.properties.dealstage, 'demo_requested');
});

test('role-based access', () => {
  const cgUser = { id: 'u-cg', role: 'caregiver', caregiverId: 'cg-01' };
  const sup = { id: 'u-sup', role: 'supervisor' };
  const sched = { id: 'u-sched', role: 'scheduler' };
  const aud = { id: 'u-aud', role: 'auditor' };
  assert.equal(can(cgUser, 'visits:read'), false);
  assert.equal(can(cgUser, 'visits:read_own'), true);
  assert.equal(can(sched, 'summary:approve'), false);
  assert.equal(can(sup, 'summary:approve'), true);
  assert.equal(can(aud, 'audit:read'), true);
  assert.equal(can(aud, 'visits:write'), false);
  const restricted = note('r', 'care_observation', 'x', { restricted: true, audience: ['supervisor', 'scheduler'] });
  assert.equal(canSeeHandover(sched, restricted), false);
  assert.equal(canSeeHandover(sup, restricted), true);
  assert.equal(canSeeHandover(cgUser, note('n', 'access', 'x', { audience: ['scheduler'] })), false);
});

test('audit log detects tampering', () => {
  const log = new AuditLog();
  log.append({ action: 'a', entity: 'x' });
  log.append({ action: 'b', entity: 'x' });
  log.append({ action: 'c', entity: 'x' });
  assert.equal(log.verify().ok, true);
  log.entries[1].action = 'edited';
  assert.deepEqual({ ok: log.verify().ok, brokenAt: log.verify().brokenAt }, { ok: false, brokenAt: 1 });
});
