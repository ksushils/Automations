import { createHash } from 'node:crypto';
import { getTenant, updateTenantSettings } from './tenants.js';

/*
 * Ready-made starting points for each trade (dentist, salon, takeaway…). A template gives a new business, in one tap:
 *   • the welcome menu and pop-up greeting customers of that trade expect,
 *   • the one question to ask someone who wants a call back (what matters for THIS trade),
 *   • rules for the AI that the trade needs (a dentist never diagnoses; a takeaway never promises allergen-free…),
 *   • the questions its customers ask most – used by the weekly answer check, and as hints for AI auto-setup,
 *   • bookings or ordering switched to the right mode, with typical services/times ready to edit (bookings stay off
 *     until the owner turns them on – we never offer slots a business doesn't really have).
 * The facts (prices, hours, policies) still come from the business's own website and documents.
 * Like AI auto-setup it never overwrites what the owner has changed: each part is only written when it's empty or
 * still exactly what a template/auto-setup wrote (unless forced).
 */
const sig = (v) => createHash('sha1').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 12);
const ask = (label, value) => ({ label, action: 'ask', value });
const HUMAN = { label: '🙋 Talk to a person', action: 'human' };

const SAFETY_HEALTH = 'Never diagnose, never say whether a treatment is suitable for them and never give medical advice: say a clinician will advise at an appointment. For severe pain, swelling that affects breathing or swallowing, heavy bleeding or injury, tell them to call 999 or go to A&E; out of hours, NHS 111.';

