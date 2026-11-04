export const MAX_QTY = 99;

export function addToCart(cart, item) {
  const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(Number(item.quantity) || 1)));
  const existing = cart.find((i) => i.productId === item.productId && i.variantId === item.variantId);
  if (existing) existing.quantity = Math.min(MAX_QTY, existing.quantity + qty);
  else cart.push({ productId: item.productId, variantId: item.variantId, title: item.title, price: Number(item.price) || 0, quantity: qty });
  return cart;
}

export function removeFromCart(cart, index) {
  if (index >= 0 && index < cart.length) cart.splice(index, 1);
  return cart;
}

export const subtotal = (cart) => Math.round(cart.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;

export const money = (n, symbol = '£') => `${symbol}${Number(n || 0).toFixed(2)}`;

export function formatCart(cart, symbol) {
  if (!cart.length) return 'Your cart is empty.';
  const lines = cart.map((i, n) => `${n + 1}. ${i.title} × ${i.quantity} — ${money(i.price * i.quantity, symbol)}`);
  return `${lines.join('\n')}\n\n*Subtotal: ${money(subtotal(cart), symbol)}*`;
}

export function deliveryFee(ordering, fulfilment, sub) {
  if (fulfilment !== 'delivery') return 0;
  const fee = Number(ordering.deliveryFee) || 0;
  const freeOver = Number(ordering.freeDeliveryOver) || 0;
  return freeOver > 0 && sub >= freeOver ? 0 : fee;
}
