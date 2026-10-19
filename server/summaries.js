// Administrative handover summaries.
//
// Pipeline: authorize → select administrative notes only → redact → draft
// (Amazon Bedrock if configured, otherwise a deterministic local drafter) →
// scan the draft for clinical language → store as `pending_review`.
// A draft is never shown to staff until an authorized supervisor approves it.

export const ADMIN_CATEGORIES = ['scheduling', 'staffing', 'access', 'documentation', 'follow_up', 'logistics', 'family_request'];

export const CATEGORY_LABELS = {
  scheduling: 'Scheduling changes', staffing: 'Staffing & coverage', access: 'Home access & logistics', logistics: 'Home access & logistics',
  documentation: 'Documentation gaps', follow_up: 'Supervisor follow-ups', family_request: 'Family requests',
};

// Language that suggests clinical judgement. Matches block approval until edited.
const CLINICAL_PATTERNS = [
  /\bdiagnos\w*/i, /\bprognos\w*/i, /\bmedicat\w*/i, /\bdos(e|age|ing)\b/i, /\btreat(ment|ed|ing)?\b/i, /\bprescri\w*/i,
  /\bsymptom\w*/i, /\bvital signs?\b/i, /\bblood pressure\b/i, /\bwound\w*/i, /\binfection\b/i, /\bdeclin(e|ing) (in )?health\b/i,
  /\b(is|seems|appears) (unsafe|at risk|in danger)\b/i, /\bshould (take|be given|start|stop)\b/i, /\bcondition (is|has) (worse|improv)/i,
];

const REDACTIONS = [
  [/\b(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]\d{4}\b/g, '[phone redacted]'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email redacted]'],
  [/\b(code|pin|password|combo)\s*(is|:)?\s*\d{3,}\b/gi, '$1 [redacted]'],
  [/\b\d{6,}\b/g, '[number redacted]'],
];

