// Daily EventBridge schedule. Applies each agency's retention policy using the
// carequeue_retention DB role, deletes matching S3 objects, and writes an audit
// row with counts. Audit-log exports in S3 use Object Lock (compliance mode)
// and expire via lifecycle rule, not via this function.

import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { listAgencies, withAgency, purgeExpired, appendAudit } from './lib/db.mjs';

const s3 = new S3Client({});

export async function handler({ dryRun = false } = {}) {
  const out = [];
  for (const agency of await listAgencies()) {
    await withAgency(agency.id, async (db) => {
      const { counts, s3Keys } = await purgeExpired(db, agency.retention, { dryRun, role: 'carequeue_retention' });
      if (!dryRun && s3Keys.length) {
        for (let i = 0; i < s3Keys.length; i += 1000) {
          await s3.send(new DeleteObjectsCommand({ Bucket: process.env.DOCS_BUCKET, Delete: { Objects: s3Keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
        }
      }
      await appendAudit(db, { actorId: null, action: dryRun ? 'retention.dry_run' : 'retention.applied', entity: 'retention', detail: { counts } });
      out.push({ agency: agency.id, counts });
    });
  }
  return out;
}
