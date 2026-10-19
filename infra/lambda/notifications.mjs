// SQS consumer → SES email / SNS SMS to on-shift supervisors.
// Messages carry counts only; the recipient signs in to CareQueue to see details.

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { withAgency, onShiftRecipients } from './lib/db.mjs';

const ses = new SESv2Client({});
const APP_URL = process.env.APP_URL;

export async function handler(event) {
  const failures = [];
  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body);
      if (msg.kind !== 'queue_items_created') continue;
      const recipients = await withAgency(msg.agencyId, (db) => onShiftRecipients(db, msg.audienceRole));
      const subject = msg.critical ? `CareQueue: ${msg.critical} critical item(s) need review` : `CareQueue: ${msg.count} item(s) need review`;
      const text = `${msg.count} new item(s) are in your CareQueue supervisor review queue.\n\nOpen CareQueue: ${APP_URL}/app/#/queue\n\nFor privacy, details are only shown after you sign in.`;
      for (const to of recipients) {
        await ses.send(new SendEmailCommand({
          FromEmailAddress: process.env.FROM_ADDRESS,
          Destination: { ToAddresses: [to.email] },
          Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
        }));
      }
    } catch (err) {
      console.error('notify failed', record.messageId, err.name);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
