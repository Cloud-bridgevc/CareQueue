// HubSpot CRM integration — sales and onboarding data ONLY.
//
// CareQueue never sends client, caregiver, visit, handover or incident data
// to a marketing CRM. Payloads are built from explicit allowlists, and the
// builder throws if anything else is passed in. Free-text from the public
// demo form stays in CareQueue and is never synced.

export const CONTACT_FIELDS = ['email', 'firstname', 'lastname', 'jobtitle', 'phone'];
export const COMPANY_FIELDS = ['name', 'state', 'carequeue_agency_size_band', 'carequeue_service_lines'];
export const DEAL_FIELDS = ['dealname', 'dealstage', 'pipeline', 'carequeue_plan', 'carequeue_seat_band', 'carequeue_demo_date'];
// Onboarding is tracked as milestone booleans/dates — never record counts derived from care data.
export const ONBOARDING_FIELDS = ['carequeue_onboarding_stage', 'carequeue_kickoff_date', 'carequeue_sso_configured', 'carequeue_go_live_date'];

export const AGENCY_SIZE_BANDS = ['1-25 caregivers', '26-100 caregivers', '101-300 caregivers', '300+ caregivers'];

export const PIPELINES = {
  sales: {
    id: 'carequeue-sales',
    stages: ['demo_requested', 'demo_scheduled', 'demo_completed', 'security_review', 'proposal_sent', 'closed_won', 'closed_lost'],
  },
  onboarding: {
    id: 'carequeue-onboarding',
    stages: ['kickoff', 'baa_signed', 'sso_configured', 'data_import', 'staff_training', 'go_live', 'adoption_review'],
  },
};

// Words that indicate care information slipped into a CRM-bound field.
const BLOCKLIST = /\b(patient|diagnos|medicat|visit note|care plan|incident|caregiver name|dob|date of birth|ssn|medicaid id)\b/i;

export function buildPayload(objectType, properties) {
  const allow = { contact: CONTACT_FIELDS, company: COMPANY_FIELDS, deal: [...DEAL_FIELDS, ...ONBOARDING_FIELDS] }[objectType];
  if (!allow) throw new Error(`Unsupported HubSpot object: ${objectType}`);
  const extra = Object.keys(properties).filter((k) => !allow.includes(k));
  if (extra.length) throw new Error(`Field(s) not allowed in HubSpot ${objectType} payload: ${extra.join(', ')}`);
  for (const [k, v] of Object.entries(properties)) {
    if (typeof v === 'string' && BLOCKLIST.test(v) && !['name', 'dealname'].includes(k)) {
      throw new Error(`Value of "${k}" looks like care information and was blocked.`);
    }
  }
  return { properties: Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined && v !== '')) };
}

// Public demo request → contact + company + deal in the sales pipeline.
export function demoRequestToCrm(lead) {
  const [firstname, ...rest] = lead.name.trim().split(/\s+/);
  return {
    contact: buildPayload('contact', { email: lead.email, firstname, lastname: rest.join(' '), jobtitle: lead.role }),
    company: buildPayload('company', { name: lead.agency, state: lead.state, carequeue_agency_size_band: lead.sizeBand }),
    deal: buildPayload('deal', { dealname: `${lead.agency} — CareQueue`, pipeline: PIPELINES.sales.id, dealstage: 'demo_requested' }),
    associations: [['contact', 'company'], ['deal', 'company'], ['deal', 'contact']],
  };
}

// Send via HubSpot CRM v3 when a private-app token is configured; otherwise dry-run.
export async function syncToHubSpot(bundle, { token = process.env.HUBSPOT_PRIVATE_APP_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) return { mode: 'dry-run', bundle };
  const post = async (object, body) => {
    const res = await fetchImpl(`https://api.hubapi.com/crm/v3/objects/${object}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HubSpot ${object} create failed: ${res.status}`);
    return res.json();
  };
  const company = await post('companies', bundle.company);
  const contact = await post('contacts', { ...bundle.contact, associations: [{ to: { id: company.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }] }] });
  const deal = await post('deals', { ...bundle.deal, associations: [
    { to: { id: company.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }] },
    { to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
  ] });
  return { mode: 'live', ids: { company: company.id, contact: contact.id, deal: deal.id } };
}
