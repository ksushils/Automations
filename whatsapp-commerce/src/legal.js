import { config } from './config.js';

/*
 * TEMPLATE legal pages for selling this SaaS in the UK. They are starting points only –
 * have a solicitor review and adapt them before you rely on them. Fill in LEGAL_* env vars.
 */
const env = process.env;
const L = () => ({
  company: env.LEGAL_COMPANY_NAME || '[Your Company Ltd]',
  number: env.LEGAL_COMPANY_NUMBER || '[company number]',
  address: env.LEGAL_ADDRESS || '[registered address]',
  email: env.LEGAL_CONTACT_EMAIL || '[contact email]',
  product: env.PRODUCT_NAME || 'WhatsApp Commerce',
  url: config.publicUrl,
  draft: !env.LEGAL_COMPANY_NAME,
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const PAGES = {
  terms: (l) => ['Terms of Service', `
<p>These terms govern your use of ${esc(l.product)} (the "Service") provided by ${esc(l.company)} (company no. ${esc(l.number)}, ${esc(l.address)}) ("we", "us").</p>
<h2>1. The Service</h2><p>The Service lets businesses ("you") sell to and message customers on WhatsApp, connect online stores and use AI assistants. WhatsApp is provided by Meta Platforms; your use of WhatsApp is also subject to the WhatsApp Business Terms and Commerce Policy. Meta's per-conversation charges are billed to you by Meta unless agreed otherwise.</p>
<h2>2. Your account</h2><p>Keep your admin keys secret. You are responsible for activity under your account and for the content you send. You must only message people who have opted in, honour opt-outs, and comply with applicable law including UK GDPR, PECR and consumer law.</p>
<h2>3. Fees, trials and cancellation</h2><p>Paid plans are billed monthly in advance via Stripe. Free trials convert to the chosen plan unless cancelled before the trial ends. You can cancel at any time from the Billing page; access continues until the end of the paid period. Fees are non-refundable except where required by law.</p>
<h2>4. Acceptable use</h2><p>No spam, unlawful, misleading or harmful content, no restricted goods under the WhatsApp Commerce Policy, and no attempts to break or overload the Service.</p>
<h2>5. AI features</h2><p>AI replies are generated automatically and may be inaccurate. You are responsible for reviewing your product data, prompts and policies, and for orders taken through the Service.</p>
<h2>6. Data</h2><p>You remain the controller of your customers' personal data; we process it as your processor under our <a href="/legal/dpa">Data Processing Agreement</a>. See our <a href="/legal/privacy">Privacy Policy</a>.</p>
<h2>7. Availability and liability</h2><p>We aim for high availability but the Service is provided "as is". To the extent permitted by law our total liability in any 12 months is limited to the fees you paid in that period, and we are not liable for indirect or consequential loss, lost profits or lost data. Nothing limits liability that cannot be limited by law.</p>
<h2>8. Suspension and termination</h2><p>We may suspend accounts that breach these terms, Meta policies or fail to pay. On termination you can export your data for 30 days, after which it is deleted.</p>
<h2>9. Changes and law</h2><p>We may update these terms with 30 days' notice for material changes. These terms are governed by the laws of England and Wales.</p>
<p>Contact: ${esc(l.email)}</p>`],
  privacy: (l) => ['Privacy Policy', `
<p>${esc(l.company)} ("we") operates ${esc(l.product)}. This policy explains how we handle personal data.</p>
<h2>Business customers (our clients)</h2><p>We collect your name, email, business details, billing information (processed by Stripe) and usage data to provide and bill the Service, under contract and legitimate interests. We keep it for the life of your account plus 6 years for tax records.</p>
<h2>Your customers (shoppers who message you)</h2><p>When shoppers message a business that uses our Service, we process their WhatsApp number, name, messages, orders, delivery address and preferences <b>on behalf of that business</b>, which is the controller. Questions about that data should go to the business; we help them respond.</p>
<h2>Sub-processors</h2><p>Meta Platforms (WhatsApp Cloud API), Stripe (payments), our hosting provider, and AI model providers configured in our AI platform (e.g. OpenAI or OpenRouter) for generating replies. Some may process data outside the UK under appropriate safeguards (UK IDTA / adequacy).</p>
<h2>Retention</h2><p>Chat transcripts – including earlier WhatsApp Business app conversations a business imports when it connects its number – and media are kept for the business's configured period (default 24 months) and deleted on request. Contacts imported from the WhatsApp Business app are never treated as having agreed to marketing; they must opt in separately. The activity log keeps IP addresses for 90 days and entries for 24 months. Payment-proof images are kept only as long as needed to confirm payment. Records of marketing consent and opt-outs are kept for 6 years after the last contact – even if the rest of a person's data is erased – so that we can prove consent and honour opt-outs.</p>
<h2>Security</h2><p>Credentials are encrypted at rest (AES-256-GCM), webhooks are signature-verified and access is key-based with role separation.</p>
<h2>Your rights</h2><p>You can request access, correction, deletion, restriction or portability, and object to processing, by contacting ${esc(l.email)}. You can complain to the ICO (ico.org.uk).</p>`],
  dpa: (l) => ['Data Processing Agreement', `
<p>This DPA forms part of the Terms between the business using ${esc(l.product)} ("Controller") and ${esc(l.company)} ("Processor") and reflects Article 28 UK GDPR.</p>
<h2>1. Subject matter</h2><p>Processing of shoppers' personal data (WhatsApp number, name, messages, order, address, marketing preferences) to provide WhatsApp commerce, messaging, AI assistance and analytics, for the duration of the Terms.</p>
<h2>2. Processor obligations</h2><ul><li>Process only on the Controller's documented instructions (configuring and using the Service).</li><li>Ensure staff are bound by confidentiality.</li><li>Implement appropriate technical and organisational measures (encryption of credentials, access control, backups, logging).</li><li>Engage sub-processors only as listed in the Privacy Policy, with equivalent obligations, and give notice of changes.</li><li>Assist with data-subject requests and DPIAs.</li><li>Notify personal data breaches without undue delay (target 48 hours).</li><li>Delete or return data at the end of the service (export available for 30 days).</li><li>Make available information needed to demonstrate compliance.</li></ul>
<h2>2a. Historical conversations</h2><p>Where the Controller connects a number already used with the WhatsApp Business app ("coexistence"), the Controller instructs the Processor to import and process that number's existing contacts and up to 180 days of message history, under the same terms, retention and deletion rules as other conversation data. Imported contacts are not treated as having given marketing consent.</p>
<h2>3. Controller obligations</h2><p>The Controller is responsible for a lawful basis, opt-ins for marketing messages, privacy notices to shoppers and the accuracy of instructions.</p>
<h2>4. International transfers</h2><p>Where data leaves the UK, transfers rely on adequacy regulations or the UK International Data Transfer Agreement / Addendum.</p>`],
};

export function renderLegal(name) {
  const page = PAGES[name];
  if (!page) return null;
  const l = L();
  const [title, body] = page(l);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${esc(l.product)}</title>
<style>:root{--bg:#f5f7f6;--ink:#17201b;--mute:#5d6b63}@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--ink:#e7efe9;--mute:#9aaba1}}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px}h2{font-size:18px;margin-top:24px}a{color:inherit}.d{border:1px dashed #b5470b;padding:8px 12px;border-radius:8px;color:#b5470b}</style></head>
<body><main><h1>${title}</h1>${l.draft ? '<p class="d">Draft template – the operator has not completed these terms yet.</p>' : ''}${body}<p style="color:var(--mute)">Last updated: ${new Date().toISOString().slice(0, 7)}</p></main></body></html>`;
}
