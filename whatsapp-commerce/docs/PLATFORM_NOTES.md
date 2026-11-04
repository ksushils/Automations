# Platform notes (decisions with sources – read before changing these areas)

## Meta account model evolution (WAAC / Messaging accounts)

Source: [Meta – Account model evolution: onboarding changes](https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/onboarding/)
and [Onboard WhatsApp Business app users (Coexistence)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/).

Each phase is additive; existing integrations keep working without code changes until Phase 3.

| Phase | When | What changes | What we do |
|---|---|---|---|
| 1 | H2 2026 | `waba_id` in events now means a **Messaging account** ID. No code changes. `waac_id` not yet in message events | Nothing required. Don't treat `waba_id` as "the WABA the client sees in Business Suite" for display, support links or de-duplication |
| 2 | H1 2027 | `waac_id` starts appearing in message events | Already captured automatically into `settings.whatsapp.accountIds` (signup events + webhooks) |
| 3 | H1 2028 | All APIs targeting a phone number ID must use WAAC IDs; `messaging_account_id` required on all Messages API versions in multiple-Messaging-account setups | Plan the work in 2027. Every phone-number path goes through `senderId()` in `src/whatsapp/cloudApi.js` (and `templates.js` uses it) – switch there |

Coexistence is an explicit exception: Meta converts the existing WhatsApp Business account into a backward-compatible
Messaging account and shares it (no partner-specific Messaging account). Our coexistence flow follows that.

## Embedded Signup

v2 and v3 were retired on 15 Oct 2026; use v4 (GA since 8 Oct 2025) – not `v4-public-preview`.
v4 is selected by the **Facebook Login for Business configuration** (create a new one and select your products);
`META_CONFIG_ID` must point to that new configuration. `extras` is `{ setup: {} }` (no `version`, no `sessionInfoVersion`).

Coexistence: contacts (`smb_app_state_sync`) and history (`history`) must be synced **within 24 hours** of onboarding
or the business must re-onboard – done automatically in `activateNumber()`.

## WhatsApp pricing (since 1 Oct 2026)

Service replies are charged after 1,000 free per business number per month; rates by the **recipient's** country;
template price by **category** (UK marketing ≈ 3× utility). Estimates in `src/metaPricing.js` are approximate –
update from Meta's rate card or `META_RATES_JSON`.

## Dify licence

Dify's licence forbids operating a multi-tenant service without written permission. Default engine is Direct
(OpenAI-compatible). Dify is only usable with `DIFY_LICENSED=true`, a super-admin `difyAllowed` grant, or a shop's own Dify.
