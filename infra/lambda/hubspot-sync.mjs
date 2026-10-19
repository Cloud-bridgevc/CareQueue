// Drains crm_outbox → HubSpot. Payloads were built from allowlists at write
// time and are re-validated here, so a bad row is blocked rather than sent.
// Env: HUBSPOT_TOKEN_SECRET_ARN. This function has no access to operational tables.

import { buildPayload, syncToHubSpot } from '../../integrations/hubspot.js';
import { pendingOutbox, markOutbox, hubspotToken } from './lib/crm-db.mjs';

export async function handler() {
  const token = await hubspotToken();
  for (const row of await pendingOutbox(50)) {
    try {
      const bundle = {
        contact: buildPayload('contact', row.payload.contact.properties),
        company: buildPayload('company', row.payload.company.properties),
        deal: buildPayload('deal', row.payload.deal.properties),
      };
      const res = await syncToHubSpot(bundle, { token });
      await markOutbox(row.id, 'sent', res.ids);
    } catch (err) {
      await markOutbox(row.id, /not allowed|care information/.test(err.message) ? 'blocked' : 'failed', { error: err.message });
    }
  }
}
