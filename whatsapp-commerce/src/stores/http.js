export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error?.message || data.errors?.[0]?.message || data.error)) || text?.slice(0, 200);
    const err = new Error(`${method} ${new URL(url).pathname} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export const digits = (s) => String(s || '').replace(/\D/g, '');

/** True if two phone numbers plausibly match (compare last 9 digits to tolerate +44 / 0 prefixes). */
export const phonesMatch = (a, b) => {
  const A = digits(a), B = digits(b);
  return A.length >= 7 && B.length >= 7 && A.slice(-9) === B.slice(-9);
};

export function splitName(full) {
  const parts = String(full || 'WhatsApp Customer').trim().split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(' ') || '-' };
}
