import { TRADES } from './trades.js';

/*
 * Qualifying questions, one at a time (R2.2). When someone asks for details or a call back, instead of one long
 * "tell us everything" question the assistant asks the few things this trade needs, one short question per message,
 * each with a Skip – a plumber needs the problem, the postcode and how urgent it is; a travel agent needs where,
 * when, how many and the budget.
 *  - Up to 4 questions. A question can offer up to 2 quick-reply buttons (WhatsApp allows 3, the third is Skip);
 *    typing an answer always works. An option marked urgent flags the lead as urgent for the team.
 *  - A question marked postcode is checked against the areas the business covers.
 *  - The owner can write their own (Settings → Leads), one per line: "When do you need it? | Today | This week".
 *  - Businesses with a trade use that trade's questions unless the owner wrote their own single question; anyone
 *    else keeps the single question exactly as before.
 */
const URGENT = { label: '🚨 Today – urgent', urgent: true };
const JOB_TIMING = { key: 'when', q: 'How soon do you need someone?', options: [URGENT, { label: 'This week' }] };
const POSTCODE = { key: 'postcode', q: "What's the postcode where the work is?", postcode: true };
export const MAX_QUESTIONS = 4;

export const QUALIFY = {
  trades: [{ key: 'job', q: 'What needs doing? A photo helps – tap 📎 to send one.' }, POSTCODE, JOB_TIMING],
  plumber: [{ key: 'job', q: "What's the problem – a leak, a blockage, something new fitted? A photo helps (📎)." }, POSTCODE, JOB_TIMING],
  electrician: [{ key: 'job', q: 'What do you need doing? A photo of the fault or fuse box helps (📎).' }, POSTCODE, JOB_TIMING],
  heating: [{ key: 'job', q: "What's happening with your boiler or heating? Include the make and model if you know it." }, POSTCODE, { key: 'when', q: 'Do you have heating and hot water at the moment?', options: [{ label: '🚨 No – none', urgent: true }, { label: 'Yes, it works' }] }],
  handyman: [{ key: 'job', q: 'What jobs need doing? A photo or two helps (📎).' }, POSTCODE, { key: 'when', q: 'When would you like it done?', options: [{ label: 'This week' }, { label: "I'm flexible" }] }],
  property_maintenance: [{ key: 'job', q: 'What needs repairing?' }, { ...POSTCODE, q: "What's the property's postcode?" }, { key: 'who', q: 'Are you the landlord, the agent or the tenant?', options: [{ label: 'Landlord or agent' }, { label: 'Tenant' }] }, { key: 'when', q: 'Is it urgent (no water, heating or power, or unsafe)?', options: [{ label: '🚨 Yes – urgent', urgent: true }, { label: 'Not urgent' }] }],
  travel: [{ key: 'where', q: 'Where would you like to go?' }, { key: 'when', q: 'Roughly when – a month or dates?' }, { key: 'who', q: 'How many are travelling (adults and children)?' }, { key: 'budget', q: 'Do you have a budget per person in mind?' }],
  experiences: [{ key: 'which', q: 'Which experience are you interested in?' }, { key: 'when', q: 'Which date or month suits you?' }, { key: 'who', q: 'How many people?' }],
  garage: [{ key: 'need', q: 'What does the car need – MOT, service or a repair?', options: [{ label: 'MOT' }, { label: 'Service' }] }, { key: 'car', q: "What's the car's registration (or make and model)?" }, { key: 'when', q: 'When suits you?' }],
  property: [{ key: 'intent', q: 'Are you buying, selling, renting or letting?' }, { key: 'area', q: 'Which area?' }, { key: 'budget', q: "What's your budget (or the rough value of your property)?" }],
  professional: [{ key: 'topic', q: 'Briefly, what would you like help with?' }, { key: 'when', q: 'Is there a deadline we should know about?', options: [{ label: 'Yes, soon' }, { label: 'No deadline' }] }],
  dental: [{ key: 'what', q: 'What would you like help with – a check-up, the hygienist, a treatment, or pain?' }, { key: 'patient', q: 'Are you a new or existing patient?', options: [{ label: 'New patient' }, { label: 'Existing patient' }] }, { key: 'when', q: 'When suits you for an appointment?' }],
  clinic: [{ key: 'what', q: 'What would you like help with?' }, { key: 'patient', q: 'Have you been to us before?', options: [{ label: 'First visit' }, { label: "I've been before" }] }, { key: 'when', q: 'When suits you?' }],
  salon: [{ key: 'service', q: 'Which service would you like?' }, { key: 'when', q: 'Which day or time suits you best?' }],
  takeaway: [{ key: 'kind', q: 'Is it about an order, a table booking, or a party or catering?' }, { key: 'when', q: 'Which date and time?' }, { key: 'who', q: 'How many people?' }],
  shop: [{ key: 'what', q: 'What are you looking for?' }, { key: 'detail', q: 'Any size, colour or budget we should know?' }],
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function clean(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const [i, x] of list.entries()) {
    const q = clip(typeof x === 'string' ? x : x?.q, 200);
    if (!q) continue;
    const options = (Array.isArray(x?.options) ? x.options : []).map((o) => (typeof o === 'string' ? { label: o } : o)).map((o) => ({ label: clip(o?.label, 20), ...(o?.urgent ? { urgent: true } : {}) })).filter((o) => o.label).slice(0, 2);
    out.push({ key: clip(x?.key, 20).replace(/[^\w]/g, '') || `q${i + 1}`, q, ...(options.length ? { options } : {}), ...(x?.postcode || /post ?code/i.test(q) ? { postcode: true } : {}) });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out.length ? out : null;
}

/** The questions for this business, or null to keep the single question. */
export function qualifyFor(S = {}) {
  const L = S.leads || {};
  if (L.qualifyOff) return null;
  const own = clean(L.qualify);
  if (own) return own;
  const T = TRADES[S.trade];
  if (!T) return null;
  const custom = L.requirementPrompt && L.requirementPrompt !== T.requirement && !(T.parent && L.requirementPrompt === TRADES[T.parent].requirement);
  if (custom) return null; // the owner wrote their own question: respect it
  return clean(QUALIFY[S.trade] || QUALIFY[T.parent]) || null;
}

/** "Question | option | option" lines ↔ question list (for the dashboard). "!" before an option marks it urgent. */
export function parseQualifyText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return clean(lines.map((l) => {
    const [q, ...opts] = l.split('|').map((s) => s.trim());
    return { q, options: opts.filter(Boolean).map((o) => (o.startsWith('!') ? { label: o.slice(1).trim(), urgent: true } : { label: o })) };
  })) || [];
}
export const qualifyText = (list) => (list || []).map((x) => [x.q, ...(x.options || []).map((o) => (o.urgent ? '!' : '') + o.label)].join(' | ')).join('\n');

/** The answers as one readable line for the team ("Job: leak under sink · Postcode: LS6 2AB · When: Today – urgent"). */
export function answersText(answers) {
  return (answers || []).filter((a) => a.a).map((a) => `${a.label}: ${a.a}`).join(' · ');
}
export const labelFor = (x) => ({ job: 'Job', postcode: 'Postcode', when: 'When', who: 'Who', where: 'Where', budget: 'Budget', which: 'Experience', need: 'Needs', car: 'Car', intent: 'Looking to', area: 'Area', topic: 'Help with', what: 'Wants', patient: 'Patient', service: 'Service', kind: 'About', detail: 'Details' }[x.key] || clip(x.q.replace(/\?.*$/, ''), 40));
