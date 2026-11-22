# Adding Instagram Direct + Facebook Messenger to a WhatsApp Cloud API assistant

> **Status:** research only – nothing built yet (roadmap R5). Compiled on 22 November 2026 from Meta's developer documentation, with sources inline.
> **Checked against Meta's own changelog** (https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog):
> - Messenger tags CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE and POST_PURCHASE_UPDATE return error 100 from 27 April 2026 (entry of 27 March 2026).
> - The Instagram Handover Protocol was replaced by Conversation Routing on 23 October 2025.
> Other claims are as the sources linked say; Meta's docs move often, so re-check before building.
>
> **Short version:**
> - **Messaging cost:** Messenger and Instagram messaging is free; there's no per-message fee like WhatsApp's.
> - **Sign-up delay:** we need Meta's App Review (Advanced Access) for the messaging permissions, plus Business Verification for the Human Agent feature. Allow 2–4 weeks.
> - **Login:** the recommended route is "Unified Login" via Facebook Login for Business. It uses the same business-owned token model as our WhatsApp embedded signup, and no Facebook Page is needed for Instagram.
> - **Reply window:** 24 hours from the customer's last message. The 7-day HUMAN_AGENT tag is for staff replies only, never the AI.
> - **What we'd build:** a new webhook shape (`entry[].messaging[]`), media that arrives as expiring links (download it straight away), and text fallbacks where buttons don't show (Instagram desktop). Also Conversation Routing, so the assistant and the business's phone inbox don't reply over each other.


Researched 22 Nov 2026. Primary source: Meta for Developers. Note that Meta moved its business-messaging docs from `developers.facebook.com/docs/...` to `developers.facebook.com/documentation/...` in 2025–26. Many `/docs/` pages still load, but some now render empty (for example the old message-tags page), and the two trees sometimes disagree. Where they conflict, prefer the `/documentation/` pages and the changelogs.

Key changelogs:
- Messenger: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog
- Docs index: https://developers.facebook.com/documentation/business-messaging/messenger-platform/llms.txt

---

## 1. Which API to use, and account requirements

### Instagram: there are now four setups
Source for all four: https://developers.facebook.com/documentation/instagram-platform and https://developers.facebook.com/documentation/instagram-platform/overview.md

**Instagram API with Unified Login** (new, and what Meta now recommends)
- Meta calls it "the recommended setup for new integrations".
- New Instagram API features ship only for this setup: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login
- The client logs in with either Instagram or Facebook credentials. Authorisation goes through **Facebook Login for Business**, using a configuration that produces a login URL.
- The token is a **Business Integration System User (BISU) access token**. It belongs to the client's business portfolio, not to the person who logged in, so it survives staff leaving.
- Uses `graph.facebook.com`.
- **No Facebook Page needed. A business portfolio is required.**
- This is the same token model as WhatsApp Embedded Signup, so it is very likely the best fit for our existing single Meta app (inference, not confirmed by Meta).

**Instagram API with Instagram Login** ("Business Login for Instagram", launched July 2024)
- Launch post: https://developers.facebook.com/blog/post/2024/07/30/instagram-api-with-instagram-login/
- Uses an Instagram User token on `graph.instagram.com`.
- No Page needed.
- Permissions are the `instagram_business_*` family.
- Meta now labels it for "existing Instagram Login integrations".

**Instagram API with Facebook Login**
- Requires a linked Facebook Page.
- Meta labels it legacy, for "existing Page-linked integrations".

**Instagram Messaging via the Messenger Platform**
- Requires an IG Business or Creator account **linked to a Facebook Page**.
- Uses a Page token.
- Lets Messenger and Instagram share one code path.
- Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages.md

**Account requirements (Instagram)**
- An Instagram **professional account**, either Business or Creator: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- The account must turn on **Connected Tools → Allow Access to Messages**, otherwise the API cannot manage its messages: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started
- An app can use Facebook Login **or** Instagram Login for the Instagram product, **not both**: https://developers.facebook.com/documentation/instagram-platform/app-review

