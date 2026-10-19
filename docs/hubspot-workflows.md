# HubSpot CRM plan

HubSpot holds **sales and customer-success data about agencies** — never client, caregiver, visit, handover or incident data. Enforcement lives in `integrations/hubspot.js`: payloads are built from allowlists, unknown fields throw, care-like values are blocked, and the demo form's free-text message is never synced.

## Objects and custom properties

| Object | Standard fields used | Custom properties (`carequeue_*`) |
|---|---|---|
| Contact | email, firstname, lastname, jobtitle, phone | — |
| Company | name, state | `agency_size_band` (1-25 / 26-100 / 101-300 / 300+ caregivers), `service_lines` (personal care, companion, respite, skilled) |
| Deal | dealname, pipeline, dealstage | `plan`, `seat_band`, `demo_date`, `onboarding_stage`, `kickoff_date`, `sso_configured`, `go_live_date` |

## Pipelines

**CareQueue Sales** (`carequeue-sales`)

| Stage | Entered when | Automation |
|---|---|---|
| Demo requested | Website form submitted → `hubspot-sync` Lambda | Assign owner by state (round robin); task "Book demo within 1 business day"; confirmation email from sequence |
| Demo scheduled | Meeting booked via HubSpot meetings link | Reminder 24 h before; send prep questionnaire (zones, shift patterns, EVV vendor — no client data) |
| Demo completed | Rep logs outcome | Follow-up sequence; create "security review" task if buyer is Enterprise |
| Security review | Security questionnaire sent | Attach security overview PDF; notify solutions engineer |
| Proposal sent | Quote created | Reminder at 5 and 10 days |
| Closed won / lost | Rep sets stage | Won → create onboarding deal; Lost → reason required, nurture list after 90 days |

**CareQueue Onboarding** (`carequeue-onboarding`)

| Stage | Exit criteria | Signal source |
|---|---|---|
| Kickoff | Kickoff meeting held | CSM |
| BAA signed | Countersigned BAA on file (Enterprise) | CSM |
| SSO configured | `sso_configured = true` | CareQueue admin console → milestone webhook (boolean only) |
| Data import | Caregiver & client CSV import completed | Milestone webhook (boolean + date, **no counts or names**) |
| Staff training | Training sessions delivered | CSM |
| Go live | First week of live scheduling | Milestone webhook (`go_live_date`) |
| Adoption review | 30-day review held | CSM; health score set manually |

## Marketing workflows

- **Demo nurture:** contacts with `hs_lead_status = new` and no meeting after 3 days → 3-email sequence (use cases, scheduling demo link, security page).
- **Product updates:** only contacts who ticked the optional consent box on the form; unsubscribe respected globally.
- **Customer newsletter:** company lifecycle stage = customer.

## Guardrails

1. The CRM integration Lambda has no database access to operational tables — only `demo_leads` / `crm_outbox`.
2. Onboarding milestones are booleans and dates. Product usage is not synced at record level.
3. Sales and CSM staff are trained not to paste customer care information into HubSpot notes; the demo-prep questionnaire asks only about operations.
4. HubSpot private-app token scopes: `crm.objects.contacts.write`, `crm.objects.companies.write`, `crm.objects.deals.write` — nothing else.
5. Every sync attempt (sent / blocked / failed) is kept in `crm_outbox` for audit.
