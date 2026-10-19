// EventBridge schedule (rate(1 minute)) → runs every monitor for each agency,
// reconciles the attention queue in PostgreSQL, and enqueues minimal
// notifications. Reuses shared/rules.js unchanged (bundled with esbuild).
//
// Env: DB_SECRET_ARN, NOTIFY_QUEUE_URL. IAM: secretsmanager:GetSecretValue on the
// DB secret, sqs:SendMessage on the notify queue, VPC access to RDS. Nothing else.

import { runAllMonitors, reconcileQueue, mergeRules } from '../../shared/rules.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { withAgency, listAgencies, loadMonitorState, saveQueue } from './lib/db.mjs';

const sqs = new SQSClient({});

export async function handler() {
  const now = new Date();
  const results = [];
  for (const agency of await listAgencies()) {
    await withAgency(agency.id, async (db) => {
      const rules = mergeRules(agency.rules);
      const state = await loadMonitorState(db, now);              // visits ±14 days, caregivers, clients (minimal), incidents, summaries
      const findings = runAllMonitors(state, now, rules);
      const { created, cleared } = reconcileQueue(state.queue, findings, now, rules);
      await saveQueue(db, state.queue, { created, cleared });      // upsert + queue_item_events + audit_log rows
      const urgent = created.filter((i) => i.severity === 'critical' || i.severity === 'high');
      if (urgent.length) {
        // Data minimization: counts and a link only. No names, client refs or visit details.
        await sqs.send(new SendMessageCommand({
          QueueUrl: process.env.NOTIFY_QUEUE_URL,
          MessageBody: JSON.stringify({ agencyId: agency.id, audienceRole: 'supervisor', kind: 'queue_items_created', count: urgent.length, critical: urgent.filter((i) => i.severity === 'critical').length }),
        }));
      }
      results.push({ agency: agency.id, findings: findings.length, created: created.length, cleared: cleared.length });
    });
  }
  return results;
}