### Messenger
Source for this section: https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview
- Use the Messenger Platform **Send API** (`POST /{PAGE_ID}/messages` with a Page access token).
- Requires a Meta app with the Messenger use case and a **Facebook Page**.
- The user must start the conversation.
- A Facebook user cannot message an IG account through the platform, and vice versa. Each user gets a Page-scoped ID (PSID) or an Instagram-scoped ID (IGSID).

---

## 2. Permissions, App Review, Business Verification

| Use | Permissions | Source |
|---|---|---|
| Messenger | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `business_management` (a dependency of `pages_messaging`, `pages_show_list` and `instagram_manage_messages`). The user also needs the Page tasks MESSAGING and MODERATE. | https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview |
| IG via Messenger Platform / Unified Login | the above plus `instagram_basic` and `instagram_manage_messages` (Unified Login webhooks need `instagram_manage_messages`) | same page; https://developers.facebook.com/documentation/instagram-platform/webhooks/fields |
| IG via Instagram Login | `instagram_business_basic`, `instagram_business_manage_messages` | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api |
| 7-day human replies | the **Human Agent** feature (`human_agent`) | https://developers.facebook.com/documentation/development/features-reference/human-agent |

**Advanced Access and App Review**
- Every permission above needs **Advanced Access, and so App Review**, once we serve businesses we don't own (that is, as a Tech Provider).
- Standard Access only covers people with a role on the app or Page.
- Sources: https://developers.facebook.com/documentation/instagram-platform/app-review and https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview

**Business Verification**
- Required when people without an app role use the app.
- Required for production webhooks.
- Required for Human Agent.
- Sources: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup and https://developers.facebook.com/documentation/development/features-reference/human-agent
- Our WhatsApp Tech Provider setup has probably already done this.

**Review submission requirements**
- One screencast per permission, showing the end-to-end flow, with the UI in English.
- At least one successful API call before requesting some permissions.
- Source: https://developers.facebook.com/documentation/instagram-platform/app-review
- For Messenger: the Page must be published and the webhook must return 200 within 20 s. Give reviewers test access (credentials or a trigger phrase).
- Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review.md

**How long review takes**
- Meta's FAQ only says it "may take up to several weeks". Business Verification takes "a few days": https://developers.facebook.com/documentation/resp-plat-initiatives/appreview/FAQs
- Developer reports in 2026 mention 13+ days for exactly `instagram_business_basic` + `instagram_business_manage_messages`: https://developers.facebook.com/community/threads/3459359287566790/
- A vendor reports about 20 days in 2026 (secondary source): https://bundle.social/blog/meta-app-review-20-days
- **Plan for 2–4 weeks, plus resubmissions.**

---

## 3. Messaging window, tags, automation, rate limits

**Standard window**
- 24 h from the user's last message or action.
- Up to **7 days** after a Click-to-Messenger or Click-to-Direct ad.
- Promotional content is allowed inside the window.
- Source: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview

**Human Agent tag**
- Gives 7 days after the user's last message.
- Must be a manual reply by a person, used when an issue can't be resolved within 24 h.
- Needs the Human Agent feature (App Review + Business Verification).
- Works on both Messenger and Instagram.
- Source: https://developers.facebook.com/documentation/development/features-reference/human-agent
- **Do not let the AI send replies with this tag.** The page says "manually". It doesn't explicitly ban automation, but that is the clear intent.

**Other message tags (2026 change)**
- `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` **have returned error 100 since 27 Apr 2026**.
- Replacements are Utility Templates or the Marketing Messages API.
- Sources: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog and https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages.md
- An older FAQ still says 12 Jan 2026. That is out of date: https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/faq
- **For our purposes, only HUMAN_AGENT remains useful.** Tags may never carry promotional content.
- Some tags are Messenger-only. One-Time Notifications and News Messaging are not available on Instagram.

**Recurring Notifications**
- Discontinued 10 Feb 2026, **except in AU, EU, JP, KR and the UK**: https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/faq

