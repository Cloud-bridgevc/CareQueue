// SQS consumer for "draft handover summary" jobs. Runs the same pipeline as
// server/summaries.js: authorized notes only → admin categories only →
// redaction → Amazon Bedrock (Claude via the Bedrock Mantle client) →
// clinical-language scan → stored as pending_review. Never auto-approved.
//
// Env: CAREQUEUE_BEDROCK_REGION, CAREQUEUE_BEDROCK_MODEL (default anthropic.claude-opus-5-5).
// IAM: bedrock:InvokeModel on that model only. Bedrock does not use prompts or
// outputs for training; enable model-invocation logging only to an encrypted,
// access-restricted bucket if at all.

import { draftSummary } from '../../server/summaries.js';
import { withAgency, notesForSummary, insertSummary, staffNameLookup, appendAudit } from './lib/db.mjs';
import { randomUUID } from 'node:crypto';

export async function handler(event) {
  const failures = [];
  for (const record of event.Records) {
    const job = JSON.parse(record.body); // { agencyId, requestedBy, hours | noteIds }
    try {
      await withAgency(job.agencyId, async (db) => {
        // Authorization is re-checked here against the requester's role and each note's audience.
        const notes = await notesForSummary(db, job);
        const summary = await draftSummary({ notes, staffName: await staffNameLookup(db), requestedBy: job.requestedBy, newId: randomUUID });
        await insertSummary(db, summary);
        await appendAudit(db, { actorId: job.requestedBy, action: 'summary.drafted', entity: 'summary', entityId: summary.id, detail: { provider: summary.provider, flags: summary.flags.length } });
      });
    } catch (err) {
      console.error('summary job failed', record.messageId, err.name);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
