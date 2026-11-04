process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.SUPER_ADMIN_KEY = 'super-admin-test-key';
process.env.PUBLIC_URL = 'http://localhost:0';
const { initDb } = await import('../src/db.js');
initDb(':memory:');
export const tenants = await import('../src/tenants.js');
export const engine = await import('../src/bot/engine.js');
export const cloud = await import('../src/whatsapp/cloudApi.js');

export function makeTenant(overrides = {}) {
  const { tenant } = tenants.createTenant({ name: 'Test Shop', plan: 'pro' });
  tenants.updateTenantSettings(tenant.id, {
    store: {
      type: 'manual',
      manual: {
        categories: [{ id: 'tees', title: 'T-shirts' }, { id: 'mugs', title: 'Mugs' }],
        products: [
          { id: 'tee', title: 'Classic Tee', price: 15, category: 'tees', description: 'Organic cotton', variants: [{ id: 'tee-s', title: 'Small', price: 15 }, { id: 'tee-l', title: 'Large', price: 16 }] },
          { id: 'mug', title: 'White Mug', price: 8.5, category: 'mugs', description: 'Ceramic mug' },
        ],
      },
    },
    ordering: { paymentMethods: ['cod', 'bank_transfer'], fulfilment: ['delivery', 'pickup'], deliveryFee: 3.5, freeDeliveryOver: 50, bankDetails: 'Sort 00-00-00 Acc 12345678' },
  });
  return tenants.updateTenantSettings(tenant.id, overrides); // deep-merged on top of the defaults
}

/** Run one inbound event through the engine and return the replies. */
export async function say(tenant, waId, input) {
  const sent = [];
  const ev = typeof input === 'string' ? { waId, kind: 'text', text: input, profileName: 'Jane Doe' } : { waId, kind: 'action', id: input.action };
  await engine.handleInbound(tenants.getTenant(tenant.id), ev, async (to, m) => { if (to === waId) sent.push(m); });
  return sent;
}

export const ids = (msgs) => msgs.flatMap((m) => (m.buttons || []).map((b) => b.id).concat((m.sections || []).flatMap((s) => s.rows.map((r) => r.id))));