export function redact(text) {
  return REDACTIONS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

export function clinicalFlags(text) {
  return CLINICAL_PATTERNS.filter((re) => re.test(text)).map((re) => text.match(re)[0]);
}

export function selectNotes(notes) {
  const included = [];
  const excluded = [];
  for (const n of notes) {
    if (n.restricted || !ADMIN_CATEGORIES.includes(n.category)) excluded.push({ id: n.id, reason: n.category === 'care_observation' ? 'Care observation — route to clinical lead, not summarized' : 'Non-administrative or restricted note' });
    else included.push(n);
  }
  return { included, excluded };
}

export const SYSTEM_PROMPT = `You draft ADMINISTRATIVE handover summaries for a home-care agency's office staff.
Rules:
- Summarize only scheduling, staffing, home-access logistics, documentation status, family scheduling requests and follow-up tasks.
- Do not diagnose, interpret health status, recommend treatment or medication, or assess anyone's safety or risk. If a note seems to contain clinical content, write "Note HN-xxx contains non-administrative content; route to clinical lead" and do not restate it.
- Use only facts present in the notes. Do not infer or add information. Keep note IDs in brackets so reviewers can trace every line.
- Output plain text: sections "Open actions", then "For awareness". Bullets start with "- ". Under 200 words.
- This is a draft that a supervisor will review before anyone else sees it.`;

function noteLine(n, staffName) {
  return `[${n.id}] (${n.category}; by ${staffName(n.authorId)}; ${n.createdAt}) ${redact(n.text)}`;
}

export function localDraft(notes, staffName) {
  const actions = notes.filter((n) => n.requiresFollowUp);
  const awareness = notes.filter((n) => !n.requiresFollowUp);
  // Keep up to two sentences per note, so the brief stays short but keeps the ask.
  const firstSentence = (t) => (redact(t).match(/^(.*?[.!?](\s|$)){1,2}/)?.[0] || redact(t)).trim();
  const out = ['Open actions'];
  if (!actions.length) out.push('- None recorded.');
  for (const n of actions) out.push(`- ${CATEGORY_LABELS[n.category] || n.category}: ${firstSentence(n.text)} [${n.id}]`);
  out.push('', 'For awareness');
  if (!awareness.length) out.push('- None recorded.');
  for (const n of awareness) out.push(`- ${CATEGORY_LABELS[n.category] || n.category}: ${firstSentence(n.text)} [${n.id}]`);
  return out.join('\n');
}

// Amazon Bedrock (Anthropic Claude via the Bedrock Mantle client).
// Enabled when CAREQUEUE_BEDROCK_REGION is set and @anthropic-ai/bedrock-sdk is installed.
async function bedrockDraft(notes, staffName) {
  const region = process.env.CAREQUEUE_BEDROCK_REGION;
  if (!region) return null;
  let AnthropicBedrockMantle;
  try {
    ({ AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk'));
  } catch {
    return null;
  }
  const client = new AnthropicBedrockMantle({ awsRegion: region });
  const response = await client.messages.create({
    model: process.env.CAREQUEUE_BEDROCK_MODEL || 'anthropic.claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Handover notes:\n${notes.map((n) => noteLine(n, staffName)).join('\n')}` }],
  });
  if (response.stop_reason === 'refusal') return { text: null, model: response.model, refused: true };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, model: response.model };
}

export async function draftSummary({ notes, staffName, requestedBy, newId, now = new Date() }) {
  const { included, excluded } = selectNotes(notes);
  let provider = 'local-extractive';
  let text = null;
  let providerNote = null;
  try {
    const b = await bedrockDraft(included, staffName);
    if (b?.text) { text = b.text; provider = `bedrock:${b.model}`; }
    else if (b?.refused) providerNote = 'Model declined; local draft used instead.';
  } catch (err) {
    providerNote = `Bedrock unavailable (${err.name}); local draft used instead.`;
  }
  if (!text) text = localDraft(included, staffName);

  const flags = clinicalFlags(text);
  return {
    id: newId(),
    createdAt: now.toISOString(),
    requestedBy,
    provider,
    providerNote,
    sourceNoteIds: included.map((n) => n.id),
    excludedNotes: excluded,
    draft: text,
    finalText: null,
    flags,
    status: flags.length ? 'needs_edit' : 'pending_review',
    review: null,
    disclaimer: 'AI-assisted administrative draft. Not a clinical record. Must be reviewed by an authorized supervisor before it is shared.',
  };
}

// Approval rules: only `summary:approve` holders; cannot approve while
// clinical-language flags remain; the requester cannot approve their own draft.
export function reviewSummary(summary, { action, text, reviewer, reason }) {
  const at = new Date().toISOString();
  if (!['pending_review', 'needs_edit'].includes(summary.status)) throw httpError(409, `Summary is already ${summary.status}.`);
  if (action === 'edit') {
    if (!text?.trim()) throw httpError(400, 'Edited text is required.');
    summary.draft = text;
    summary.flags = clinicalFlags(text);
    summary.status = summary.flags.length ? 'needs_edit' : 'pending_review';
    summary.edits = [...(summary.edits || []), { at, by: reviewer.id }];
    return summary;
  }
  if (action === 'approve') {
    if (summary.requestedBy === reviewer.id) throw httpError(403, 'A different authorized reviewer must approve this draft.');
    const flags = clinicalFlags(text ?? summary.draft);
    if (flags.length) throw httpError(422, `Remove non-administrative language before approval: ${flags.join(', ')}`);
    summary.finalText = text ?? summary.draft;
    summary.status = 'approved';
    summary.review = { at, by: reviewer.id, action: 'approved' };
    return summary;
  }
  if (action === 'reject') {
    summary.status = 'rejected';
    summary.review = { at, by: reviewer.id, action: 'rejected', reason: reason || null };
    return summary;
  }
  throw httpError(400, 'Unknown action.');
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