export const TRADES = {
  dental: {
    label: 'Dental clinic', emoji: '🦷', blurb: 'Fees, check-ups, hygienist, Invisalign, emergencies',
    businessType: 'services', store: 'none',
    intro: 'How can we help with your smile today?',
    greeting: '🦷 Hello! Looking for prices, an appointment or emergency help?',
    menu: [{ label: '📅 Book an appointment', action: 'book' }, ask('💷 Treatment prices', 'How much do your treatments cost? Please show me your fee guide.'), ask('🚑 Emergency dentist', 'I have dental pain – can I get an emergency appointment?'), ask('🕒 Opening hours', 'What are your opening hours?'), ask('🆕 New patients', 'Are you taking new patients and what does a first visit cost?'), ask('💳 Finance options', 'Do you offer payment plans or finance?')],
    requirement: 'What would you like help with? For example a check-up, hygienist, a treatment you\'re interested in, or pain you\'re having, and when suits you.',
    instructions: `For prices, quote the fee guide exactly with the "from" wording it uses. ${SAFETY_HEALTH} Say whether the practice is NHS or private only if the information says so.`,
    questions: ['How much is a check-up for a new patient?', 'How much is a hygienist appointment?', 'Do you do emergency appointments today?', 'Are you open on Saturdays?', 'How much is Invisalign?', 'Do you offer payment plans?', 'Are you taking NHS patients?', 'Where can I park?'],
    bookings: { services: [{ name: 'New patient check-up', minutes: 45 }, { name: 'Check-up', minutes: 30 }, { name: 'Hygienist', minutes: 30 }, { name: 'Consultation', minutes: 30 }], times: ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'], closedDays: [0], leadHours: 4 },
  },
  clinic: {
    label: 'Clinic or therapist', emoji: '🩺', blurb: 'Physio, aesthetics, chiropractor, opticians, vets',
    businessType: 'services', store: 'none',
    intro: 'How can we help today?',
    greeting: '🩺 Hello! Would you like prices, to book, or to ask about a treatment?',
    menu: [{ label: '📅 Book an appointment', action: 'book' }, ask('💷 Prices', 'How much do your treatments cost?'), ask('🩺 Treatments', 'What treatments do you offer?'), ask('🕒 Opening hours', 'What are your opening hours?'), ask('📍 Where to find us', 'Where are you and is there parking?')],
    requirement: 'What would you like help with, and when suits you for an appointment?',
    instructions: SAFETY_HEALTH,
    questions: ['How much is a first appointment?', 'Do I need a referral?', 'What are your opening hours?', 'Do you take insurance?', 'How long is a session?', 'Where can I park?'],
    bookings: { services: [{ name: 'First appointment', minutes: 60 }, { name: 'Follow-up', minutes: 30 }], times: ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], closedDays: [0], leadHours: 4 },
  },
  salon: {
    label: 'Hair, beauty or barber', emoji: '💇', blurb: 'Price list, booking, stylists, patch tests',
    businessType: 'services', store: 'none',
    intro: 'What can we do for you today?',
    greeting: '💇 Hi! Want to see prices or book your next appointment?',
    menu: [{ label: '📅 Book now', action: 'book' }, ask('💷 Price list', 'Can I see your price list?'), ask('✂️ Services', 'What services do you offer?'), ask('🕒 Opening hours', 'What are your opening hours?'), ask('🎁 Gift vouchers', 'Do you sell gift vouchers?')],
    requirement: 'Which service would you like, and is there a day or time that suits you best?',
    instructions: 'Colour, lash, brow and tint services may need a patch test 48 hours before: mention it when someone books one of these, if the information says so. Quote prices exactly as listed, including "from" prices.',
    questions: ['How much is a cut and blow dry?', 'Do I need a patch test?', 'Are you open late on Thursday?', 'Do you take walk-ins?', 'What is your cancellation policy?', 'Do you sell gift vouchers?'],
    bookings: { services: [{ name: 'Cut', minutes: 45 }, { name: 'Cut and blow dry', minutes: 60 }, { name: 'Colour', minutes: 120 }], times: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], closedDays: [0, 1], leadHours: 2 },
  },
  takeaway: {
    label: 'Takeaway or restaurant', emoji: '🍕', blurb: 'Menu, order on WhatsApp, delivery area, allergens',
    businessType: 'restaurant', store: 'manual',
    intro: 'Hungry? What can we get you?',
    greeting: '🍕 Hi! Fancy ordering? Tap Menu, or ask about delivery and allergens.',
    menu: [{ label: '🍽️ Menu and order', action: 'browse' }, ask('🛵 Delivery area', 'Do you deliver to my area and how much is delivery?'), ask('🕒 Opening hours', 'What time do you open and close today?'), ask('🌱 Allergens', 'Do you have allergen information?'), { label: '📦 My order', action: 'status' }],
    requirement: 'Is this about an order, a booking for a table, or a party or catering request? Tell us the date and how many people.',
    instructions: 'Never promise that a dish is free from an allergen or safe for an allergy: say the kitchen handles common allergens and the customer must tell staff about any allergy before ordering. Give delivery times as estimates.',
    questions: ['Do you deliver to my postcode?', 'How much is delivery?', 'What time do you close tonight?', 'Do you have vegan options?', 'Is the chicken halal?', 'Do you have allergen information?', 'Can I collect?', 'Is there a minimum order?'],
    ordering: { fulfilment: ['delivery', 'pickup'], askNote: true, slots: { enabled: true, days: 1, times: ['17:00-18:00', '18:00-19:00', '19:00-20:00', '20:00-21:00', '21:00-22:00'], leadHours: 1 } },
    categories: [{ id: 'starters', title: 'Starters' }, { id: 'mains', title: 'Mains' }, { id: 'sides', title: 'Sides' }, { id: 'desserts', title: 'Desserts' }, { id: 'drinks', title: 'Drinks' }],
  },
  shop: {
    label: 'Online shop', emoji: '🛍️', blurb: 'Products, delivery, returns, order tracking',
    businessType: 'shop', store: null,
    intro: 'What are you looking for today?',
    greeting: '🛍️ Hi! Looking for something in particular? I can help you find it.',
    menu: [{ label: '🛍️ Browse products', action: 'browse' }, { label: '📦 Track my order', action: 'status' }, ask('🚚 Delivery', 'How much is delivery and how long does it take?'), ask('↩️ Returns', 'What is your returns policy?'), ask('🎁 Offers', 'Do you have any offers or discount codes at the moment?')],
    requirement: 'What are you looking for? Tell us the product, size or budget and we\'ll help.',
    instructions: 'Only say an item is in stock when the product information says so. Under UK law most online purchases can be returned within 14 days of delivery: describe the shop\'s own returns policy, not the law, unless asked.',
    questions: ['How much is delivery?', 'How long does delivery take?', 'Where is my order?', 'What is your returns policy?', 'Do you deliver to Northern Ireland?', 'Do you have this in stock?', 'Do you have a discount code?'],
  },
  trades: {
    label: 'Trades and home services', emoji: '🔧', blurb: 'Plumbers, electricians, builders, cleaners: quotes and call-outs',
    businessType: 'services', store: 'none',
    intro: 'What do you need a hand with?',
    greeting: '🔧 Hi! Need a quote or an emergency call-out? Tell us what\'s going on.',
    menu: [{ label: '📝 Get a quote', action: 'callback' }, ask('🚨 Emergency call-out', 'I have an emergency – can you come out today?'), ask('🛠️ Services', 'What services do you offer?'), ask('📍 Areas covered', 'Which areas do you cover?'), ask('💷 Prices', 'How much do you charge? Is there a call-out fee?')],
    requirement: 'What needs doing, and where (your postcode)? Photos help: tap 📎 to send one. When would you like it done?',
    instructions: 'If someone smells gas, tell them to leave the property and call the National Gas Emergency number on 0800 111 999 straight away. For electrical danger (sparks, burning smell) tell them to switch off at the fuse box if it is safe and keep away. Never give a firm price without a visit unless the information lists a fixed price.',
    questions: ['Do you cover my area?', 'Is there a call-out fee?', 'Can you come out today?', 'Are you Gas Safe registered?', 'Do you give free quotes?', 'Are you insured?'],
  },
  travel: {
    label: 'Travel agent or tours', emoji: '✈️', blurb: 'Holidays, tours, visas, quotes, ATOL',
    businessType: 'travel', store: 'none',
    intro: 'Where would you like to go?',
    greeting: '✈️ Hi! Planning a trip? Tell us where and when, and we\'ll help.',
    menu: [{ label: '📝 Get a quote', action: 'callback' }, ask('🌍 Destinations', 'Which destinations and holidays do you offer?'), ask('🛂 Visas', 'Can you help with visas?'), ask('🛡️ Are we protected?', 'Are your holidays ATOL protected?'), ask('🕒 Opening hours', 'When are you open?')],
    requirement: 'Where would you like to go, roughly when, how many are travelling, and do you have a budget per person?',
    instructions: 'Only say a holiday is ATOL or ABTA protected when the information says so. Prices change with dates and availability: give "from" prices and offer a quote. Visa rules change: point to the official government source for the final word.',
    questions: ['Are you ATOL protected?', 'How much is a week in Dubai in May?', 'Can you help with an India visa?', 'Do you do payment plans?', 'Can I book flights only?', 'What happens if I need to cancel?'],
  },
  experiences: {
    label: 'Experiences and activities', emoji: '🎟️', blurb: 'Activity days, classes, events, gift vouchers',
    businessType: 'experiences', store: 'none',
    intro: 'Which experience are you interested in?',
    greeting: '🎟️ Hi! Looking for an experience, a date or a gift voucher?',
    menu: [{ label: '📅 Book a date', action: 'book' }, ask('🎟️ Experiences', 'What experiences do you offer and how much are they?'), ask('🎁 Gift vouchers', 'Do you sell gift vouchers and how long are they valid?'), ask('👥 Groups', 'Do you do group or corporate bookings?'), ask('🌦️ Weather & changes', 'What happens if the weather is bad or I need to change my date?')],
    requirement: 'Which experience, which date (or month), and how many people?',
    instructions: 'Mention age, height or licence requirements whenever the information gives them. Quote voucher validity and change rules exactly as written.',
    questions: ['How much is the experience?', 'How long is a gift voucher valid?', 'Can I change my date?', 'Is there an age limit?', 'Do you do group bookings?', 'What should I wear or bring?'],
    bookings: { services: [{ name: 'Experience', minutes: 120 }], times: ['09:30', '13:30'], closedDays: [], leadHours: 24 },
  },
  professional: {
    label: 'Professional services', emoji: '💼', blurb: 'Accountants, solicitors, estate agents, consultants',
    businessType: 'services', store: 'none',
    intro: 'How can we help?',
    greeting: '💼 Hello! Have a question about our services or want to arrange a call?',
    menu: [{ label: '📞 Arrange a call', action: 'callback' }, ask('🧾 Services and fees', 'What services do you offer and what are your fees?'), ask('🆓 Free consultation', 'Do you offer a free first consultation?'), ask('🕒 Opening hours', 'When are you open?'), ask('📍 Where to find us', 'Where is your office?')],
    requirement: 'Briefly, what would you like help with, and when is a good time for a call?',
    instructions: 'Never give legal, tax or financial advice for someone\'s own situation: explain what the firm can help with and offer a call with an adviser. Keep personal details to a minimum in the chat.',
    questions: ['How much do you charge?', 'Do you offer a free consultation?', 'Can you help with a tax return?', 'How quickly can you start?', 'Are you regulated?', 'Where is your office?'],
  },
  garage: {
    label: 'Garage, MOT or car service', emoji: '🚗', blurb: 'MOTs, servicing, repairs, tyres, quotes',
    businessType: 'services', store: 'none',
    intro: 'What does your car need?',
    greeting: '🚗 Hi! Need an MOT, a service or a repair quote?',
    menu: [{ label: '📅 Book MOT or service', action: 'book' }, ask('💷 Prices', 'How much is an MOT and a service?'), { label: '📝 Repair quote', action: 'callback' }, ask('🕒 Opening hours', 'What are your opening hours?'), ask('🚙 Courtesy car', 'Do you have a courtesy car or can you collect my car?')],
    requirement: 'What do you need (MOT, service, repair), your car make, model and registration, and when suits you?',
    instructions: 'The legal maximum fee for a standard car MOT in Great Britain is £54.85: never quote more than the garage\'s own MOT price. Never diagnose a fault for certain from a description: say a technician will check it. If the customer describes brakes, steering or a warning light that could be unsafe, advise them not to drive the car and to call the garage.',
    questions: ['How much is an MOT?', 'How much is a full service?', 'Can you do it today?', 'Do you have a courtesy car?', 'Can you check my car is due an MOT?', 'Do you fit tyres?'],
    bookings: { services: [{ name: 'MOT', minutes: 60 }, { name: 'Interim service', minutes: 90 }, { name: 'Full service', minutes: 180 }, { name: 'Diagnostic check', minutes: 60 }], times: ['08:30', '09:30', '10:30', '11:30', '13:30', '14:30', '15:30'], closedDays: [0], leadHours: 12 },
  },
  property: {
    label: 'Estate or letting agent', emoji: '🏠', blurb: 'Viewings, valuations, tenant repairs, property questions',
    businessType: 'services', store: 'none',
    intro: 'Buying, selling, renting or letting?',
    greeting: '🏠 Hi! Looking for a property, a valuation, or reporting a repair?',
    menu: [{ label: '🏡 Book a valuation', action: 'callback' }, ask('🔑 To rent', 'What properties do you have to rent?'), ask('🏷️ For sale', 'What properties do you have for sale?'), { label: '🛠️ Report a repair', action: 'ticket' }, ask('💷 Fees', 'What are your fees for landlords and sellers?')],
    requirement: 'Are you buying, selling, renting or letting – which area, your budget, and when suits you for a call or viewing?',
    instructions: 'Never promise a property is still available or that an offer will be accepted. Tenant fees: in England most fees to tenants are banned (Tenant Fees Act 2019) – only describe fees the agent\'s information lists. For gas leaks, flooding or no heat in winter, tell tenants to call the emergency number in the agent\'s information straight away.',
    questions: ['Can I book a viewing?', 'How much is a valuation?', 'What are your letting fees?', 'Is the flat still available?', 'How do I report a repair?', 'Do you accept pets?'],
    tickets: true,
  },
  fitness: {
    label: 'Gym, studio or classes', emoji: '🏋️', blurb: 'Class times, trial passes, memberships',
    businessType: 'services', store: 'none',
    intro: 'Ready to get moving?',
    greeting: '🏋️ Hi! Want class times, a free trial or membership prices?',
    menu: [{ label: '📅 Book a class or trial', action: 'book' }, ask('🗓️ Timetable', 'What is the class timetable?'), ask('💷 Memberships', 'How much is membership?'), ask('🆓 Free trial', 'Do you offer a free trial or day pass?'), ask('🕒 Opening hours', 'What are your opening hours?')],
    requirement: 'What are you interested in (classes, gym, personal training), and when suits you to come in?',
    instructions: 'Never give medical or injury advice: suggest they check with a GP first if they mention a health condition or pregnancy. Quote membership prices and contract terms exactly as written, including any joining fee.',
    questions: ['How much is membership?', 'Do you have a free trial?', 'What time is yoga?', 'Is there a contract?', 'Do you have parking?', 'Can I cancel my membership?'],
    bookings: { services: [{ name: 'Free trial session', minutes: 60 }, { name: 'Personal training taster', minutes: 45 }], times: ['07:00', '09:00', '12:00', '17:30', '18:30'], closedDays: [], leadHours: 4 },
  },
  education: {
    label: 'Tutor, nursery or school', emoji: '🎓', blurb: 'Admissions, trial lessons, fees, term dates',
    businessType: 'services', store: 'none',
    intro: 'How can we help your family?',
    greeting: '🎓 Hello! Asking about places, fees or a trial lesson?',
    menu: [{ label: '📅 Book a visit or trial', action: 'book' }, ask('💷 Fees', 'What are your fees?'), ask('📋 Places & admissions', 'Do you have places available and how do I apply?'), ask('🗓️ Term dates', 'What are your term dates and hours?'), { label: '📞 Call me back', action: 'callback' }],
    requirement: "Who is it for (child's age or year group), what are you looking for, and when suits you for a call or visit?",
    instructions: "Keep personal details about children to a minimum in the chat – a first name and age is enough. Mention funded hours or funding only as the information describes them; never promise a place.",
    questions: ['Do you have places for a 3 year old?', 'How much are your fees?', 'Do you take funded hours?', 'Can we come for a visit?', 'What are your term dates?', 'Do you offer a trial lesson?'],
    bookings: { services: [{ name: 'Visit or tour', minutes: 45 }, { name: 'Trial lesson', minutes: 60 }], times: ['09:30', '11:00', '14:00', '16:00'], closedDays: [0, 6], leadHours: 24 },
  },
  hospitality: {
    label: 'Hotel, B&B or holiday let', emoji: '🛏️', blurb: 'Availability, rooms, check-in, local tips',
    businessType: 'services', store: 'none',
    intro: 'Planning a stay?',
    greeting: '🛏️ Hi! Checking dates, rooms or how to find us?',
    menu: [{ label: '📅 Check availability', action: 'callback' }, ask('🛏️ Rooms and prices', 'What rooms do you have and how much are they?'), ask('🕒 Check-in and out', 'What time are check-in and check-out?'), ask('🚗 Parking & directions', 'Is there parking and how do I find you?'), ask('🐶 Dogs and children', 'Are dogs and children welcome?')],
    requirement: 'Which dates, how many guests (adults and children), and any special requests?',
    instructions: 'Never confirm a room is available or take a booking in the chat unless the booking system does it: offer to check, or point to the online booking link in the information. Quote cancellation terms exactly as written.',
    questions: ['Do you have a room this weekend?', 'What time is check-in?', 'Is breakfast included?', 'Is there parking?', 'Are dogs allowed?', 'What is your cancellation policy?'],
  },
  it_support: {
    label: 'IT support or software', emoji: '💻', blurb: 'Troubleshooting, tickets, account help',
    businessType: 'services', store: 'none',
    intro: "What's not working?",
    greeting: "💻 Hi! Something not working? Tell me what's happening and I'll help.",
    menu: [{ label: '🛠️ Something broken', action: 'ask', value: "Something isn't working – can you help me fix it?" }, { label: '🎫 Open a ticket', action: 'ticket' }, ask('📦 Services & prices', 'What services do you offer and what do they cost?'), ask('🔐 Password / account', 'I need help with my password or account'), ask('🕒 Support hours', 'What are your support hours?')],
    requirement: "What's the problem, which device or system, and the best way to reach you?",
    instructions: 'Troubleshoot one step at a time and wait for the answer before the next step (e.g. "Is the light on the router green or red?"). Only suggest safe steps a customer can do themselves: restarting, checking cables, signing out and in. Never ask for passwords, two-factor codes or card details. If it is not fixed after a couple of steps, offer to open a ticket.',
    questions: ['My internet is not working', 'I forgot my password', 'My email is not syncing', 'How much is monthly support?', 'Can someone come on site?', 'What are your support hours?'],
    tickets: true,
  },
  venue: {
    label: 'Wedding or event venue', emoji: '💍', blurb: 'Date availability, packages, brochure, viewings',
    businessType: 'services', store: 'none',
    intro: 'Planning something special?',
    greeting: '💍 Congratulations! Checking a date, packages or booking a viewing?',
    menu: [{ label: '📅 Book a viewing', action: 'book' }, { label: '📩 Get the brochure', action: 'callback' }, ask('💷 Packages & prices', 'What packages do you offer and how much are they?'), ask('📆 Date availability', 'Is my date available?'), ask('🍽️ Catering & capacity', 'How many guests can you hold and what catering do you offer?')],
    requirement: 'What is the occasion, your preferred date (or season), roughly how many guests, and your budget?',
    instructions: 'Never confirm a date is free: say the team will check the diary. Quote package prices and what is included exactly as written, including any minimum numbers or seasonal prices.',
    questions: ['Is our date available?', 'How much is a wedding package?', 'How many guests can you hold?', 'Can we bring our own caterer?', 'Can we come and look round?', 'Do you have accommodation?'],
    bookings: { services: [{ name: 'Venue viewing', minutes: 60 }], times: ['11:00', '14:00', '16:00'], closedDays: [], leadHours: 48 },
  },
};

