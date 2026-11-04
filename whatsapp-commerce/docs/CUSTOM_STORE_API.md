# Custom store API (for non-Shopify, non-WooCommerce sites on your VPS)

Set **Store type = custom** and point **Custom VPS store API base URL** at your site, e.g.
`https://shop.example.com/api/whatsapp`. Every request carries `Authorization: Bearer <Custom store API key>`; reject anything else.
All responses are JSON. Prices are numbers in major units (e.g. `12.99`).

| Method | Path | Returns |
|---|---|---|
| GET | `/products?q=<text>&limit=10` | `Product[]` (empty `q` = featured/newest) |
| GET | `/products/<id>` | `Product` or 404 |
| GET | `/categories` | `[{ "id": "shoes", "title": "Shoes" }]` |
| GET | `/categories/<id>/products?limit=10` | `Product[]` |
| POST | `/orders` | `{ "id": "1001", "name": "#1001", "total": 42.5, "currency": "GBP", "checkoutUrl": "https://…/pay/1001" }` |
| GET | `/orders/<ref>?phone=<digits>` | `{ "name": "#1001", "status": "shipped", "payment": "paid", "tracking": [{ "company": "Royal Mail", "number": "AB123", "url": "https://…" }] }` or 404. **Only return the order if `phone` matches the order's phone.** |

```jsonc
// Product
{
  "id": "123", "title": "Running Shoe", "price": 59.99, "currency": "GBP",
  "description": "Short plain-text description", "image": "https://…/shoe.jpg", "url": "https://…/p/123",
  "available": true,
  "variants": [ { "id": "123-42", "title": "UK 8", "price": 59.99, "available": true } ] // optional
}

// POST /orders body (sent by this system)
{
  "items": [ { "productId": "123", "variantId": "123-42", "title": "Running Shoe (UK 8)", "price": 59.99, "quantity": 1 } ],
  "customer": { "name": "Jane Doe", "phone": "447700900123", "email": "", "address": "1 High St, London SW1A 1AA" },
  "paymentMethod": "payment_link",   // or "cod" | "bank_transfer"
  "fulfilment": "delivery",          // or "pickup"
  "shippingFee": 3.5,
  "note": ""
}
```

Return `checkoutUrl` for `payment_link` orders: a page where the customer pays for that order (Stripe Checkout,
PayPal, your existing checkout…). Send order-status changes back to the **store webhook URL** shown in the dashboard:

```http
POST https://wa.example.com/webhooks/store/<tenantId>/<secret>
{ "orderId": "1001", "status": "shipped", "paid": true }
```

Statuses: `new, confirmed, preparing, ready, shipped, delivered, completed, cancelled`. The customer gets a WhatsApp update.