**Automated and AI replies**
- Allowed. Replies can be "automated, handled by a live agent, or both": https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview

**Bot disclosure**
- Where the law requires it, disclose at the start of a conversation, after a long gap, and when switching from human to bot. The policy gives "I am an automated chatbot" as an example wording.
- Meta recommends doing this everywhere. It calls out California and Germany.
- Bots must respond within 30 s.
- Source: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
- **For the UK, disclose anyway** (best practice, plus UK consumer-law and transparency expectations; not a Meta-stated UK rule).

**Rate limits**
Main source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting.md
- Messenger Send API: 300 calls/s for text, links, reactions and stickers; 10 calls/s for audio and video, per Page.
- Messenger daily limit: 200 × engaged users per rolling 24 h.
- Instagram Send API: 300 calls/s for text and 10 calls/s for audio and video, per IG account.
- The Instagram Platform overview says **100 calls/s** for text instead. **The docs conflict, so design for 100.** Source: https://developers.facebook.com/docs/instagram-platform/overview
- Conversations API: 2 calls/s. Private replies: 750/h on posts.
- If an account exceeds 72,000 messages sent plus received, the Inbox stops showing messages and sending is blocked.

---

## 4. Pricing

- "The Messenger Platform is free to use". There is no per-message fee for replies to user-started conversations. This covers IG messaging through the platform too: https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview
- No Instagram Login doc mentions a per-message fee (no explicit "free" statement found).
- **Paid exception: Marketing Messages on Messenger.** Billed per delivered message on the Meta ads bill. **Not offered to tech-provider-served businesses in the UK or EU**: https://developers.facebook.com/documentation/business-messaging/messenger-platform/marketing-messages-on-messenger/faq
- **Utility templates:** the July 2025 launch post listed only PH, TH, US and VN, and gave no pricing: https://developers.facebook.com/blog/post/2025/07/29/simplify-customer-updates-with-utility-messages-on-messenger/

---

## 5. Webhooks

**Messenger**
- Subscribe the Page with `POST /{PAGE_ID}/subscribed_apps`.
- Fields: `messages`, `messaging_postbacks`, `message_echoes`, `message_reads`, `message_deliveries`, `message_reactions`, `messaging_referrals`, `messaging_handovers`, `standby`, `message_edits`.
- Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events.md

**Instagram**
- Fields: `messages` (echoes arrive here, with `is_echo:true`), `messaging_postbacks`, `messaging_seen`, `message_reactions`, `messaging_referral`, `messaging_optins` (Instagram Login only), `messaging_handover`, `standby`, `comments`, `mentions`.
- Source: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
- A `message_edit` subscription was added in Sept 2025: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog

**How you subscribe depends on the setup**
- Instagram Login: `POST graph.instagram.com/{IG_ID}/subscribed_apps`
- Unified Login: `graph.facebook.com` with the BISU token
- Facebook Login: the Page's `/subscribed_apps` endpoint
- The app must be **Live**. Fields are app-wide, not per account.
- Source: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup

**Payload shape compared with WhatsApp**
- WhatsApp sends `object:"whatsapp_business_account"`, then `entry[].changes[].value.messages[]`.
- Messenger and IG use `object:"page"` or `object:"instagram"`, then `entry[].messaging[]`, each item holding `sender.id`, `recipient.id`, `timestamp` and `message{mid,text,attachments[],reply_to,is_echo}`.
- `entry.messaging` holds one event.
- Sources: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples and https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events.md

**Media**
- Arrives as `attachments[{type:"image"|"audio"|"video"|..., payload:{url}}]`.
- These are **CDN URLs, not media IDs as on WhatsApp**, and they expire. Download immediately.
- Voice notes arrive as `audio`. `image` also covers GIFs and stickers.
- Sources: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples and https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview

**Story replies and mentions**
- A story reply arrives as `message.reply_to.story{url,id}`.
- A story mention arrives as an attachment of type `story_mention`.
- Source: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
- With Instagram Login, mentions in posts and comments come through `comments`. Unified and Facebook Login have a separate `mentions` field: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields

