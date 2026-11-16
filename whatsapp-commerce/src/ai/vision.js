import { chatCompletion, directConfigured } from './direct.js';
import { bumpUsage } from '../tenants.js';
import { costMicro } from './direct.js';

/*
 * Photo search: a customer sends a photo of something they want ("this part", "a dress like this") and we turn it
 * into a catalogue search. Uses the shop's normal chat model (gpt-4o-mini reads images) with the same routing.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const visionConfigured = () => directConfigured();

/** → { product: bool, query: 'short search words', description: 'what it is' } */
export async function describeForSearch(tenantId, buffer, mime, { caption = '', shopAbout = '' } = {}) {
  if (!buffer?.length || buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('image too large'), { tooLarge: true });
  if (!/^image\/(jpe?g|png|webp|gif)/i.test(String(mime))) throw new Error(`unsupported image type ${mime}`);
  const res = await chatCompletion({
    temperature: 0,
    maxTokens: 150,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `A customer sent this photo to a shop${shopAbout ? ` (${shopAbout.slice(0, 200)})` : ''}${caption ? ` with the message: "${caption.slice(0, 300)}"` : ''}. If it shows a product (or part) they might want to buy, give short catalogue search words for it: type of item plus brand/model/size/colour if clearly visible. If it is not a product (a screenshot of a payment, a receipt, a document, a person, a damaged parcel...), say so. Reply with JSON only: {"product": true|false, "query": "2-6 search words", "description": "what it is, max 8 words"}` },
        { type: 'image_url', image_url: { url: `data:${String(mime).split(';')[0]};base64,${buffer.toString('base64')}` } },
      ],
    }],
  });
  bumpUsage(tenantId, 'ai_calls');
  bumpUsage(tenantId, 'ai_tokens', Number(res.usage?.total_tokens) || 0);
  bumpUsage(tenantId, 'ai_cost_micro', costMicro(res.usage));
  const raw = String(res.choices?.[0]?.message?.content || '');
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return { product: !!j.product, query: String(j.query || '').slice(0, 80).trim(), description: String(j.description || '').slice(0, 80).trim() };
  } catch { return { product: false, query: '', description: '' }; }
}
