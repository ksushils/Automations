import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTenant, tenants } from './helpers.js';
import { getDb } from '../src/db.js';
import { createQuote, getQuote, chatPhotos } from '../src/quotes.js';

test('photos the customer sent in the chat are attached to their quote request (website and WhatsApp)', async () => {
  const t = makeTenant({ quotes: { enabled: true } });
  const d = getDb();
  const web = 'web:photoQuoteSessionABCD1234';
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'file', ?)").run(t.id, web, JSON.stringify({ type: 'file', text: '📎 [photo: tap.jpg] – a chrome kitchen mixer tap with water pooling at the base', fileUrl: 'https://wa.example/chat-files/x/abc.jpg', mime: 'image/jpeg' }));
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'file', ?)").run(t.id, web, JSON.stringify({ type: 'file', text: '📎 [PDF: invoice.pdf]', fileUrl: 'https://wa.example/chat-files/x/inv.pdf', mime: 'application/pdf' }));
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body, created_at) VALUES (?, ?, 'in', 'file', ?, datetime('now', '-5 days'))").run(t.id, web, JSON.stringify({ type: 'file', text: 'old', fileUrl: 'https://wa.example/old.jpg', mime: 'image/jpeg' }));
  const photos = chatPhotos(t.id, web);
  assert.equal(photos.length, 1, 'only recent photos – not PDFs, not last week');
  assert.equal(photos[0].url, 'https://wa.example/chat-files/x/abc.jpg');
  assert.equal(photos[0].hint, 'a chrome kitchen mixer tap with water pooling at the base');
  const { quote } = await createQuote(tenants.getTenant(t.id), { waId: web, name: 'Pat', request: 'Please quote to replace this leaking tap' });
  assert.equal(getQuote(t.id, quote.number).photos.length, 1);
  assert.equal(quote.status, 'draft', 'the team approves before anything is sent');
  const wa = '447700900801';
  d.prepare("INSERT INTO messages (tenant_id, wa_id, direction, type, body) VALUES (?, ?, 'in', 'image', ?)").run(t.id, wa, JSON.stringify({ mediaId: 'MEDIA123', caption: 'damp patch on ceiling' }));
  const q2 = (await createQuote(tenants.getTenant(t.id), { waId: wa, request: 'Can you fix this damp?' })).quote;
  assert.deepEqual(getQuote(t.id, q2.number).photos.map((p) => [p.url, p.mediaId, p.hint]), [[null, 'MEDIA123', 'damp patch on ceiling']]);
  const other = makeTenant();
  assert.deepEqual(chatPhotos(other.id, web), [], "another business never sees this chat's photos");
});
