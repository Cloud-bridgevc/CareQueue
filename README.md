# CareQueue

Scheduling and coordination platform for home-care agencies: caregiver availability, visit scheduling, coverage, visit confirmations, administrative handovers, supervisor follow-up, incident escalation, reporting and audit. **All demo data is synthetic.** CareQueue is administrative software; it does not diagnose, recommend treatment or assess patient safety.

## Run it

Requires Node.js 20+. No dependencies to install.

```bash
npm start
```

- Website: http://localhost:4310/
- Dashboard: http://localhost:4310/app/ (pick a persona: supervisor Priya Raman sees the most)

```bash
npm test
```

### Try the missed-confirmation flow
Sign in as **Priya Raman (Supervisor)** → *Missed-confirmation walkthrough* → create the visit → open the queue item → record a manual confirmation and resolve. Then sign in as **Grace Liu (Auditor)** to see each step in the audit log.

## What is where

| Path | Contents |
|---|---|
| `shared/rules.js` | Rules engine: scheduling conflicts, confirmation monitoring, follow-ups, attention queue, coverage suggestions. Runs on server, in Lambda and in the browser demo. |
| `shared/reports.js` | Operations report metrics and the deterministic narrative |
| `server/` | Zero-dependency HTTP server, API + RBAC, audit log, summaries pipeline, in-memory store |
| `data/seed.js` | Synthetic agency generated relative to "now" |
| `public/site/` | Public website (product, use cases, interactive scheduling demo, pricing, security, demo request) |
| `public/app/` | Operations dashboard |
| `integrations/hubspot.js` | Allowlisted CRM payloads + HubSpot v3 client (dry-run without a token) |
| `db/schema.sql` | PostgreSQL schema with RLS, append-only audit log |
| `infra/lambda/` | Lambda handlers: confirmation sweep, notifications, summary worker (Bedrock), retention, HubSpot sync |
| `docs/` | AWS architecture, HubSpot workflows, privacy and safety controls |

## Optional integrations

| Env var | Effect |
|---|---|
| `CAREQUEUE_BEDROCK_REGION` (+ `npm i @anthropic-ai/bedrock-sdk`, AWS credentials) | Handover drafts come from Claude on Amazon Bedrock instead of the local extractive drafter |
| `CAREQUEUE_BEDROCK_MODEL` | Override model (default `anthropic.claude-opus-5-5`) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | Demo requests are created in HubSpot instead of dry-run |
| `PORT` | Server port (default 4310) |

## Status

Working demo build. Not production-ready: in-memory storage, demo persona sign-in, and the Lambda data-access layer and infrastructure-as-code are not written yet. See `docs/privacy-and-safety.md` → *Known gaps*.
