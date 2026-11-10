/*
 * Honest comparison pages ("Wati alternative" etc.). Every competitor fact here comes from that company's own
 * website, read on CHECKED_ON, and links to the page it came from. Re-check before relying on prices: they change.
 * Rule from the copy deck: say plainly where the competitor is better, then where we differ.
 */
export const CHECKED_ON = '10 November 2026';

export const COMPARISONS = [
  {
    slug: 'wati-alternative',
    name: 'Wati',
    pricingUrl: 'https://www.wati.io/pricing',
    title: (b) => `Wati alternative for UK small businesses | ${b}`,
    description: 'An honest comparison of Wati and a done-for-you WhatsApp assistant for UK shops: where Wati is better, where we differ, and who should pick which.',
    intro: 'Wati is one of the most established WhatsApp Business platforms. It is a good product, and for some businesses it is the right choice. Here is where it is stronger, where we are different, and how to decide.',
    better: [
      'More mature and much bigger: Wati says it has 16,000+ customers in 190+ countries and over 100 integrations.',
      'Longer support hours: 24x7 email and chat support from its Pro plan up, per its pricing page.',
      'A 7-day free trial you can start yourself, with no credit card.',
      'No set-up fee. If you are happy to set it up yourself, it costs less to get started.',
      'A wider toolkit for marketing teams: CRM integrations such as HubSpot and Salesforce on higher plans.',
    ],
    different: [
      'We set it up for you. We load your products, prices, policies and opening hours, write your templates and test it with you. Wati sells onboarding as a paid add-on on monthly plans (included with annual plans).',
      'Built for ordering, not just broadcasting: the assistant takes the order, checks delivery areas and slots, and handles cash on delivery or payment links, as well as Shopify and WooCommerce.',
      'Meta bills you directly for WhatsApp messages, at Meta\'s rates. We don\'t sit between you and that bill.',
      'Monthly plans with no annual commitment needed for the headline price.',
      'UK consent records for marketing (PECR) are built in, along with a data processing agreement.',
    ],
    rows: [
      ['Starting price shown', 'Growth £49 a month, billed annually (Pro £99, Business £229)', 'Starter £29 a month, billed monthly, plus set-up from £500'],
      ['Set-up', 'Self-serve; dedicated onboarding is a paid add-on (included on annual plans)', 'Done for you, included in the set-up fee'],
      ['Free trial', '7 days, self-serve', 'The website assistant on your own site before you pay monthly'],
      ['AI assistant', 'AI agents included, with monthly AI credits; more credits £23 a month', '300 / 3,000 / 20,000 AI replies a month by plan'],
      ['WhatsApp message fees', 'Billed per message; varies by country and template type', 'Billed by Meta directly to your own Meta account'],
      ['Ordering', 'Catalogue, Shopify abandoned cart and order templates (Shopify add-on mentioned)', 'Full ordering in chat: basket, delivery areas, slots, cash on delivery, payment links'],
      ['Support', 'From 24x5 email (Growth) to 24x7 chat with dedicated CSMs (Business)', 'Email; same-day phone on Managed'],
    ],
    pickThem: 'You have someone who will learn the platform and run campaigns, you want lots of integrations, or you are outside the UK.',
    pickUs: 'You want it working without learning a dashboard, you take orders by message, and you would rather pay once for set-up than spend your evenings on it.',
    faq: [
      ['Can I move from Wati to you?', 'In most cases, yes. Meta lets a WhatsApp number move between providers. We help with the switch as part of set-up, and your customers keep messaging the same number.'],
      ['Is Wati cheaper?', 'To get started, yes: Wati has no set-up fee and you set it up yourself. Month to month, our Starter plan is lower than Wati\'s Growth plan, but we charge for set-up because we do the work.'],
    ],
  },
  {
    slug: 'interakt-alternative',
    name: 'Interakt',
    pricingUrl: 'https://www.interakt.shop/pricing',
    title: (b) => `Interakt alternative for UK small businesses | ${b}`,
    description: 'An honest comparison of Interakt and a done-for-you WhatsApp assistant for UK shops: where Interakt is better, where we differ, and who should pick which.',
    intro: 'Interakt is a popular WhatsApp platform with strong Shopify features, and pricing built around the Indian market. Here is where it is stronger, where we are different, and how to decide.',
    better: [
      'A deep Shopify toolkit: order updates, abandoned checkout reminders, win-back messages and cash-on-delivery-to-prepaid flows.',
      'WhatsApp Pay and payment links from the inbox, which matter a lot in India.',
      'Unlimited agents on its plans, so a big team costs no more.',
      'A self-serve free trial with no credit card needed.',
      'Lower monthly prices: Growth is listed at $55 a month plus taxes.',
    ],
    different: [
      'Built for the UK. Prices in pounds, UK delivery areas and postcodes, and UK consent records for marketing (PECR).',
      'We set it up for you, and test it against real questions before it goes live.',
      'AI replies are included in every plan. Interakt lists its AI agents as an add-on at $74.99 a month on Growth and Advanced.',
      'Meta bills you directly for WhatsApp messages. Interakt\'s pricing page lists "No Templates Markups" as a feature of its top tier.',
      'One price list, in pounds. Interakt\'s prices are in dollars and rupees, with message prices shown for Indian numbers.',
    ],
    rows: [
      ['Starting price shown', 'Growth $55 a month plus taxes (Advanced $69); Enterprise on request', 'Starter £29 a month, plus set-up from £500'],
      ['Set-up', 'Self-serve, with assisted onboarding on some plans', 'Done for you, included in the set-up fee'],
      ['AI assistant', 'AI agents as an add-on ($74.99 a month on Growth and Advanced)', 'Included: 300 / 3,000 / 20,000 AI replies a month'],
      ['WhatsApp message fees', 'Charged by template type; "No Templates Markups" listed on the top tier', 'Billed by Meta directly to your own Meta account'],
      ['Currency and market', 'USD and INR; message prices shown for Indian numbers', 'GBP; built for UK businesses'],
      ['Shopify', 'Deep: orders, abandoned checkouts, win-back, COD-to-prepaid', 'Orders, abandoned checkouts and order updates; also WooCommerce and your own product list'],
      ['Team members', 'Unlimited agents', 'Team logins for staff on every plan'],
    ],
    pickThem: 'You sell mainly in India, you run a large Shopify store with a team, or you need WhatsApp Pay.',
    pickUs: 'You are a UK business, you want the assistant set up and tested for you, and you want AI replies and pricing in pounds without add-ons.',
    faq: [
      ['Does Interakt work in the UK?', 'Yes, it works with UK numbers. Its pricing and much of its product are built around the Indian market, so check the message prices for UK customers on its site.'],
      ['Can I keep my WhatsApp number if I switch?', 'In most cases, yes. Meta lets a WhatsApp number move between providers, and we help with the move as part of set-up.'],
    ],
  },
  {
    slug: 'aisensy-alternative',
    name: 'AiSensy',
    pricingUrl: 'https://aisensy.com/pricing',
    title: (b) => `AiSensy alternative for UK small businesses | ${b}`,
    description: 'An honest comparison of AiSensy and a done-for-you WhatsApp assistant for UK shops: where AiSensy is better, where we differ, and who should pick which.',
    intro: 'AiSensy is a fast-growing WhatsApp marketing platform from India, with a free plan and free onboarding. Here is where it is stronger, where we are different, and how to decide.',
    better: [
      'A Free Forever plan, plus free onboarding with its team and no set-up fee.',
      'Very large: AiSensy says it is trusted by 250,000+ businesses in 68+ countries.',
      'An official WhatsApp Business Solution Provider, and it says it is SOC 2 compliant and ISO 27001 certified.',
      'Strong for broadcast marketing campaigns, which is what it is built around.',
      'Support on WhatsApp, live chat, email, phone and Zoom.',
    ],
    different: [
      'Built for ordering, not broadcasting: the assistant answers questions and takes the whole order in the chat.',
      'AI replies are included in every plan. AiSensy sells its AI Agent Builder and chatbot builder as add-ons on top of any plan.',
      'Built for the UK: prices in pounds, UK delivery areas and postcodes, and UK consent records for marketing (PECR). AiSensy\'s main price list is in rupees for India.',
      'We set it up and write it for you, and test it against your real customer questions before it goes live.',
      'Works with WooCommerce and your own product list as well as Shopify.',
    ],
    rows: [
      ['Starting price shown', 'Free Forever plan; paid plans priced in rupees (separate dollar price list)', 'Starter £29 a month, plus set-up from £500'],
      ['Set-up', 'Self-serve, with free onboarding from its team', 'Done for you, included in the set-up fee'],
      ['AI assistant', 'AI Agent Builder add-on (₹1,350 a month with 1,000 AI messages); chatbot builder add-on', 'Included: 300 / 3,000 / 20,000 AI replies a month'],
      ['WhatsApp message fees', 'Prepaid conversation credits, charged at Meta\'s rates', 'Billed by Meta directly to your own Meta account'],
      ['Currency and market', 'INR for India, with a separate USD price list', 'GBP; built for UK businesses'],
      ['Ordering', 'Catalogue and cart on WhatsApp, Shopify chatbot, payments via WhatsApp Pay, Razorpay and others', 'Full ordering in chat with delivery areas and slots; Shopify, WooCommerce or your own product list'],
    ],
    pickThem: 'You want to start free, your main need is broadcast marketing, or you sell mainly in India.',
    pickUs: 'You are a UK business that takes orders by message, and you want it set up, written and tested for you, with AI included.',
    faq: [
      ['Is AiSensy free?', 'AiSensy has a Free Forever plan. WhatsApp messages are still charged at Meta\'s rates, and add-ons such as the AI Agent Builder cost extra.'],
      ['Can I switch from AiSensy and keep my number?', 'In most cases, yes. Meta lets a WhatsApp number move between providers, and we help with the move as part of set-up.'],
    ],
  },
];

export const comparison = (slug) => COMPARISONS.find((c) => c.slug === slug);
