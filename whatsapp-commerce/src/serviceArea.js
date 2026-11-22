/*
 * Service area check (UK postcodes). The business lists the areas it covers in Settings → Business → Areas covered,
 * e.g. "SW, SE1, SE5, CR0-CR4, Croydon". A customer's postcode (full "SW19 2AB" or outward "SW19") is matched:
 *   "SW"      → any SW district           "SE1" → SE1 and SE1x (not SE10–SE19)
 *   "CR0-CR4" → CR0, CR1 … CR4           "Croydon" → the word appears in what the customer wrote
 * covered: true / false, or null when no areas are set or no postcode/town was found – the assistant never
 * refuses anyone: outside the area it says the team will confirm.
 */
const FULL = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const OUTWARD = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/i;

export function findPostcode(text) {
  const t = String(text || '');
  const f = FULL.exec(t);
  if (f) return { postcode: `${f[1]} ${f[2]}`.toUpperCase(), outward: f[1].toUpperCase() };
  // an outward code on its own only when they're clearly giving a postcode ("postcode SW19", "in SW19", or just "SW19")
  const o = OUTWARD.exec(t);
  if (o && (/post ?code|\b(in|at|near|area)\s+[A-Z]{1,2}\d/i.test(t) || t.trim().length <= 8)) return { postcode: o[1].toUpperCase(), outward: o[1].toUpperCase() };
  return null;
}

export function areaRules(settings) {
  const raw = settings?.business?.serviceAreas;
  return (Array.isArray(raw) ? raw : String(raw || '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
}

const split = (o) => { const m = /^([A-Z]{1,2})(\d{1,2})([A-Z]?)$/.exec(o); return m ? { area: m[1], n: Number(m[2]), suffix: m[3] } : null; };
function ruleMatches(rule, outward, text) {
  const r = rule.toUpperCase().replace(/\s+/g, '');
  const range = /^([A-Z]{1,2})(\d{1,2})-([A-Z]{1,2})?(\d{1,2})$/.exec(r);
  const p = outward && split(outward);
  if (range && p) return p.area === range[1] && p.n >= Number(range[2]) && p.n <= Number(range[4]);
  if (/^[A-Z]{1,2}$/.test(r) && p) return p.area === r;
  if (/^[A-Z]{1,2}\d{1,2}[A-Z]?$/.test(r) && p) { const q = split(r); return q.area === p.area && q.n === p.n && (!q.suffix || q.suffix === p.suffix); }
  if (/[a-z]{3,}/i.test(rule) && !/\d/.test(rule)) return new RegExp(`\\b${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  return false;
}

export function checkServiceArea(settings, text) {
  const rules = areaRules(settings);
  const pc = findPostcode(text);
  if (!rules.length) return { ...(pc || {}), covered: null, reason: 'no_areas_set' };
  const hit = rules.find((r) => ruleMatches(r, pc?.outward, text));
  if (hit) return { ...(pc || {}), covered: true, matched: hit };
  if (!pc) return { covered: null, reason: 'no_postcode' };
  return { ...pc, covered: false };
}

/** Text for the AI prompt (only when the business has listed its areas). */
export function areaPrompt(settings) {
  const rules = areaRules(settings);
  if (!rules.length) return '';
  return `\nAreas covered: ${rules.join(', ')}. If a customer is outside these, don't refuse: say the team will confirm whether they can help, and take their details.`;
}
