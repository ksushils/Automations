# Shopify app embed for the chat widget

Shopify stops running storefront script tags on **1 March 2027**. After that, Shopify shops should add the chat through a
theme **app embed** – this folder. It loads exactly the same widget as the copy-paste snippet, so every feature works
the same (pop-up greeting, add to the shop's real basket, bookings, leads, continue on WhatsApp).

Shops that pasted the snippet into `theme.liquid` are not affected by the deadline. Only script tags added by apps are.

## One-time: publish the app (you, as the platform owner)

1. Create a free [Shopify Partner account](https://partners.shopify.com/) and an app: **Apps → Create app → Create app manually**.
2. Put its **Client ID** in `shopify.app.toml` (`client_id`).
3. Install the Shopify CLI (`npm install -g @shopify/cli`) and run in this folder:
   ```bash
   shopify app deploy
   ```
4. Distribution: choose **Custom distribution** for single shops (a private install link per shop), or list it on the App Store later.

The app asks for no permissions (`scopes = ""`): it only adds the script to the storefront.

## Per shop

1. Install the app on the shop (the install link from the Partner dashboard).
2. In Shopify admin: **Online Store → Themes → Customize → App embeds → AI chat assistant**, switch it on.
3. Paste the shop ID from the dashboard (**Grow → Website AI chat**: the part after `/chat-widget/`), then **Save**.
4. If the snippet was also pasted into `theme.liquid`, remove it, or the chat loads twice. The widget only starts once,
   but it's cleaner with one.
