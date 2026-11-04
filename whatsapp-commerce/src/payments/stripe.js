import crypto from 'node:crypto';

/** Minimal Stripe client (no SDK) – Checkout Sessions + webhook signature verification. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function createCheckoutSession({ secretKey, amount, currency, orderRef, description, successUrl, cancelUrl, metadata, phone }) {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl || successUrl,
      client_reference_id: orderRef,
      metadata,
      payment_intent_data: { metadata, description: `Order ${orderRef}` },
      phone_number_collection: { enabled: false },
      line_items: { 0: { quantity: 1, price_data: { currency: String(currency || 'gbp').toLowerCase(), unit_amount: Math.round(amount * 100), product_data: { name: `Order ${orderRef}`, description: description?.slice(0, 500) || undefined } } } },
      ...(phone ? { customer_creation: 'if_required' } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${data.error?.message || res.status}`);
  return { id: data.id, url: data.url };
}

/** Verify the Stripe-Signature header (t=…,v1=…) against the raw body. */
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