**Shared posts**
- The legacy `share` attachment is being replaced by `ig_post`, rolling out gradually from 27 Apr 2026: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog

---

## 6. Supported message types

**Instagram**
Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Text up to 1000 bytes.
- Images (png/jpg, 8 MB, up to 10 per message).
- Audio, video and PDF up to 25 MB. PDF was added Dec 2025.
- `like_heart` sticker, reactions, replies via `reply_to`, and sharing your own posts.

**Instagram quick replies**
- Up to 13, **plain text only** (no phone or email quick replies).
- **Not shown on desktop.**
- Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies

**Instagram generic template**
- Up to 10 elements, 3 buttons each, `web_url` or `postback` buttons only.
- No desktop support.
- No separate button template documented.
- Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template

**Instagram ice breakers**
- Up to 4, can be localised.
- Not on desktop.
- Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers

**Instagram persistent menu**
- URL and postback buttons. Meta suggests 5 or fewer.
- No `composer_input_disabled`, no per-user menus.
- Updates are not real-time.
- Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/persistent-menu

**Messenger**
- Text, images (multiple per message since Mar 2025), audio, video and files.
- Quick replies: up to 13 (title 20 chars), types text, `user_phone_number` and `user_email`: https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies.md
- Generic, button, media, receipt and product templates.
- Ice breakers (up to 4) through `/me/messenger_profile`: https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api/ice-breakers.md
- Persistent menu.
- Sender actions (typing, mark seen). These also work on IG since Sep 2025: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog

**UK and EEA restrictions on Messenger** (since Dec 2020; still applied as of the last update, Oct 2023)
- Account linking, the Extensions SDK, the airline template, video in the media template, and the webhook `source` field remain unavailable.
- Persistent menu, media, sender actions and reactions were restored in 2021–22.
- Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform/europe-japan-updates

---

## 7. Handover and coexistence with the Business Suite inbox

**What changed**
- **The Handover Protocol is retired.** Instagram was moved to **Conversation Routing** in Oct 2025, and the routing page now says handover is no longer supported in general.
- Conversation Routing is "backwards compatible with most Handover Protocol APIs".
- Sources: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog and https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing.md

**How Conversation Routing works**
Source for this list: https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing.md
- The business picks a **default app** in Page settings. When a thread is idle, only the default app can send.
- The app that owns a thread can **pass**, **release** or **extend** control (up to 7 days).
- Another app can **take** control only if the thread is idle or it is the primary receiver. Request is default-app only.
- Ownership changes trigger the `messaging_handovers` webhook.
- Apps that don't own the thread receive events on `standby` and should not reply.
- Business Suite inbox target IDs: Page Inbox `263902037430900`, Instagram Inbox `1217981644879628`.
- If a human replies from the inbox, or moves the chat to the Main folder, **the inbox takes control**.
- **Without routing configured, every connected app receives webhooks and can reply.** So a human replying from their phone alongside our bot works, but nothing stops the two from talking over each other.
- The Conversations API now has an `is_owner` field when routing is on: https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog

