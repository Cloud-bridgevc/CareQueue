# Privacy and safety controls

| Requirement | How it is implemented | Where |
|---|---|---|
| Synthetic demo data | Fictional agency, people and clients; every record carries `synthetic: true`; banner on every page | `data/seed.js`, UI banners |
| Strict access control | 5 roles, permission per API route, enforced server-side; caregivers scoped to own visits; restricted notes need `handover:read_restricted`; denied requests are audit-logged | `server/rbac.js`, `server/api.js` |
| Data minimization | Clients shown as ID + initials, zone only; no addresses or codes in the scheduling API; masked phone numbers; notifications carry counts only; demo-form message not sent to CRM | `server/api.js` (`clientView`), `infra/lambda/notifications.mjs`, `integrations/hubspot.js` |
| Audit logging | Append-only, SHA-256 hash-chained; covers sign-in/out, every write, sensitive reads (handover list, audit view), denied access; verifiable in UI | `server/audit.js`, `db/schema.sql` |
| Configurable retention | Per record class, dry-run first, purge logged | `server/store.js` (`applyRetention`), `infra/lambda/retention.mjs` |
| No clinical output | Rules only cover schedules and admin records; summaries limited to admin categories; system prompt forbids diagnosis/treatment/safety assessment; output scanned for clinical language and blocked from approval until edited; UI copy states a missing confirmation means a missing *record* | `shared/rules.js`, `server/summaries.js` |
| Human review of AI output | Drafts are `pending_review` and invisible to non-reviewers; approval requires `summary:approve` and a different person from the requester; report narratives labelled as drafts | `server/summaries.js`, `server/api.js` |
| Web hardening | CSP (no inline scripts), HttpOnly SameSite=Strict session cookie, custom-header CSRF check, body size limit, rate-limited public form with honeypot, `X-Frame-Options: DENY` | `server/index.js` |

## Known gaps before production

- Real identity provider (Cognito/SAML + MFA) replaces the demo persona picker.
- PostgreSQL repository and Lambda data-access layer (`infra/lambda/lib/*.mjs`) are not implemented.
- Retention defaults (e.g. 6-year visit records) are placeholders; confirm with counsel per state and payer.
- The clinical-language scan is a keyword safeguard, not a classifier; human review remains the control.
- Agency timezone: availability windows are evaluated in the server's local time in this build.
