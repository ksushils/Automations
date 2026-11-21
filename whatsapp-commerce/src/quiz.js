import { chatCompletion, directConfigured } from './ai/direct.js';
import { bumpUsage } from './tenants.js';

/*
 * Product finder quiz ("Help me choose"): 2–4 quick questions with tap answers, then recommendations – products for a
 * shop, or the right service for a salon or clinic. Guided selling converts well (Octane AI, a quiz vendor, reports
 * quiz pages at 7.1% vs 2.3% for product pages – a vendor figure).
 * settings.quiz = { enabled, intro, questions: [{ q, options: ['Me', 'A gift', …] }] }
 */
export function quizConfig(S) {
  const Q = S.quiz || {};
  const questions = (Array.isArray(Q.questions) ? Q.questions : []).map((x) => ({ q: String(x?.q || '').trim().slice(0, 120), options: (Array.isArray(x?.options) ? x.options : []).map((o) => String(o).trim().slice(0, 24)).filter(Boolean).slice(0, 10) })).filter((x) => x.q && x.options.length >= 2).slice(0, 5);
  return Q.enabled && questions.length ? { intro: String(Q.intro || "Let's find the right one for you – a few quick questions.").slice(0, 200), questions } : null;
}

/** "Question = a | b | c" lines ↔ questions. */
export const parseQuizText = (text) => String(text || '').split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2 && p[0].trim()).map((p) => ({ q: p[0].trim(), options: p.slice(1).join('=').split('|').map((o) => o.trim()).filter(Boolean) }));

/** The AI writes a quiz from what the shop sells (categories and product names, or services). */
export async function draftQuiz(tenant, { products = [], categories = [] } = {}) {
  if (!directConfigured()) throw Object.assign(new Error('The AI is not set up on this server'), { status: 400 });
  const S = tenant.settings;
  const r = await chatCompletion({ temperature: 0.3, maxTokens: 500, messages: [{ role: 'user', content: `Write a short "help me choose" quiz for ${S.business.name}, a UK business${S.ai?.about ? ` (${String(S.ai.about).slice(0, 300)})` : ''}.
${categories.length ? `Categories: ${categories.slice(0, 20).join(', ')}\n` : ''}${products.length ? `Some products: ${products.slice(0, 40).join('; ')}\n` : ''}
3 questions that best narrow down what to recommend (who it's for, budget, use or style). Each answer under 20 characters, 3-5 answers each, using only what this business sells. JSON only: {"questions":[{"q":"...","options":["...","..."]}]}` }] });
  bumpUsage(tenant.id, 'ai_calls');
  const raw = String(r.choices?.[0]?.message?.content || '');
  try { return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).questions.slice(0, 4); } catch { throw Object.assign(new Error('The AI answer could not be read – try again'), { status: 400 }); }
}