**What we'd do**
- Make our app the default app. Pause the AI whenever a `standby` or human echo arrives (an `is_echo` message our app didn't send). Release control when the AI finishes.

**Related limits**
- Messages sent through the API aren't marked as read in the Instagram app until a reply is sent.
- Requests-folder threads inactive for 30 days aren't returned by the API.
- Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api

---

## 8. Practical gotchas

- **Connected tools toggle** off → the API can't message (error 36103 = messaging not yet available): https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started
- **Personal Instagram accounts don't work.** The business must switch to Business or Creator first.
- **Page tasks:** the user who connects must hold MESSAGING and MODERATE on the Page: https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview
- **Token expiry:** Instagram Login and Facebook User tokens are short-lived (1 h). Long-lived tokens last **60 days** and must be refreshed by cron: https://developers.facebook.com/docs/instagram-platform/overview. Unified Login BISU tokens are tied to the business portfolio and survive staff changes (lifetime not stated).
- **One login type per app** for the Instagram product: https://developers.facebook.com/documentation/instagram-platform/app-review
- **Media URLs expire.** Download on receipt. Outbound media you share must be owned by the account.
- **No group threads.** Each conversation is 1:1.
- **Desktop Instagram** doesn't render quick replies, templates or ice breakers. Always send a text fallback.
- **Webhook replay:** respond 200 fast (within 20 s for review). Each `entry.messaging` holds one event, but an `entry[]` array can batch several.
- **UK/EEA:** see the Messenger feature gaps in section 6; marketing messages aren't available through tech providers; Recurring Notifications still work in the UK.
- **Volume cap:** the 72k-message inbox lock (section 3) can hit busy accounts.
- **Review friction:** both apps and reviewers need a working test IG professional account and Page, and the screencasts must show the AI reply flow.

---

## What we'd need to build

1. Add **Messenger** and **Instagram** products/use cases to the existing Meta app. Choose **Unified Login** (matches the BISU + Facebook Login for Business setup we already use for WhatsApp) or Instagram Login. Confirm the existing embedded-signup configuration can include the IG and Page assets.
2. **Connect flow** in the dashboard: Facebook Login for Business config with `pages_*`, `instagram_*` and `business_management`. Store the Page ID / IG account ID and the token per tenant. Add a token-refresh job if we use 60-day tokens.
3. **Subscribe each Page / IG account** (`subscribed_apps`) on connect. Set the app as default app under Conversation Routing (or document the steps for the merchant).
4. **Webhook adapter:** parse `object: page|instagram` → `entry[].messaging[]` into our existing internal message model, alongside WhatsApp's `changes[].value`. Handle echoes, reactions, postbacks, story replies and mentions, `ig_post`, edits, and `standby`/`messaging_handovers`.
5. **Media pipeline:** download CDN URLs immediately, route `audio` to the existing voice-note transcription, and send outbound media by URL or attachment ID.
6. **Send adapter:** Send API with `messaging_type: RESPONSE`, a 24 h window tracker per thread, a 7-day HUMAN_AGENT path only for staff-typed replies, and per-channel capability mapping (quick replies, templates, text fallback for IG desktop).
7. **Human takeover:** pause the AI on human echo or standby, release thread control, and show an "AI paused" state in our UI.
8. **Bot disclosure** message at the start of a conversation, after a long gap, and on handback from human to AI.
9. **Rate limiting** per Page / IG account (design for 100/s text and 10/s media) plus retries.
10. **App Review package:** privacy policy, data deletion URL, a screencast per permission, test accounts, and a Human Agent request. Allow 2–4+ weeks.

---

## Not verified / uncertain

- **Unified Login details:** the token lifetime, the exact permission list, whether it reuses the WhatsApp embedded-signup configuration, and its launch date. All undocumented on the pages read.
- **IG Send API limit:** 100/s or 300/s (the docs conflict).
- **Story mention payload:** the exact `story_mention` payload beyond `type` + `payload.url` (inferred from the attachment pattern).
- **Human Agent tag and AI drafting:** whether an AI-drafted reply that a human approves counts as "manual".
- **Utility templates:** whether they are now available in the UK, and their price (the 2025 post listed only PH, TH, US and VN).
- **Instagram pricing:** no explicit "free" statement in the Instagram Login docs; Messenger Platform free status assumed to cover IG.
- **Handover for Messenger:** the routing page says handover is unsupported, but the changelog only states this for Instagram (Oct 2025). Messenger may still accept legacy calls.
- **UK/EEA restriction list:** last updated Oct 2023, so it may be stale.
- **App Review timelines:** no current official SLA.
- **Connected-tools menu path:** varies by Instagram app version.
- **Docs migration:** some `/docs/` URLs (for example the message-tags reference) no longer render, so tag details were taken from the changelog and the Send API overview.