// ---------- specialist versions of the two launch verticals: UK home-service trades, and hair & beauty ----------
// Each builds on its parent template (trades / salon) and adds what that trade's customers ask and what the AI must
// never say. Facts (prices, areas, hours, registrations) still come only from the business's own information.
const GAS = 'If someone smells gas or thinks there is a gas leak, tell them to leave the property, not to use switches or flames, and call the National Gas Emergency number on 0800 111 999 straight away.';
const CO = 'If a carbon monoxide alarm is going off or someone feels dizzy, sick or drowsy near a boiler or fire, tell them to get into fresh air and call 0800 111 999 (and 999 if anyone is unwell).';
const ELEC = 'For electrical danger (sparks, burning smell, shocks, water near electrics) tell them to switch off at the consumer unit (fuse box) only if it is safe to reach, keep away, and call 105 if there is a power cut or damage to the supply.';
const NO_PRICE = 'Never give a firm price without seeing the job unless the information lists a fixed price; you may share listed call-out fees and hourly rates exactly as written. Never say a photo shows the cause of a fault – say an engineer will confirm.';
const REG = (body) => `Only say the business is ${body} if the information says so.`;
const variant = (parent, o) => ({ ...TRADES[parent], parent, ...o });
Object.assign(TRADES, {
  plumber: variant('trades', {
    label: 'Plumber', emoji: '🚿', blurb: 'Leaks, blocked drains, bathrooms, call-outs',
    greeting: '🚿 Hi! Got a leak or need a plumber? Tell us what\'s happening – a photo helps.',
    menu: [{ label: '🚨 Emergency leak', action: 'callback' }, { label: '📝 Get a quote', action: 'quote' }, ask('📍 Areas covered', 'Which areas do you cover?'), ask('💷 Call-out fee', 'Is there a call-out fee and what is your hourly rate?'), ask('🛁 Bathroom fitting', 'Do you fit bathrooms?')],
    requirement: 'What\'s the problem, and what\'s your postcode? A photo helps – tap 📎 to send one.',
    instructions: `For an active leak, suggest turning off the water at the stopcock if they can do it safely. ${GAS} ${NO_PRICE}`,
    questions: ['Is there a call-out fee?', 'Can you come out today for a leak?', 'Do you unblock drains?', 'Do you cover my area?', 'Do you fit bathrooms?', 'Are you insured?'],
  }),
  electrician: variant('trades', {
    label: 'Electrician', emoji: '💡', blurb: 'Faults, rewires, EV chargers, EICR certificates',
    greeting: '💡 Hi! Need an electrician? Tell us what\'s going on and your postcode.',
    menu: [{ label: '⚡ Fault or power loss', action: 'callback' }, { label: '📝 Get a quote', action: 'quote' }, ask('📋 EICR certificates', 'Do you do EICR certificates for landlords?'), ask('🔌 EV charger', 'Do you install EV chargers?'), ask('📍 Areas covered', 'Which areas do you cover?')],
    requirement: 'What do you need doing, and what\'s your postcode? A photo of the fuse box or fault helps.',
    instructions: `${ELEC} ${REG('NICEIC, NAPIT or Part P registered')} ${NO_PRICE}`,
    questions: ['Can you do an EICR for my rental?', 'Do you install EV chargers?', 'My power keeps tripping – can you come?', 'Are you NICEIC registered?', 'How much is a rewire?', 'Do you cover my area?'],
  }),
  heating: variant('trades', {
    label: 'Heating engineer (gas, boilers)', emoji: '🔥', blurb: 'Boiler repairs, servicing, installs, landlord gas certificates',
    greeting: '🔥 Hi! Boiler trouble, a service or a new boiler? Tell us what you need.',
    menu: [{ label: '🚨 No heating/hot water', action: 'callback' }, { label: '🛠️ Boiler service', action: 'book' }, { label: '📝 New boiler quote', action: 'quote' }, ask('📋 Gas safety (CP12)', 'Do you do landlord gas safety certificates (CP12)?'), ask('📍 Areas covered', 'Which areas do you cover?')],
    requirement: 'What\'s happening with your heating or boiler (make and model if you know it), and your postcode?',
    instructions: `${GAS} ${CO} Gas work must only be done by a Gas Safe registered engineer: never suggest the customer opens or repairs a gas appliance. ${REG('Gas Safe registered')} ${NO_PRICE}`,
    questions: ['How much is a boiler service?', 'My boiler is showing an error code – can you help?', 'Do you do landlord gas certificates?', 'Are you Gas Safe registered?', 'Do you offer finance on new boilers?', 'Can you come today? I have no hot water.'],
    bookings: { services: [{ name: 'Boiler service', minutes: 60 }, { name: 'Gas safety check (CP12)', minutes: 45 }], times: ['08:00', '10:00', '12:00', '14:00', '16:00'], closedDays: [0], leadHours: 24 },
  }),
  handyman: variant('trades', {
    label: 'Handyman', emoji: '🧰', blurb: 'Odd jobs, flat-pack, shelves, small repairs',
    greeting: '🧰 Hi! What odd jobs can we help with? Send a photo if it helps.',
    menu: [{ label: '📝 Get a quote', action: 'quote' }, ask('🛠️ Jobs we do', 'What kind of jobs do you do?'), ask('💷 Prices', 'Do you charge by the hour or by the job?'), ask('📍 Areas covered', 'Which areas do you cover?')],
    requirement: 'What jobs need doing, and what\'s your postcode? A photo or two helps.',
    instructions: `Gas and most electrical work needs a registered engineer: only say the business does it if the information says so. ${ELEC} ${NO_PRICE}`,
    questions: ['Do you charge by the hour?', 'Can you build flat-pack furniture?', 'Do you have a minimum charge?', 'Can you put up shelves and TVs?', 'Do you cover my area?'],
  }),
  property_maintenance: variant('trades', {
    label: 'Property maintenance', emoji: '🏢', blurb: 'Repairs for landlords, agents and tenants, planned maintenance',
    greeting: '🏢 Hi! Report a repair or ask about maintenance for your property.',
    menu: [{ label: '🛠️ Report a repair', action: 'ticket' }, { label: '🚨 Urgent repair', action: 'callback' }, { label: '📝 Get a quote', action: 'quote' }, ask('🏠 Landlord contracts', 'Do you offer maintenance contracts for landlords and letting agents?')],
    requirement: 'What needs repairing, the property address or postcode, and how we can arrange access?',
    instructions: `For tenants, ask who manages the property (landlord or agent) – don't promise work is approved until the landlord or agent confirms. ${GAS} ${ELEC} ${NO_PRICE}`,
    questions: ['How do I report a repair?', 'Do you work with letting agents?', 'How quickly can you attend an urgent repair?', 'Do you offer planned maintenance contracts?', 'Who pays for the repair?'],
    tickets: true,
  }),
  hair: variant('salon', {
    label: 'Hair salon', emoji: '💇‍♀️', blurb: 'Cuts, colour, stylists, patch tests',
    greeting: '💇‍♀️ Hi! See our prices or book your next cut or colour?',
    requirement: 'Which service would you like (and a stylist, if you have one in mind), and when suits you?',
    instructions: 'Colour services usually need a skin (patch) test at least 48 hours before: mention it when someone books colour, if the information says so. New colour clients may need a consultation first. Quote prices exactly as listed, including "from" prices and stylist levels.',
    questions: ['How much is a cut and blow dry?', 'Do I need a patch test for colour?', 'Can I choose my stylist?', 'How long does balayage take?', 'What is your cancellation policy?', 'Do you take deposits?'],
    bookings: { services: [{ name: 'Cut and finish', minutes: 60 }, { name: 'Colour (roots)', minutes: 90 }, { name: 'Full colour', minutes: 120 }, { name: 'Blow dry', minutes: 45 }], times: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], closedDays: [0, 1], leadHours: 2 },
  }),
  barber: variant('salon', {
    label: 'Barber', emoji: '💈', blurb: 'Cuts, fades, beard trims, walk-ins',
    greeting: '💈 Alright! Book a cut, or ask about walk-ins and prices.',
    menu: [{ label: '📅 Book a cut', action: 'book' }, ask('💷 Prices', 'What are your prices?'), ask('🚶 Walk-ins', 'Do you take walk-ins? How busy are you?'), ask('🕒 Opening hours', 'What are your opening hours?')],
    requirement: 'Which cut would you like, and when suits you?',
    instructions: 'Only say how busy the shop is right now if the information gives live waiting times – otherwise say walk-ins are welcome when the information says so. Quote prices exactly as listed.',
    questions: ['Do you take walk-ins?', 'How much is a skin fade?', 'Do you do beard trims?', 'Do you cut kids\' hair?', 'Are you open on Sunday?'],
    bookings: { services: [{ name: 'Haircut', minutes: 30 }, { name: 'Skin fade', minutes: 40 }, { name: 'Beard trim', minutes: 15 }, { name: 'Cut and beard', minutes: 45 }], times: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'], closedDays: [0], leadHours: 1 },
  }),
  beauty: variant('salon', {
    label: 'Beauty salon', emoji: '💅', blurb: 'Facials, lashes, brows, waxing, treatments',
    greeting: '💖 Hi! Browse treatments, prices or book your appointment.',
    requirement: 'Which treatment would you like, and when suits you?',
    instructions: `Lash, brow tint and some skin treatments need a patch test 24–48 hours before: mention it when someone books one, if the information says so. Never say whether a treatment is safe for them (pregnancy, skin conditions, medication, allergies): say the therapist will check at a consultation. ${'Quote prices exactly as listed.'}`,
    questions: ['Do I need a patch test for lash extensions?', 'How much is a facial?', 'Can I have treatments while pregnant?', 'How long do lash extensions last?', 'Do you sell gift vouchers?'],
    bookings: { services: [{ name: 'Facial', minutes: 60 }, { name: 'Lash extensions', minutes: 90 }, { name: 'Brow shape and tint', minutes: 30 }, { name: 'Waxing', minutes: 30 }], times: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'], closedDays: [0], leadHours: 4 },
  }),
  nails: variant('salon', {
    label: 'Nail salon', emoji: '💅', blurb: 'Gel, acrylics, infills, manicures, pedicures',
    greeting: '💅 Hi! Book your nails or see our price list.',
    requirement: 'Which nail service would you like (and do you need a removal first), and when suits you?',
    instructions: 'Ask whether they need an existing gel or acrylic removing, as it changes the appointment time, if the information mentions removals. For allergies or nail infections, say the technician will check first. Quote prices exactly as listed.',
    questions: ['How much is a gel manicure?', 'Do you do acrylic infills?', 'Do you charge for removal?', 'How long does a full set take?', 'Do you take walk-ins?'],
    bookings: { services: [{ name: 'Gel manicure', minutes: 45 }, { name: 'Acrylic full set', minutes: 90 }, { name: 'Infills', minutes: 60 }, { name: 'Pedicure', minutes: 60 }], times: ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:30', '17:30'], closedDays: [0], leadHours: 2 },
  }),
});

export const TRADE_KEYS = Object.keys(TRADES);

/** The public list for the sign-up page and dashboard (no internal fields). */
export const tradeList = () => TRADE_KEYS.map((k) => ({ key: k, label: TRADES[k].label, emoji: TRADES[k].emoji, blurb: TRADES[k].blurb, ...(TRADES[k].parent ? { parent: TRADES[k].parent } : {}) }));

/** Menu options valid for this shop: browse/status only with products. ("book" without bookings switched on links to
 * the shop's booking page, and "callback" starts the call-back request.) */
const menuFor = (T, { hasShop }) => T.menu.filter((o) => hasShop || (o.action !== 'browse' && o.action !== 'status'));

/** The settings patch for a trade (pure; exported for tests). */
export function tradeSettings(key, S = {}) {
  const T = TRADES[key];
  if (!T) return null;
  const type = S.store?.type || 'manual';
  const connected = ['shopify', 'shopify_public', 'woocommerce', 'custom'].includes(type);
  const storeType = T.store === null || connected ? type : T.store;
  const hasShop = storeType !== 'none' && (connected || storeType === 'manual'); // the built-in catalogue counts too (it didn't for the "Online shop" template)
  const menu = menuFor(T, { hasShop });
  const patch = {
    trade: key,
    welcomeMenu: { enabled: true, intro: T.intro, options: [...menu.slice(0, 7), HUMAN] },
    webchat: { opener: { text: T.greeting } },
    leads: { requirementPrompt: T.requirement },
    ai: { tradeRules: T.instructions },
    quality: { tradeQuestions: T.questions },
  };
  if (storeType !== type) patch.store = { type: storeType };
  if (T.bookings && !(S.bookings?.services || []).length) patch.bookings = { enabled: false, days: 14, perSlot: 1, autoConfirm: false, reminderHours: 24, secondReminderHours: 2, ...T.bookings };
  if (T.ordering) patch.ordering = T.ordering;
  if (T.tickets) patch.tickets = { enabled: true, replyHours: S.tickets?.replyHours || 8 };
  if (T.categories && storeType === 'manual' && !(S.store?.manual?.products || []).length) patch.store = { ...(patch.store || {}), manual: { categories: T.categories, products: [] } };
  return patch;
}

/** Apply a trade template to a shop. Parts the owner changed are kept unless forced. Returns what was applied. */
export function applyTrade(tenantId, key, { force = false } = {}) {
  const t = getTenant(tenantId);
  if (!t || !TRADES[key]) return null;
  const S = t.settings;
  const p = tradeSettings(key, S);
  const before = S.autoSetup?.sigs || {};
  const mine = (k, current) => force || current == null || current === '' || (Array.isArray(current) && !current.length) || before[k] === sig(current);
  const patch = { trade: key, ai: p.ai, quality: p.quality }, applied = ['AI rules for the trade', 'questions to check'], sigs = { ...before };
  if (mine('welcomeMenu', S.welcomeMenu?.options?.length ? S.welcomeMenu : null)) { patch.welcomeMenu = p.welcomeMenu; sigs.welcomeMenu = sig(p.welcomeMenu); applied.push('welcome menu'); }
  if (mine('greeting', S.webchat?.opener?.text || null)) { patch.webchat = p.webchat; sigs.greeting = sig(p.webchat.opener.text); applied.push('pop-up greeting'); }
  if (mine('requirementQuestion', S.leads?.requirementPrompt || null)) { patch.leads = p.leads; sigs.requirementQuestion = sig(p.leads.requirementPrompt); applied.push('lead question'); }
  if (p.store) { patch.store = p.store; applied.push(p.store.type === 'none' ? 'enquiries and bookings mode' : 'menu categories'); }
  if (p.bookings) { patch.bookings = p.bookings; applied.push('typical services and times (bookings stay off until you turn them on)'); }
  if (p.ordering) { patch.ordering = p.ordering; applied.push('delivery, collection and time slots'); }
  if (p.tickets && !S.tickets?.enabled) { patch.tickets = p.tickets; applied.push('support tickets'); }
  patch.autoSetup = { ...(S.autoSetup || {}), sigs };
  updateTenantSettings(tenantId, patch);
  return { trade: key, label: TRADES[key].label, applied };
}

/** A best guess at the trade from what auto-setup saw (the AI's answer, else the business name and pages). */
export function guessTrade(text) {
  const s = String(text || '').toLowerCase();
  const rules = [['it_support', /\b(it support|it services|managed services|msp|tech support|computer repair|software|saas|helpdesk)\b/], ['garage', /\bgarage|\bmot\b|car service|auto(motive)? (repair|centre)|tyres?\b|motors\b/], ['property', /estate agent|letting|lettings|property management|properties\b/], ['fitness', /\bgym\b|fitness|pilates|yoga|crossfit|personal train/], ['education', /nursery|tutor|tuition|school|academy|driving school|preschool/], ['hospitality', /\bhotel|b&b|bed and breakfast|guest ?house|holiday (let|cottage)|\binn\b|lodge\b/], ['venue', /wedding venue|event venue|banqueting|function room|venue\b/], ['dental', /\bdent(al|ist|istry)|orthodont|invisalign/], ['clinic', /physio|chiropract|osteopath|aesthetic|botox|optician|veterinar|\bvets?\b|clinic|therap/], ['barber', /barber/], ['nails', /\bnails?\b|manicure|pedicure/], ['hair', /hair ?(salon|dresser|stylist)|hairdress|\bhair\b/], ['beauty', /beauty|lash|brow|wax(ing)?\b|facials?\b|spa\b/], ['salon', /salon/], ['takeaway', /takeaway|restaurant|pizza|kebab|curry|cafe|café|grill|kitchen|food|burger|sushi|bakery/], ['travel', /travel|holiday|tours?\b|visa|flights?|cruise/], ['heating', /boiler|heating engineer|gas engineer|central heating|gas safe/], ['plumber', /plumb/], ['electrician', /electric/], ['property_maintenance', /property maintenance|maintenance (services|company)|facilities management/], ['handyman', /handyman|odd jobs/], ['trades', /builder|roof|locksmith|clean(ing|ers)|gardener|decorat/], ['experiences', /experience|activity|activities|escape room|driving day|track day|workshop|classes/], ['professional', /accountan|solicitor|law(yer)?\b|estate agent|letting|consult|bookkeep|mortgage/]];
  for (const [k, re] of rules) if (re.test(s)) return k;
  return null;
}
