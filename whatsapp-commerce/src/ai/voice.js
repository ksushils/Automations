import { config } from '../config.js';
import { bumpUsage } from '../tenants.js';
import { costMicro } from './direct.js';

/*
 * Voice notes → text, so the assistant can answer them like a typed message.
 * WhatsApp voice notes are OGG/Opus. OpenRouter passes audio to models that accept it (Gemini takes OGG directly),
 * so this uses its own model + provider list (AI_AUDIO_MODEL / AI_AUDIO_PROVIDERS), still with data_collection: deny.
 */
const FORMAT = { 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/amr': 'amr' };
// Strict on purpose: with a looser prompt the model invented whole customer messages for a plain tone or a broken file.
const PROMPT = 'You are a speech-to-text engine. Transcribe the human speech in this audio verbatim, in the spoken language. Rules: never guess or invent words; if the audio has no clear human speech (silence, tones, music, noise, unreadable audio) reply with exactly NO_SPEECH. Output only the transcript or NO_SPEECH.';
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;

export const voiceConfigured = () => !!(config.aiApiKey && config.aiAudioModel);

export function audioFormat(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return FORMAT[base] || null;
}

/** Transcribe one voice note. Returns the transcript ('' when nothing was said). Throws on API errors. */
export async function transcribe(tenantId, buffer, mime) {
  const format = audioFormat(mime);
  if (!format) throw new Error(`unsupported audio type ${mime}`);
  if (!buffer?.length) throw new Error('empty audio');
  if (buffer.length > MAX_VOICE_BYTES) throw Object.assign(new Error('voice note too long'), { tooLong: true });
  const openrouter = /openrouter\.ai/.test(config.aiBaseUrl);
  const provider = openrouter ? { data_collection: 'deny', ...(config.aiAudioProviders.length ? { order: config.aiAudioProviders, allow_fallbacks: false } : {}) } : undefined;
  const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.aiApiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': config.publicUrl, 'X-Title': config.productName },
    body: JSON.stringify({
      model: config.aiAudioModel,
      temperature: 0,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } },
        ],
      }],
      ...(provider ? { provider } : {}),
      ...(openrouter ? { usage: { include: true } } : {}),
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`voice AI ${res.status}: ${data.error?.message || 'error'}`), { status: res.status });
  bumpUsage(tenantId, 'ai_calls');
  bumpUsage(tenantId, 'ai_tokens', Number(data.usage?.total_tokens) || 0);
  bumpUsage(tenantId, 'ai_cost_micro', costMicro(data.usage));
  const out = String(data.choices?.[0]?.message?.content || '').replace(/^["“]|["”]$/g, '').trim();
  return /^\W*NO_SPEECH\W*$/i.test(out) || !out ? '' : out.replace(/\s*NO_SPEECH\s*/gi, ' ').trim().slice(0, 2000);
}
