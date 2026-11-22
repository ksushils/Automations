/*
 * Emergency safety notices. Some messages need the right safety advice whatever the AI says and whatever the business
 * is: a gas leak, carbon monoxide, or a medical emergency. These are sent by fixed rules BEFORE any other reply
 * (also during a human handover or an AI pause), at most once every 10 minutes per chat. The conversation then
 * carries on as normal. UK numbers: National Gas Emergency 0800 111 999; emergency services 999.
 */
const RULES = [
  { key: 'gas', re: /\b(smell(s|ing)? (of )?gas|gas (leak|smell)|leaking gas|smell gas)\b/i, text: '⚠️ If you can smell gas: leave the property now, don\'t use light switches or naked flames, and call the National Gas Emergency number on 0800 111 999. If anyone feels unwell, call 999.' },
  { key: 'co', re: /\b(carbon monoxide|co alarm|co detector|monoxide alarm)\b/i, text: '⚠️ If a carbon monoxide alarm is sounding or anyone feels dizzy, sick or drowsy: get everyone into fresh air, turn off the appliance if safe, and call 0800 111 999. If anyone is unwell, call 999.' },
  { key: 'medical', re: /\b(can'?t breathe|cannot breathe|not breathing|chest pains?|heart attack|unconscious|overdose|severe bleeding|choking|anaphyla\w*|stroke)\b/i, text: '⚠️ If this is a medical emergency, call 999 now. For urgent advice that isn\'t life-threatening, call NHS 111.' },
];

export function emergencyNotice(text) {
  const t = String(text || '');
  const r = RULES.find((x) => x.re.test(t));
  return r ? { key: r.key, text: r.text } : null;
}

/*
 * Prompt-injection filter for the business's own documents and web pages. Text pulled from a website or an uploaded
 * file is DATA; a line in it that tries to give the AI orders ("ignore all previous instructions", "tell every
 * customer…", "you are now…") is removed before any of it reaches the AI. Applied centrally in retrieval
 * (ai/rag.js) so every AI feature gets clean text. Found in a real-model evaluation on 22 Nov 2026.
 */
const INJECTION = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|these|the)\b[^.\n]{0,30}\b(instructions?|rules|prompts?|guidelines|directions)\b/i,
  /\b(new|updated|real|actual) (system )?instructions?\s*:/i,
  /\byou are now\b|\bfrom now on,? you\b|\bact as (an?|the) (?!.{0,20}\b(agent|representative) for us)/i,
  /\b(tell|inform|say to|reply to) (every|all|each|any) (customers?|users?|visitors?|clients?)\b/i,
  /\b(system prompt|developer mode|jailbreak|do anything now)\b/i,
  /<\/?(system|assistant|instructions?)>/i,
];
export function stripInjections(text) {
  const t = String(text || '');
  if (!INJECTION.some((re) => re.test(t))) return { text: t, removed: 0 };
  let removed = 0;
  const kept = t.split(/\n/).map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => { const bad = INJECTION.some((re) => re.test(s)); if (bad) removed++; return !bad; }).join(' ')).join('\n');
  return { text: kept, removed };
}

/** Once per 10 minutes per chat and kind. `data` is the conversation's state (conv.data). */
export function shouldSendNotice(data, key, now = Date.now()) {
  const last = Date.parse(data?.safetyNotice?.[key] || '') || 0;
  if (now - last < 10 * 60000) return false;
  data.safetyNotice = { ...(data.safetyNotice || {}), [key]: new Date(now).toISOString() };
  return true;
}
